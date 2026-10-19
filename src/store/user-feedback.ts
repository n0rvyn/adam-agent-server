/**
 * user-feedback.ts — Human feedback store + belief broadcast attribution.
 *
 * Feedback falls user_feedback table.
 * Rating is broadcast to all active beliefs in usedMemoryIds for the execution's step tasks.
 */

import { getDb } from "./db.js";
import { getTemplateExecution } from "./template-executions.js";
import { getContextMeta, getTask } from "./tasks.js";
import { getBelief } from "./beliefs.js";
import { getRoleTaskSeq } from "./roles.js";
import { applyFitnessUpdate } from "../agent/belief-mechanism.js";
import { getRuntimeConfig } from "../config/runtime.js";
import { getLogger } from "../lib/logger.js";
import { v4 as uuidv4 } from "uuid";

const log = getLogger("store");

export interface RecordUserFeedbackArgs {
  executionId: string;
  stepId?: string;
  rating: "good" | "bad";
}

/**
 * Record user feedback for an execution (or specific step).
 * Falls the row into user_feedback and propagates as a weighted challenger trial.
 * If no challenger can be identified, the row is still persisted and a WARN is emitted.
 */
export function recordUserFeedback(args: RecordUserFeedbackArgs): void {
  const { executionId, stepId, rating } = args;
  const db = getDb();

  // Always persist the feedback row first.
  db.prepare(
    "INSERT INTO user_feedback (id, execution_id, step_id, rating, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(uuidv4(), executionId, stepId ?? null, rating, Date.now());

  // Locate the execution to find task IDs for each step.
  const execution = getTemplateExecution(executionId);
  if (!execution) {
    log.warn({ executionId }, "recordUserFeedback: execution not found — feedback persisted, attribution skipped");
    return;
  }

  // Find tasks to broadcast over.
  let taskIds: string[] = [];
  if (stepId) {
    const ss = execution.stepStatuses[stepId];
    if (ss?.taskId) taskIds = [ss.taskId];
  } else {
    taskIds = Object.values(execution.stepStatuses)
      .map((s) => s.taskId)
      .filter(Boolean) as string[];
  }

  const humanFeedbackWeight = getRuntimeConfig().memory?.scope?.humanFeedbackWeight ?? 3.0;
  const taskScore = rating === "good" ? 1.0 : 0.0;

  for (const taskId of taskIds) {
    const meta = getContextMeta(taskId);
    const usedIds = (meta?.usedMemoryIds ?? []) as string[];
    if (usedIds.length === 0) continue;
    const task = getTask(taskId);
    if (!task || !task.roleId) continue;
    const currentSeq = getRoleTaskSeq(task.roleId);
    for (const beliefId of usedIds) {
      try {
        const belief = getBelief(beliefId);
        if (belief?.status !== "active") continue;
        // Magnify human signal by repeating EMA update humanFeedbackWeight times.
        // applyFitnessUpdate mutates belief in-place (bug #1 fix), so each iteration
        // already starts from the post-update value — no re-fetch needed.
        for (let i = 0; i < Math.round(humanFeedbackWeight); i++) {
          applyFitnessUpdate(belief, taskScore, currentSeq);
        }
      } catch (err) {
        log.warn({ executionId, beliefId, err }, "recordUserFeedback: fitness update failed — skipping");
      }
    }
  }
}
