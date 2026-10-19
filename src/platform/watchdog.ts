import type { WatchdogConfig } from "../shared/types.js";
import type { ChatManager } from "../manager/chat-manager.js";
import type { ExecutionPool } from "../manager/execution-pool.js";
import { listTasks, updateTask } from "../store/tasks.js";
import { serverBus } from "../server/events/server-bus.js";
import { getDb } from "../store/db.js";
import { getLogger } from "../lib/logger.js";
import {
  listStaleRunningExecutions,
  updateTemplateExecution,
} from "../store/template-executions.js";
import {
  deleteArtifactsByExecution,
  listArtifactsByExecution,
  listExpiredExecutions,
} from "../store/artifacts.js";
import {
  gcOrphanBlobs,
  removeTemplateExecutionArtifactsDir,
  unlinkBlob,
} from "../lib/artifact-storage.js";
import { getLastActivity, tickAll } from "./workspace-watcher.js";
import { snapshot, diff, deserializeTuples, type SnapshotTuple } from "./workspace-snapshot.js";
import { insertTaskFilesDiff } from "../store/task-files.js";
import { updateContextMeta } from "../store/tasks.js";
import { getRole } from "../store/roles.js";
import { getRoleWorkspacePath } from "../store/role-workspace.js";

const log = getLogger("watchdog");

let watchdogInterval: ReturnType<typeof setInterval> | null = null;

interface WatchdogState {
  managerStaleActive: boolean;
  /** AR-2: watchdog-owned restart counter for the current stale episode (decoupled from
   *  ChatManager.consecutiveStaleCount, which runQuery zeroes on every SDK event). */
  managerRestartAttempts: number;
  poolUnhealthyActive: boolean;
  staleTasksActive: boolean;
}

const watchdogState: WatchdogState = {
  managerStaleActive: false,
  managerRestartAttempts: 0,
  poolUnhealthyActive: false,
  staleTasksActive: false,
};

/** Max in-process restart attempts per stale episode before handing off to the supervisor. */
const MAX_RESTART_ATTEMPTS = 2;

export function initWatchdog(
  config: WatchdogConfig,
  chatManager: ChatManager,
  executionPool: ExecutionPool,
  onAlert: (message: string) => void,
): void {
  if (!config.enabled) {
    log.info("Watchdog disabled");
    return;
  }

  const intervalMs = config.intervalMinutes * 60_000;
  log.info({ intervalMinutes: config.intervalMinutes }, "Watchdog started");

  watchdogInterval = setInterval(() => {
    runHealthChecks(config, chatManager, executionPool, onAlert);
  }, intervalMs);
}

export function stopWatchdog(): void {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
    log.info("Watchdog stopped");
  }
  // Reset edge state so a fresh init starts clean
  watchdogState.managerStaleActive = false;
  watchdogState.managerRestartAttempts = 0;
  watchdogState.poolUnhealthyActive = false;
  watchdogState.staleTasksActive = false;
}

/** Module-level reentrancy guard. Skip overlapping reconcile if previous tick still running. */
let reconcileInFlight = false;

/**
 * Set of taskIds quarantined this process lifetime because their startSnapshot tuples
 * were unparseable (e.g. corrupted bigint string). On observation, the task is
 * immediately marked failed with error_category='CORRUPT_CONTEXT_META' so the next
 * tick won't re-attempt — preventing log spam.
 */
const quarantinedTaskIds = new Set<string>();

/**
 * Reconcile tasks that were SIGKILL'd mid-execution or left in status='running' across
 * a process restart.
 *
 * Behavior:
 * - Tasks with context_meta.startSnapshot but NOT live in workspace-watcher (the
 *   in-memory liveness map is empty for them) had no endTask hook fire. We diff their
 *   workspace against the persisted startSnapshot, write task_files rows, clear the
 *   startSnapshot from context_meta (preserving sibling keys), and mark the task
 *   failed with error_category='KILLED_NO_END_TASK'.
 *
 * Cross-restart semantics:
 * - Adam does NOT resume status='running' tasks at process restart. After restart,
 *   ALL prior-running tasks have empty getLastActivity (workspace-watcher's Map is
 *   in-memory and fresh). This function intentionally sweeps them on the first tick:
 *   faster cleanup than waiting for staleRunningTasks's maxRunningMinutes window.
 *   The KILLED_NO_END_TASK label is accurate — no end-hook ever fired.
 *
 * Reentrancy:
 * - A module-level `reconcileInFlight` flag suppresses overlapping ticks. If a prior
 *   tick is still running when the next watchdog interval fires, this run is skipped.
 *   This prevents duplicate task_files row inserts that would otherwise occur because
 *   the orphan-eligibility check (`getLastActivity===null` + has startSnapshot) is
 *   non-transactional w.r.t. the subsequent INSERT.
 *
 * Quarantine:
 * - Tasks with malformed startSnapshot tuples (bigint parse throws) are marked failed
 *   with error_category='CORRUPT_CONTEXT_META' and added to an in-memory quarantine
 *   set so the same task isn't retried every tick (avoids log spam).
 *
 * Called from runHealthChecks on every watchdog tick. Exported for direct testing.
 */
