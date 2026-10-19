/**
 * Linux Landlock provider.
 *
 * Uses the landlock-exec C wrapper binary to apply Landlock LSM restrictions
 * before executing the target command. landlock-exec must be built from
 * landlock-exec/main.c (make landlock-exec on Linux).
 *
 * NOTE: Linux Landlock does not support deny rules.
 * Read path restriction on Linux is handled at the SDK layer only (canUseTool blockedPath).
 * deniedReadPaths is NOT enforced at the OS level on Linux.
 * See GitHub Issue #134 for future tracking.
 *
 * child_process.spawn() with { stdio: 'pipe' } returns a ChildProcess that
 * structurally satisfies SpawnedProcess.
 */

import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import type { SandboxProvider, SandboxSpawnOptions, VisiblePath } from "./types.js";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

/**
 * Find the landlock-exec binary.
 * It is built in the same directory as this module (src/sandbox/landlock-exec/).
 */
let _landlockExecPath: string | null = null;

export function findLandlockExec(): string {
  if (_landlockExecPath) return _landlockExecPath;

  // First: look relative to this module (src/sandbox/)
  const dir = typeof import.meta.dirname === "string" ? import.meta.dirname : __dirname ?? ".";
  const moduleDir = join(dir, "landlock-exec", "landlock-exec");
  if (existsSync(moduleDir)) {
    _landlockExecPath = moduleDir;
    return moduleDir;
  }

  // Fallback: look in PATH
  const inPath = process.env["PATH"]?.split(":").find((p) =>
    existsSync(join(p, "landlock-exec"))
  );
  if (inPath) {
    _landlockExecPath = join(inPath, "landlock-exec");
    return _landlockExecPath;
  }

  // Return the expected path even if not found — isAvailable() will be false
  // Do NOT cache: let subsequent calls retry in case binary is installed later
  return moduleDir;
}

/**
 * LinuxLandlockProvider — uses landlock-exec to restrict filesystem access via Landlock LSM.
 *
 * The landlock-exec binary must be compiled on Linux (make landlock-exec).
 * On macOS this provider is never instantiated (detect.ts returns 'linux' only on linux).
 */
export class LinuxLandlockProvider implements SandboxProvider {
  readonly platform = "landlock" as const;

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "linux") return false;

    // Check the binary exists and is executable
    try {
      accessSync(findLandlockExec(), constants.X_OK);
    } catch {
      return false;
    }

    // Verify kernel Landlock support via --check
    try {
      execFileSync(findLandlockExec(), ["--check"], {
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return true;
    } catch {
      return false;
    }
  }

  spawn(options: SandboxSpawnOptions): SpawnedProcess {
    const command = options.command ?? "node";
    const args = options.args ?? [];

    // Build landlock-exec arguments: --ro <path> --rw <path> -- command args
    const landlockArgs: string[] = [];

    for (const vp of options.visiblePaths ?? []) {
      const flag = vp.mode === "rw" ? "--rw" : "--ro";

      // Resolve symlinks — Landlock enforces on inodes (resolved paths)
      let resolved: string;
      try {
        resolved = realpathSync(vp.path);
      } catch {
        resolved = vp.path;
      }

      landlockArgs.push(flag, resolved);

      // If symlink, also allow the original path
      if (resolved !== vp.path) {
        landlockArgs.push(flag, vp.path);
      }
    }

    landlockArgs.push("--", command, ...args);

    return nodeSpawn(findLandlockExec(), landlockArgs, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: "pipe",
      signal: options.signal,
    }) as unknown as SpawnedProcess;
  }
}
