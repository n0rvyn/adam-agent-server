/**
 * Sandbox violation watcher — monitors OS sandbox enforcement.
 *
 * macOS: tails `log stream --predicate 'subsystem == "com.apple.sandbox"'` for sandbox-exec violations.
 * Linux: watches landlock-audit via dmesg or a dedicated pipe.
 *
 * On violation detected:
 * - Records to delivery_log with source: 'audit', message_type: 'sandbox_violation'
 * - Records to evolution_audit with source: 'audit'
 * - Emits serverBus event: sandbox_violation
 * - Optionally cancels the associated task
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createDeliveryLog } from "../store/delivery-log.js";
import { createEvolutionAudit } from "../store/evolution-audit.js";
import { serverBus } from "../server/events/server-bus.js";
import { getRole } from "../store/roles.js";
import { getRuntimeConfig } from "../config/runtime.js";
import { getSandboxProvider } from "../sandbox/provider.js";
import { lookupTaskByPid } from "../manager/execution-pool.js";
import type { SandboxViolationEvent } from "../sandbox/types.js";
import { getLogger } from "../lib/logger.js";
import { getTaskTraceId } from "../store/tasks.js";

const log = getLogger("audit");

const VIOLATION_LOG_TYPE = "sandbox_violation";

interface ViolationRecord {
  roleId: string;
  taskId?: string;
  path: string;
  operation: string;
  timestamp: number;
  count: number;
}

// In-memory violation counter (reset on restart; sufficient for 24h reporting)
interface TimestampedCount {
  count: number;
  timestamps: number[]; // keep last 24h of timestamps
}
const violationCounts = new Map<string, TimestampedCount>();
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const recentViolations: ViolationRecord[] = [];
const MAX_RECENT = 100;

function recordViolation(v: ViolationRecord): void {
  // Update in-memory counter with sliding window
  const key = v.roleId;
  const entry = violationCounts.get(key) ?? { count: 0, timestamps: [] };
  entry.count++;
  entry.timestamps.push(v.timestamp);

  // Prune timestamps older than 24h
  const cutoff = Date.now() - WINDOW_MS;
  entry.timestamps = entry.timestamps.filter(t => t >= cutoff);

  violationCounts.set(key, entry);

  // Periodic cleanup: on every 100th violation prune entries with zero 24h count
  if (entry.count % 100 === 0) {
    for (const [k, e] of violationCounts.entries()) {
      const c = Date.now() - WINDOW_MS;
      if (e.timestamps.filter(t => t >= c).length === 0) {
        violationCounts.delete(k);
      }
    }
  }

  // Keep bounded recent list
  recentViolations.push(v);
  if (recentViolations.length > MAX_RECENT) {
    recentViolations.shift();
  }

  // Persist to delivery_log (source=audit, message_type=sandbox_violation)
  try {
    const traceId = v.taskId ? getTaskTraceId(v.taskId) : undefined;
    createDeliveryLog({
      id: `sv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ruleId: undefined,
      taskId: v.taskId,
      status: "delivered",
      target: { type: "channel", channelId: "audit" },
      content: "",
      attempts: 1,
      messageType: VIOLATION_LOG_TYPE,
      source: "audit",
      createdAt: v.timestamp,
      deliveredAt: v.timestamp,
      expiresAt: v.timestamp + 86_400_000, // 24h TTL
      error: `${v.operation} on ${v.path}`,
      traceId,
    });
  } catch (err) {
    log.error({ error: err }, "Failed to record violation to delivery_log");
  }

  // Persist to evolution_audit
  try {
    const role = getRole(v.roleId);
    createEvolutionAudit({
      timestamp: v.timestamp,
      oldRules: "sandbox_violation",
      newRules: `${v.operation} on ${v.path}`,
      diff: `Sandbox violation: ${v.operation} on ${v.path} (taskId=${v.taskId ?? "unknown"})`,
      roleId: v.roleId,
      source: "audit",
    });
  } catch (err) {
    log.error({ error: err }, "Failed to record violation to evolution_audit");
  }

  // Emit serverBus event
  serverBus.emit({
    type: "sandbox_violation",
    roleId: v.roleId,
    taskId: v.taskId,
    path: v.path,
    operation: v.operation,
    timestamp: v.timestamp,
  });
}

/**
 * Start watching for sandbox violations.
 * Returns a stop function.
 */
export async function startViolationWatcher(): Promise<() => void> {
  const provider = getSandboxProvider();

  if (provider.platform === "none") {
    log.info("Sandbox platform is 'none'; violation watcher not started");
    return () => {};
  }

  const available = await provider.isAvailable();
  if (!available) {
    log.warn({ platform: provider.platform }, "Sandbox platform detected but not available; violation watcher not started");
    return () => {};
  }

  // Start platform-specific watcher
  let proc: ChildProcess | null = null;

  if (provider.platform === "sandbox-exec") {
    proc = startMacOSWatcher();
  } else if (provider.platform === "landlock") {
    proc = await startLinuxWatcher();
  }

  return () => {
    if (proc) {
      const p = proc;
      proc = null;
      p.kill("SIGTERM");
      // Give process 2s to exit, then force kill
      const forceKillTimer = setTimeout(() => {
        try { p.kill("SIGKILL"); } catch { /* already dead */ }
      }, 2000);
      p.on("exit", () => clearTimeout(forceKillTimer));
    }
    log.info("Violation watcher stopped");
  };
}

