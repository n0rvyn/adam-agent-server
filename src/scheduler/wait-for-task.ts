/**
 * Shared wait-for-task utility.
 * Extracted from TemplateExecutor.waitForTaskCompletion so both the executor
 * and contract-verifier Layer B can await task completion via the same mechanism.
 */

import { getTask } from "../store/tasks.js";
import { updateTask } from "../store/tasks.js";
import { getDb } from "../store/db.js";
import { serverBus } from "../server/events/server-bus.js";
import { classifyError } from "../lib/error-classifier.js";
import { getLogger } from "../lib/logger.js";

export type TaskCompletionStatus = "completed" | "failed" | "cancelled" | "blocked";

const log = getLogger("scheduler");

function isTerminalStatus(status: string): status is TaskCompletionStatus {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "blocked";
}

function latestTaskActivityAt(taskId: string): number | undefined {
  const task = getTask(taskId);
  if (!task) return undefined;

  let latestStepLogAt: number | undefined;
  try {
    const row = getDb()
      .prepare("SELECT MAX(timestamp) as latest FROM step_logs WHERE task_id = ?")
      .get(taskId) as { latest: number | null } | undefined;
    latestStepLogAt = row?.latest ?? undefined;
  } catch (err) {
    log.warn({ taskId, error: err }, "Failed to read latest task step log activity");
  }

  return Math.max(task.startedAt ?? task.createdAt, latestStepLogAt ?? 0);
}

/**
 * Wait for a task to reach a terminal state using event-based listening with DB poll fallback.
 */
export function waitForTaskCompletion(
  taskId: string,
  inactivityTimeoutMs = 600000,
  pollIntervalMs = 5000,
): Promise<TaskCompletionStatus> {
  return new Promise((resolve) => {
    let resolved = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      if (pollTimer) clearTimeout(pollTimer);
      serverBus.off("task_status_change", handler);
    };

    const resolveOnce = (status: TaskCompletionStatus) => {
      cleanup();
      resolve(status);
    };

    const handler = (event: { taskId: string; newStatus: string }) => {
      if (resolved || event.taskId !== taskId) return;
      if (isTerminalStatus(event.newStatus)) {
        resolveOnce(event.newStatus);
      }
    };

    serverBus.on("task_status_change", handler);

    // Fallback poll: check periodically in case event was missed
    const pollCheck = () => {
      if (resolved) return;

      const task = getTask(taskId);
      if (!task) {
        resolveOnce("failed");
        return;
      }

      if (isTerminalStatus(task.status)) {
        resolveOnce(task.status);
        return;
      }

      const activityAt = latestTaskActivityAt(taskId);
      if (activityAt !== undefined && Date.now() - activityAt > inactivityTimeoutMs) {
        const errorMessage = `Task inactivity timeout: no activity for ${Math.ceil(inactivityTimeoutMs / 1000)}s`;
        const classified = classifyError(errorMessage);
        const updates: Parameters<typeof updateTask>[1] = {
          status: "failed",
          error: JSON.stringify(classified),
          completedAt: Date.now(),
          errorCategory: classified.category,
        };
        if (task.startedAt) {
          updates.totalDurationMs = Date.now() - task.startedAt;
        }
        updateTask(taskId, updates);
        serverBus.emit({ type: "task_status_change", taskId, oldStatus: task.status, newStatus: "failed" });
        serverBus.emit({ type: "task_abort_requested", taskId, reason: "inactivity_timeout" });
        resolveOnce("failed");
        return;
      }

      pollTimer = setTimeout(pollCheck, pollIntervalMs);
    };

    // Initial check — task may already be done
    pollTimer = setTimeout(pollCheck, 100);
  });
}
