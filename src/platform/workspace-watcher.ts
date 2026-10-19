/**
 * Workspace mtime tracker — aggregates file system activity per running task.
 *
 * Provides a heartbeat signal for watchdog.ts so that tasks whose Roles are
 * actively writing files (e.g., ffmpeg, music-gen) are not falsely killed
 * even when step_logs are sparse.
 *
 * Design: periodic recursive stat (DP-001-A). No chokidar / fs.watch.
 * Cross-platform via Node.js built-ins only.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "../lib/logger.js";

const log = getLogger("workspace-watcher");

/** Directories to exclude from mtime scans (noise: caches, venvs, signal dirs). */
const EXCLUDE_DIRS = new Set(["node_modules", ".signals", ".cache", ".uv-cache", ".youtube-venv", ".git"]);

/** File suffixes to exclude (log files are high-churn but not meaningful activity). */
const EXCLUDE_FILE_SUFFIXES = [".log"];

/** Maps taskId → absolute path of the Role workspace being watched. */
const taskWorkspaces = new Map<string, string>();

/** Maps taskId → last observed mtime in ms (epoch). */
const lastActivity = new Map<string, number>();

/**
 * Register a running task and its Role workspace for mtime tracking.
 * Seeds lastActivity with the current time so the first watchdog cycle
 * never false-kills a freshly-started task.
 */
export function registerTask(taskId: string, workspacePath: string): void {
  taskWorkspaces.set(taskId, workspacePath);
  lastActivity.set(taskId, Date.now());
  log.debug({ taskId, workspacePath }, "workspace-watcher: task registered");
}

/** Remove a task — called when the task completes or is cancelled. */
export function unregisterTask(taskId: string): void {
  taskWorkspaces.delete(taskId);
  lastActivity.delete(taskId);
  log.debug({ taskId }, "workspace-watcher: task unregistered");
}

/**
 * Return the last observed mtime (ms) for a registered task.
 * Returns null if the task is not registered.
 */
export function getLastActivity(taskId: string): number | null {
  return lastActivity.get(taskId) ?? null;
}

/**
 * Recursively walk a directory and return the maximum file mtime found.
 * Skips excluded dirs and log-file suffixes per DP-002.
 * Returns -Infinity (well below any valid mtime) if no files are found.
 */
async function maxMtimeInDir(dir: string): Promise<number> {
  let max = -Infinity;
  // Explicit `encoding: "utf8"` ensures Dirent<string>, not Dirent<Buffer>.
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = (await readdir(dir, { withFileTypes: true, encoding: "utf8" })) as Array<
      import("node:fs").Dirent
    >;
  } catch {
    // Directory unreadable (permissions, deleted) — treat as no new activity.
    return -Infinity;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) return;
        const subMax = await maxMtimeInDir(full);
        if (subMax > max) max = subMax;
        return;
      }

      if (entry.isFile()) {
        if (EXCLUDE_FILE_SUFFIXES.some((s) => entry.name.endsWith(s))) return;
        try {
          const s = await stat(full);
          if (s.mtimeMs > max) max = s.mtimeMs;
        } catch {
          // Skip files that can't be stat'd.
        }
      }
    }),
  );

  return max;
}

/**
 * Refresh lastActivity for all registered tasks.
 * Called at the start of every watchdog health-check cycle so that
 * block 4's kill decision uses fresh mtime values.
 */
export async function tickAll(): Promise<void> {
  if (taskWorkspaces.size === 0) return;

  const entries = Array.from(taskWorkspaces.entries());
  await Promise.all(
    entries.map(async ([taskId, workspacePath]) => {
      try {
        const mtime = await maxMtimeInDir(workspacePath);
        if (mtime > -Infinity) {
          // Never regress below registration seed or a previously-observed
          // newer mtime. Registration seed acts as a floor so a freshly-started
          // task isn't false-killed when the workspace only contains pre-existing
          // files older than the task. Also defends against the Date.now() vs
          // Linux mtimeMs sub-ms clock skew on fast tmpfs.
          const current = lastActivity.get(taskId) ?? -Infinity;
          const next = mtime > current ? mtime : current;
          lastActivity.set(taskId, next);
          log.debug({ taskId, workspacePath, mtime, recorded: next }, "workspace-watcher: tick updated");
        } else {
          // No files found (workspace may be empty or all excluded) — keep last value.
          log.debug({ taskId, workspacePath }, "workspace-watcher: tick — no files found, keeping last");
        }
      } catch (err) {
        // Per plan: if mtime read fails, fall back to last value — do NOT force kill.
        log.warn({ taskId, workspacePath, err }, "workspace-watcher: tick failed, keeping last activity");
      }
    }),
  );
}

/**
 * Test-only: clear both maps.
 * Use only in test files to reset state between tests.
 */
export function _resetForTests(): void {
  taskWorkspaces.clear();
  lastActivity.clear();
}
