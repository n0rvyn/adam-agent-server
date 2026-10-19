/**
 * Per-task score computation and EMA aggregation (D-002).
 *
 * 4 dimensions:
 * - task_success: 1.0 if completed, 0.0 if failed
 * - plan_accuracy: from deviation report (1 - deviations / stepsPlanned)
 * - permission_compliance: 1 - (denials / totalToolCalls)
 * - efficiency: 1 - (actualTokens - medianTokens) / medianTokens, clamped [0,1]
 *
 * Weights: task_success=0.3, plan_accuracy=0.25, permission_compliance=0.25, efficiency=0.2
 */

import { getStepLogs } from "../store/logs.js";
import { getTaskPlanByTaskId } from "../store/task-plans.js";
import { getTask } from "../store/tasks.js";
import { getLatestEmaScore, createRoleScore, getMedianTokenUsage } from "../store/role-scores.js";
import type { TaskDimensionScores } from "../store/role-scores.js";
import { getViolationsByTask } from "../store/audit-violations.js";
import { v4 as uuidv4 } from "uuid";
import { getLogger } from "../lib/logger.js";

const log = getLogger("audit"); // reuse admin component for monitor

/** 5-dim weights for new rows (DP-2.1). Sums to 1.0. */
const WEIGHTS_5D = {
  taskSuccess: 0.25,
  planAccuracy: 0.20,
  permissionCompliance: 0.20,
  efficiency: 0.15,
  intentFulfillment: 0.20,
};
/** Legacy 4-dim weights for rows where intent_fulfillment is null (D-003 augmentation, post-verifier correction). Sums to 1.0. */
const WEIGHTS_LEGACY = {
  taskSuccess: 0.3,
  planAccuracy: 0.25,
  permissionCompliance: 0.25,
  efficiency: 0.2,
};
/** Exported for the async update path (audit-manager.ts re-derives EMA after intent-eval lands). */
export const EMA_ALPHA = 0.3;

/**
 * Apply the appropriate weight set based on whether intent_fulfillment is present.
 * Legacy rows (null intent_fulfillment) use 4-dim weights; new rows use 5-dim weights.
 * No re-normalization — both weight sets sum to 1.0 by construction.
 */
export function computeWeighted(scores: Pick<TaskDimensionScores, "taskSuccess" | "planAccuracy" | "permissionCompliance" | "efficiency" | "intentFulfillment">): number {
  if (scores.intentFulfillment === null || scores.intentFulfillment === undefined) {
    return (
      scores.taskSuccess * WEIGHTS_LEGACY.taskSuccess +
      scores.planAccuracy * WEIGHTS_LEGACY.planAccuracy +
      scores.permissionCompliance * WEIGHTS_LEGACY.permissionCompliance +
      scores.efficiency * WEIGHTS_LEGACY.efficiency
    );
  }
  return (
    scores.taskSuccess * WEIGHTS_5D.taskSuccess +
    scores.planAccuracy * WEIGHTS_5D.planAccuracy +
    scores.permissionCompliance * WEIGHTS_5D.permissionCompliance +
    scores.efficiency * WEIGHTS_5D.efficiency +
    scores.intentFulfillment * WEIGHTS_5D.intentFulfillment
  );
}

/**
 * Compute per-task dimension scores.
 * @param taskId - optional, used for median token computation
 */
export function computeTaskScore(taskId: string, roleId?: string): TaskDimensionScores {
  const task = getTask(taskId);

  // task_success
  const taskSuccess = task?.status === "completed" ? 1.0 : 0.0;

  // plan_accuracy — from deviation report
  let planAccuracy = 1.0;
  const taskPlan = getTaskPlanByTaskId(taskId);
  if (taskPlan?.deviationReport) {
    planAccuracy = taskPlan.deviationReport.overallAccuracy;
  }

  // permission_compliance — from step logs
  let permissionCompliance = 1.0;
  const stepLogs = getStepLogs(taskId, 1000);
  const totalToolCalls = stepLogs.filter(s => s.type === "tool_result" || s.type === "permission_denied").length;
  const denials = stepLogs.filter(s => s.type === "permission_denied").length;
  if (totalToolCalls > 0) {
    permissionCompliance = 1 - denials / totalToolCalls;
  }

  // efficiency — from token usage
  let efficiency = 1.0;
  if (task?.tokenUsage) {
    const actualTokens = task.tokenUsage.input + task.tokenUsage.output;
    const medianTokens = roleId ? getMedianTokenUsage(roleId) : 10000;
    if (actualTokens > medianTokens) {
      efficiency = Math.max(0, 1 - (actualTokens - medianTokens) / medianTokens);
    }
  }

  // Weighted score — intent_fulfillment not yet available; use legacy 4-dim weights
  const weighted = computeWeighted({ taskSuccess, planAccuracy, permissionCompliance, efficiency, intentFulfillment: undefined });

  // Phase 2: contract compliance — only computed when this task had contract checks
  const contractsCheckedThisTask = (task?.config as { outputContractCheckCount?: number } | undefined)?.outputContractCheckCount ?? 0;
  let contractCompliance: number | null = null;
  if (contractsCheckedThisTask > 0) {
    const allViolations = getViolationsByTask(taskId);
    // Exclude Layer C warnings from contractCompliance per design D-004 "violation 不死锁，仍交付".
    // We narrow specifically to layer="C" (not all warnings) because pre-existing race-rescue audits
    // also use severity="warning" and SHOULD continue to be visible in contractCompliance
    // (preserves backward compat for race-rescue handling).
    const scoringViolations = allViolations.filter((v) => !(v.severity === "warning" && v.layer === "C"));
    contractCompliance = Math.max(0, Math.min(1, 1 - scoringViolations.length / contractsCheckedThisTask));
  }

  return {
    taskSuccess,
    planAccuracy,
    permissionCompliance,
    efficiency,
    contractCompliance,
    contractsCheckedThisTask,
    weighted,
  };
}

/**
 * Compute EMA and persist score record.
 * @param taskType — the task type for per-type tracking (skill name or "generic").
 * Returns the new EMA score.
 */
export function recordTaskScore(roleId: string, taskId: string, taskType?: string): number {
  const scores = computeTaskScore(taskId, roleId);
  const previousEma = getLatestEmaScore(roleId);
  const emaScore = previousEma !== undefined
    ? EMA_ALPHA * scores.weighted + (1 - EMA_ALPHA) * previousEma
    : scores.weighted;

  createRoleScore({
    id: uuidv4(),
    roleId,
    taskId,
    scores,
    emaScore,
    createdAt: Date.now(),
    taskType,
  });

  log.debug({
    roleId, taskId,
    scores: { ...scores, weighted: scores.weighted.toFixed(3) },
    ema: emaScore.toFixed(3),
  }, "Task score recorded");

  return emaScore;
}