export async function reconcileOrphanedSnapshots(): Promise<void> {
  if (reconcileInFlight) {
    log.debug("reconcileOrphanedSnapshots: previous tick still running, skipping");
    return;
  }
  reconcileInFlight = true;
  try {
    const db = getDb();
    const runningTasks = db
      .prepare("SELECT id, role_id, config, context_meta FROM tasks WHERE status = 'running'")
      .all() as Array<{ id: string; role_id: string | null; config: string | null; context_meta: string | null }>;

    for (const row of runningTasks) {
      if (quarantinedTaskIds.has(row.id)) continue;

      try {
        // Skip if no parseable context_meta
        if (!row.context_meta) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(row.context_meta) as Record<string, unknown>;
        } catch {
          continue;
        }
        // Skip if no startSnapshot array
        if (!Array.isArray(parsed.startSnapshot)) continue;

        // Skip if task is still live (workspace-watcher has it registered)
        // getLastActivity returns null when unregistered — non-null means live
        if (getLastActivity(row.id) !== null) continue;

        // Resolve workspace path: config.workspacePath override takes priority,
        // otherwise derive from role name (same as ExecutionManager line ~270).
        let workspacePath: string | undefined;
        if (row.config) {
          try {
            const cfg = JSON.parse(row.config) as Record<string, unknown>;
            if (typeof cfg.workspacePath === "string") {
              workspacePath = cfg.workspacePath;
            }
          } catch { /* ignore */ }
        }
        if (!workspacePath) {
          if (!row.role_id) {
            log.warn({ taskId: row.id }, "reconcileOrphanedSnapshots: no role_id, skipping");
            continue;
          }
          const role = getRole(row.role_id);
          if (!role) {
            log.warn({ taskId: row.id, roleId: row.role_id }, "reconcileOrphanedSnapshots: role not found, skipping");
            continue;
          }
          workspacePath = getRoleWorkspacePath(role.name);
        }

        // Reconstruct startSnap via shared deserialize helper.
        // If the tuples are corrupt (bigint parse throws), quarantine + fail-immediately
        // so we don't retry every tick. Note: SnapshotTuple is [path, mtime_ns_str, size, inode_str]
        // — both bigints stored as strings for JSON safety.
        let startSnap: Map<string, import("./workspace-snapshot.js").SnapshotEntry>;
        try {
          startSnap = deserializeTuples(parsed.startSnapshot as SnapshotTuple[]);
        } catch (parseErr) {
          quarantinedTaskIds.add(row.id);
          updateContextMeta(row.id, (meta) => { delete meta.startSnapshot; });
          db.prepare(
            "UPDATE tasks SET status = 'failed', error_category = ?, completed_at = ? WHERE id = ? AND status = 'running'",
          ).run("CORRUPT_CONTEXT_META", Date.now(), row.id);
          log.warn({ taskId: row.id, err: parseErr }, "reconcileOrphanedSnapshots: corrupt startSnapshot tuples, quarantined + failed");
          continue;
        }

        const endSnap = await snapshot(workspacePath);
        const d = diff(startSnap, endSnap);
        insertTaskFilesDiff(row.id, d);

        // Clear startSnapshot via shared helper (preserves sibling keys + atomic)
        updateContextMeta(row.id, (meta) => { delete meta.startSnapshot; });

        // Mark task failed — WHERE includes AND status='running' for race-safety with endTask
        db.prepare(
          "UPDATE tasks SET status = 'failed', error_category = ?, completed_at = ? WHERE id = ? AND status = 'running'",
        ).run("KILLED_NO_END_TASK", Date.now(), row.id);

        log.info(
          { taskId: row.id, added: d.added.length, modified: d.modified.length, deleted: d.deleted.length },
          "reconcileOrphanedSnapshots: reconciled orphaned task",
        );
      } catch (err) {
        log.warn({ err, taskId: row.id }, "reconcileOrphanedSnapshots: per-task error (continuing)");
      }
    }
  } catch (err) {
    log.warn({ err }, "reconcileOrphanedSnapshots: top-level error");
  } finally {
    reconcileInFlight = false;
  }
}

