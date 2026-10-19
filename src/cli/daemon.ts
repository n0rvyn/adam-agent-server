import { fork } from "child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, openSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { PACKAGE_ROOT } from "../lib/package-root.js";

const ADAM_DIR = join(homedir(), ".adam");
const PID_FILE = join(ADAM_DIR, "adam.pid");
const PORT_FILE = join(ADAM_DIR, "adam.port");
const LOG_FILE = join(ADAM_DIR, "server.log");

function ensureAdamDir(): void {
  if (!existsSync(ADAM_DIR)) {
    mkdirSync(ADAM_DIR, { recursive: true });
  }
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  return isNaN(pid) ? null : pid;
}

function readPort(): number | null {
  if (!existsSync(PORT_FILE)) return null;
  const port = parseInt(readFileSync(PORT_FILE, "utf-8").trim(), 10);
  return isNaN(port) ? null : port;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  port: number | null;
}

export async function startDaemon(): Promise<{ pid: number; port: number }> {
  ensureAdamDir();

  const existingPid = readPid();
  if (existingPid && isProcessRunning(existingPid)) {
    throw new Error(`Server already running (PID ${existingPid})`);
  }

  // Clean up stale files
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  if (existsSync(PORT_FILE)) unlinkSync(PORT_FILE);

  // Fork server in detached mode, redirect stdout/stderr to log file
  const logFd = openSync(LOG_FILE, "a");
  const serverPath = join(PACKAGE_ROOT, "dist/index.js");
  const child = fork(serverPath, [], {
    detached: true,
    stdio: ["ignore", logFd, logFd, "ipc"],
  });

  // Wait for IPC "ready" signal (10s timeout)
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Server start timeout. Check logs: ${LOG_FILE}`));
    }, 10000);

    child.on("message", (msg: unknown) => {
      if (msg && typeof msg === "object" && (msg as Record<string, unknown>).type === "ready") {
        clearTimeout(timeout);
        const p = (msg as Record<string, unknown>).port as number;
        if (p) resolve(p);
        else reject(new Error("Ready signal received but missing port"));
      }
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      const tail = existsSync(LOG_FILE)
        ? readFileSync(LOG_FILE, "utf-8").split("\n").slice(-10).join("\n")
        : "";
      reject(new Error(
        `Server exited with code ${code}.\n${tail ? `Last log lines:\n${tail}` : `Check logs: ${LOG_FILE}`}`
      ));
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  writeFileSync(PID_FILE, String(child.pid));
  child.disconnect();
  child.unref();

  return { pid: child.pid!, port };
}

export async function stopDaemon(): Promise<void> {
  const pid = readPid();
  if (!pid) {
    throw new Error("No PID file found — server not running?");
  }

  if (!isProcessRunning(pid)) {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    if (existsSync(PORT_FILE)) unlinkSync(PORT_FILE);
    throw new Error("Server not running (stale PID file)");
  }

  process.kill(pid, "SIGTERM");

  await new Promise<void>((resolve) => {
    let attempts = 0;
    const checkInterval = setInterval(() => {
      if (!isProcessRunning(pid)) {
        clearInterval(checkInterval);
        resolve();
      } else {
        attempts++;
        if (attempts >= 10) {
          clearInterval(checkInterval);
          process.kill(pid, "SIGKILL");
          resolve();
        }
      }
    }, 500);
  });

  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  if (existsSync(PORT_FILE)) unlinkSync(PORT_FILE);
}

export function getDaemonStatus(): DaemonStatus {
  const pid = readPid();
  const running = pid ? isProcessRunning(pid) : false;
  const port = readPort();

  return { running, pid, port };
}

export function getLogPath(): string {
  return LOG_FILE;
}