function startMacOSWatcher(): ChildProcess {
  // macOS: log stream with subsystem predicate for sandbox-exec violations
  const proc = spawn("log", [
    "stream",
    "--predicate",
    'subsystem == "com.apple.sandbox"',
    "--style",
    "ndjson",
    "--signal",
    "exit",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Look for deny messages with file path
        const msg = entry.eventMessage ?? entry.message ?? "";
        if (msg.includes("deny") && (msg.includes("file-read") || msg.includes("file-write"))) {
          const violation = parseMacOSViolation(entry, msg);
          if (violation) recordViolation(violation);
        }
      } catch {
        // Non-JSON line; ignore
      }
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    log.debug({ msg: chunk.toString() }, "log stream stderr");
  });

  proc.on("error", (err) => {
    log.warn({ error: err }, "macOS violation watcher failed to start");
  });

  log.info("macOS sandbox violation watcher started (log stream)");
  return proc;
}

async function startLinuxWatcher(): Promise<ChildProcess | null> {
  // Try journalctl first (no root required on systemd systems)
  const journalctlProc = await trySpawn("journalctl", ["-kf", "--no-pager", "-o", "short", "--grep", "landlock"]);
  if (journalctlProc) {
    attachLinuxStdoutHandler(journalctlProc);
    log.info("Linux violation watcher started (journalctl -kf)");
    return journalctlProc;
  }

  // Fallback: dmesg -w (requires root)
  const dmesgProc = await trySpawn("dmesg", ["-w", "-t"]);
  if (dmesgProc) {
    attachLinuxStdoutHandler(dmesgProc);
    log.info("Linux violation watcher started (dmesg -w)");
    return dmesgProc;
  }

  log.warn("Linux violation watcher unavailable: neither journalctl nor dmesg accessible. Sandbox enforcement still active; monitoring disabled.");
  return null;
}

async function trySpawn(cmd: string, args: string[]): Promise<ChildProcess | null> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => resolve(proc), 500); // survived 500ms = likely working
    proc.on("error", () => { clearTimeout(timer); resolve(null); });
    proc.on("exit", (code) => {
      if (code !== 0) { clearTimeout(timer); resolve(null); }
    });
  });
}

function attachLinuxStdoutHandler(proc: ChildProcess): void {
  proc.stdout?.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      if (line.includes("landlock") && line.includes("denied")) {
        const violation = parseLinuxViolation(line);
        if (violation) recordViolation(violation);
      }
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    log.debug({ msg: chunk.toString().trim() }, "Linux watcher stderr");
  });
}

function parseMacOSViolation(entry: Record<string, unknown>, msg: string): ViolationRecord | null {
  // Extract path from sandbox-exec violation message
  const pathMatch = msg.match(/(?:path|file)=["']([^"']+)["']/);
  const opMatch = msg.match(/deny\s+(file-read|file-write|file-[^\s]+)/);
  const path = pathMatch?.[1];
  const operation = opMatch?.[1] ?? "unknown";
  if (!path) return null;

  // macOS: ndjson entries have processID field
  const pid = typeof entry.processID === "number" ? entry.processID : undefined;
  const taskInfo = pid ? lookupTaskByPid(pid) : undefined;

  return {
    roleId: taskInfo?.roleId ?? "unknown",
    taskId: taskInfo?.taskId,
    path,
    operation,
    timestamp: Date.now(),
    count: 1,
  };
}

function parseLinuxViolation(line: string): ViolationRecord | null {
  // Example: "landlock:pid=1234: deny file write /home/user/secret/file.txt"
  // Handle quoted paths (with spaces) or non-space paths
  const pathMatch = line.match(/path="([^"]+)"/) ?? line.match(/\/[\w\-\.\/\+ ]+/g);
  const opMatch = line.match(/deny\s+(\w+)/);
  const pidMatch = line.match(/pid=(\d+)/);
  const path = Array.isArray(pathMatch) ? pathMatch[pathMatch.length - 1] : pathMatch?.[1];
  const operation = opMatch?.[1] ?? "unknown";
  if (!path) return null;

  // Linux: dmesg lines contain pid=NNNN
  const pid = pidMatch ? parseInt(pidMatch[1], 10) : undefined;
  const taskInfo = pid ? lookupTaskByPid(pid) : undefined;

  return {
    roleId: taskInfo?.roleId ?? "unknown",
    taskId: taskInfo?.taskId,
    path,
    operation,
    timestamp: Date.now(),
    count: 1,
  };
}

/**
 * Report a sandbox violation programmatically (e.g., from ExecutionManager on sandbox-exec exit code).
 */
export function reportViolation(event: SandboxViolationEvent): void {
  recordViolation({
    roleId: event.roleId,
    taskId: event.taskId,
    path: event.path,
    operation: event.operation,
    timestamp: event.timestamp,
    count: 1,
  });
}

/**
 * Get violation statistics for a role.
 */
export function getViolationCount(roleId: string): number {
  const entry = violationCounts.get(roleId);
  if (!entry) return 0;
  // Return only 24h count
  const cutoff = Date.now() - WINDOW_MS;
  return entry.timestamps.filter(t => t >= cutoff).length;
}

/**
 * Get recent violations (last MAX_RECENT).
 */
export function getRecentViolations(): ViolationRecord[] {
  return [...recentViolations];
}