/** Test-only: clear in-memory quarantine + reset reentrancy guard between tests. */
export function _resetReconcileStateForTests(): void {
  reconcileInFlight = false;
  quarantinedTaskIds.clear();
}

function runHealthChecks(
  config: WatchdogConfig,
  chatManager: ChatManager,
  executionPool: ExecutionPool,
  onAlert: (message: string) => void,
): void {
  const { rules } = config;

  // Refresh workspace mtime map at the start of every cycle (Phase 4 heartbeat).
  // Fire-and-forget: if it fails, fall back to step_logs for the kill decision.
  void (async () => {
    try {
      await tickAll();
    } catch (err) {
      log.warn({ err }, "workspace-watcher tickAll failed");
    }
  })();

  // 1. ChatManager health check — edge-triggered.
  //
  // Staleness is only meaningful when ChatManager has WORK to do (queue non-empty or a turn
  // in flight). A long idle period with empty queue and no in-flight turn is a healthy server
  // waiting for the user, not a stuck manager (#218). Reading both lastActivityAt AND
  // queue/processing state lets watchdog distinguish "no chat traffic" from "stuck dispatch
  // loop / hung SDK turn".
  if (rules.managerHealthCheck.enabled) {
    const staleMs = rules.managerHealthCheck.staleDurationMinutes * 60_000;
    const lastActivity = chatManager.getLastActivityAt();
    const queueDepth = chatManager.getQueueDepth();
    const inflight = chatManager.isProcessing();
    const hasWork = queueDepth > 0 || inflight;
    const timeoutExceeded = Date.now() - lastActivity > staleMs;
    const isStale = timeoutExceeded && hasWork;

    if (isStale) {
      if (!watchdogState.managerStaleActive) {
        // Rising edge: false → true. Log once with diagnostic signals so the user can
        // distinguish a queue-stuck case from an in-flight-hung case from logs (#208).
        // Only log/alert here — do NOT gate the recovery action on the rising edge (AR-1).
        const msg = `ChatManager session stale: no activity for ${rules.managerHealthCheck.staleDurationMinutes} min, queueDepth=${queueDepth}, inflight=${inflight}`;
        log.warn({ queueDepth, inflight, staleMinutes: rules.managerHealthCheck.staleDurationMinutes }, msg);
        watchdogState.managerStaleActive = true;
        watchdogState.managerRestartAttempts = 0;
        if (rules.managerHealthCheck.action === "notify") onAlert(msg);
      }
      // AR-1: evaluate the recovery action on EVERY stale tick (not just the rising edge),
      // so a restart that did not resolve the hang is retried, then escalated.
      if (rules.managerHealthCheck.action === "restart") {
        // In-process hot-restart every stale tick (AR-1). No process.exit: this deployment has
        // no process supervisor, so killing the server would leave it permanently dead — worse
        // than the hang. Keep retrying in-process; escalate to the human ONCE after
        // MAX_RESTART_ATTEMPTS so a session that auto-restart cannot fix still gets noticed.
        watchdogState.managerRestartAttempts++;
        void chatManager.restartSession();
        if (watchdogState.managerRestartAttempts === MAX_RESTART_ATTEMPTS + 1) {
          const escMsg = `ChatManager 连续自动重启 ${MAX_RESTART_ATTEMPTS} 次仍未恢复，继续重试中——请人工检查`;
          log.error({ attempts: watchdogState.managerRestartAttempts }, escMsg);
          onAlert(escMsg);
        }
      }
    } else if (watchdogState.managerStaleActive) {
      // Falling edge: recovered, or work drained so idle is no longer "stuck".
      // Reset the attempt counter so the next stale episode re-arms from scratch (AR-1 re-arm).
      log.info("ChatManager session resumed activity");
      watchdogState.managerStaleActive = false;
      watchdogState.managerRestartAttempts = 0;
      // Do NOT call onAlert for resumed — user only wants problem notifications
    }
  }

  // 2. ExecutionPool health check — edge-triggered
  const poolUnhealthy = !executionPool.isHealthy();
  if (poolUnhealthy && !watchdogState.poolUnhealthyActive) {
    const msg = "ExecutionPool is not healthy (stopped unexpectedly)";
    log.warn(msg);
    watchdogState.poolUnhealthyActive = true;
    onAlert(msg);
  } else if (!poolUnhealthy && watchdogState.poolUnhealthyActive) {
    log.info("ExecutionPool recovered");
    watchdogState.poolUnhealthyActive = false;
  }

  // 3. Stale tasks check — edge-triggered on presence of stale tasks
  if (rules.staleTasks.enabled) {
    const maxPendingMs = rules.staleTasks.maxPendingMinutes * 60_000;
    const pendingTasks = listTasks("pending");
    const staleTasks = pendingTasks.filter((t) => Date.now() - t.createdAt > maxPendingMs);
    const hasStale = staleTasks.length > 0;

    if (hasStale && !watchdogState.staleTasksActive) {
      const msg = `${staleTasks.length} stale task(s) pending > ${rules.staleTasks.maxPendingMinutes} min`;
      log.warn({ count: staleTasks.length }, msg);
      watchdogState.staleTasksActive = true;
      if (rules.staleTasks.action === "notify") onAlert(msg);
    } else if (!hasStale && watchdogState.staleTasksActive) {
      log.info("Stale tasks cleared");
      watchdogState.staleTasksActive = false;
    }
  }

  // 4. Stale running tasks check — fail tasks with no step log activity for too long
  //    A task running for a long time but making progress (step logs) is legitimate.
  //    A task with no step logs after maxRunningMinutes is likely stuck (SDK process hung).
  if (rules.staleRunningTasks?.enabled) {
    const maxRunningMs = rules.staleRunningTasks.maxRunningMinutes * 60_000;
    const runningTasks = listTasks("running");
    const staleRunning = runningTasks.filter((t) => {
      if (!t.startedAt) return false;
      const elapsed = Date.now() - t.startedAt;
      if (elapsed < maxRunningMs) return false;

      // Phase 4 heartbeat: activity = max(step_log mtime, workspace mtime, task startedAt).
      // Kill only when ALL three signals are stale (plan regression check).
      try {
        const db = getDb();
        const latestLog = db.prepare(
          "SELECT MAX(timestamp) as latest FROM step_logs WHERE task_id = ?",
        ).get(t.id) as { latest: number | null } | undefined;
        const stepLogActivity = latestLog?.latest ?? 0;
        const workspaceActivity = getLastActivity(t.id) ?? 0;
        const lastActivity = Math.max(stepLogActivity, workspaceActivity, t.startedAt);
        return Date.now() - lastActivity > maxRunningMs;
      } catch {
        // If we can't check logs, fall back to startedAt — do NOT force kill
        return false;
      }
    });

    if (staleRunning.length > 0) {
      const msg = `${staleRunning.length} task(s) running with no activity for > ${rules.staleRunningTasks.maxRunningMinutes} min — marking as failed`;
      log.warn({ count: staleRunning.length, taskIds: staleRunning.map((t) => t.id) }, msg);
      for (const t of staleRunning) {
        updateTask(t.id, {
          status: "failed",
          error: `Watchdog killed: no activity for ${rules.staleRunningTasks.maxRunningMinutes} min`,
          completedAt: Date.now(),
        });
        serverBus.emit({ type: "task_status_change", taskId: t.id, oldStatus: "running", newStatus: "failed" });
        executionPool.releaseSlot(t.id);
      }
      onAlert(msg);
    }
  }

  // 4b. Stale TemplateExecution reconciliation (#215) — running rows whose child
  //     tasks are all terminal but the row itself never transitioned to a terminal
  //     status (process restart / missed promise settlement). Walk stepStatuses,
  //     query the linked tasks, and if no task is in an active state, mark the
  //     execution failed with an "orphaned" reason.
  if (rules.staleTemplateExecutions?.enabled) {
    const maxOrphanMs = rules.staleTemplateExecutions.maxOrphanMinutes * 60_000;
    let orphaned: { id: string; templateId: string }[] = [];
    try {
      const candidates = listStaleRunningExecutions(maxOrphanMs);
      const db = getDb();
      const isActive = (status: string) =>
        status === "pending" || status === "queued" || status === "running" || status === "paused" || status === "blocked";
      for (const exec of candidates) {
        const taskIds = Object.values(exec.stepStatuses)
          .map((s) => s.taskId)
          .filter((id): id is string => typeof id === "string" && id.length > 0);
        if (taskIds.length === 0) {
          // No child tasks recorded at all and exec older than maxOrphanMinutes → orphan.
          orphaned.push({ id: exec.id, templateId: exec.templateId });
          continue;
        }
        // Chunk to stay under SQLite's 999-variable bind limit, and short-circuit
        // as soon as any active child task is found.
        const CHUNK = 500;
        let anyActive = false;
        for (let i = 0; i < taskIds.length && !anyActive; i += CHUNK) {
          const chunk = taskIds.slice(i, i + CHUNK);
          const placeholders = chunk.map(() => "?").join(",");
          const rows = db
            .prepare(`SELECT id, status FROM tasks WHERE id IN (${placeholders})`)
            .all(...chunk) as { id: string; status: string }[];
          if (rows.some((r) => isActive(r.status))) anyActive = true;
        }
        if (!anyActive) {
          orphaned.push({ id: exec.id, templateId: exec.templateId });
        }
      }
    } catch (err) {
      log.error({ err }, "stale TemplateExecution scan failed");
      orphaned = [];
    }

    if (orphaned.length > 0) {
      const msg = `${orphaned.length} TemplateExecution(s) running > ${rules.staleTemplateExecutions.maxOrphanMinutes} min with no active child tasks — reconciling to failed`;
      log.warn({ count: orphaned.length, executionIds: orphaned.map((o) => o.id) }, msg);
      for (const o of orphaned) {
        try {
          updateTemplateExecution(o.id, {
            status: "failed",
            error: `orphaned: no active child tasks (watchdog reconciled after ${rules.staleTemplateExecutions.maxOrphanMinutes} min)`,
            completedAt: Date.now(),
          });
        } catch (err) {
          log.error({ err, executionId: o.id }, "Failed to reconcile orphan TemplateExecution");
        }
      }
      if (rules.staleTemplateExecutions.action === "notify") onAlert(msg);
    }
  }

  // 4c. Orphaned snapshot reconciliation — tasks that were SIGKILL'd without endTask firing
  void (async () => {
    await reconcileOrphanedSnapshots();
  })();

  // 5. DB maintenance
  if (rules.dbMaintenance.enabled) {
    try {
      const db = getDb();
      const walSize = db.pragma("wal_checkpoint(PASSIVE)") as unknown;
      log.debug({ walSize }, "WAL checkpoint");
    } catch (err) {
      log.error({ error: err }, "DB health check failed");
    }
  }

  // 5b. Reflection cadence tick
  if (rules.reflectionJob?.enabled) {
    const intervalMinutes = rules.reflectionJob.intervalMinutes;
    void (async () => {
      try {
        const { reflectionTick } = await import("../agent/reflection-job.js");
        await reflectionTick(intervalMinutes);
      } catch (err) {
        log.error({ err }, "Reflection tick failed");
      }
    })();
  }

  // 5c. Memory GC tick
  if (rules.memoryGc?.enabled) {
    try {
      const db = getDb();
      const lastRow = db
        .prepare("SELECT last_memory_gc_at FROM server_state WHERE id = 1")
        .get() as { last_memory_gc_at: number | null } | undefined;
      const elapsed = Date.now() - (lastRow?.last_memory_gc_at ?? 0);
      if (elapsed > rules.memoryGc.intervalHours * 3_600_000) {
        const gcConfig = rules.memoryGc;
        void (async () => {
          try {
            const { memoryGcTick } = await import("../agent/memory-gc.js");
            memoryGcTick({
              observationTtlDays: gcConfig.observationTtlDays,
            });
          } catch (err) {
            log.error({ err }, "Memory GC tick failed");
          }
        })();
      }
    } catch (err) {
      log.error({ err }, "Memory GC tick guard failed");
    }
  }

  // 6. TemplateExecution artifact cleanup
  if (rules.artifactCleanup?.enabled) {
    try {
      const ttlMs = rules.artifactCleanup.ttlDays * 24 * 60 * 60 * 1000;
      const orphanMinAgeMs = rules.artifactCleanup.orphanGcMinAgeHours * 60 * 60 * 1000;
      const cutoff = Date.now() - ttlMs;
      const expiredExecutionIds = listExpiredExecutions(cutoff);
      let removedFiles = 0;

      for (const executionId of expiredExecutionIds) {
        const validArtifactIds = new Set(
          listArtifactsByExecution(executionId).map((artifact) => artifact.id),
        );
        removedFiles += gcOrphanBlobs(executionId, validArtifactIds, orphanMinAgeMs);

        const deletedArtifacts = deleteArtifactsByExecution(executionId);
        for (const artifact of deletedArtifacts) {
          if (artifact.blobPath) {
            unlinkBlob(artifact.blobPath);
            removedFiles++;
          }
        }

        removeTemplateExecutionArtifactsDir(executionId);
      }

      if (expiredExecutionIds.length > 0) {
        log.info(
          { executions: expiredExecutionIds.length, files: removedFiles },
          "TemplateExecution artifacts cleaned",
        );
      }
    } catch (err) {
      log.error({ error: err }, "TemplateExecution artifact cleanup failed");
    }
  }
}
