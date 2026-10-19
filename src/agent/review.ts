import { getStepLogs } from "../store/logs.js";
import { getTaskPlanByTaskId, saveDeviationReport } from "../store/task-plans.js";
import type { DeviationReport, Deviation, PlanStep } from "../shared/types.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("agent");

/**
 * Generate a deviation report by comparing planned steps vs actual execution (D-011).
 * Returns undefined if no plan exists for this task.
 */
export function generateDeviationReport(taskId: string): DeviationReport | undefined {
  const taskPlan = getTaskPlanByTaskId(taskId);
  if (!taskPlan) {
    log.debug({ taskId }, "No plan found for task, skipping review");
    return undefined;
  }

  const stepLogs = getStepLogs(taskId, 1000);
  const plannedSteps = taskPlan.plan.steps;

  // Extract actual tool calls from step logs
  const actualTools = stepLogs
    .filter(s => s.type === "tool_result" || s.type === "permission_denied")
    .map(s => ({
      toolName: s.toolName ?? "unknown",
      output: s.content,
      planStepIndex: s.planStepIndex,
      permissionDenied: s.type === "permission_denied",
    }));

  const deviations: Deviation[] = [];
  const executedStepIndices = new Set(actualTools.map(t => t.planStepIndex).filter((i): i is number => i !== undefined));

  // Check for skipped planned steps
  for (const step of plannedSteps) {
    if (!executedStepIndices.has(step.index)) {
      deviations.push({
        stepIndex: step.index,
        planned: step.description,
        actual: "Not executed",
        deviationType: "skipped",
      });
    }
  }

  // Check for added steps (actual tool calls not mapped to any plan step)
  const unmappedTools = actualTools.filter(t => t.planStepIndex === undefined);
  for (const tool of unmappedTools) {
    deviations.push({
      stepIndex: -1,
      planned: "",
      actual: `${tool.toolName}: ${tool.output.slice(0, 200)}`,
      deviationType: "added",
    });
  }

  // Check for failed steps (permission denied)
  const failedTools = actualTools.filter(t => t.permissionDenied);
  for (const tool of failedTools) {
    deviations.push({
      stepIndex: tool.planStepIndex ?? -1,
      planned: tool.planStepIndex !== undefined
        ? (plannedSteps.find(s => s.index === tool.planStepIndex)?.description ?? "Unknown")
        : "",
      actual: `PERMISSION DENIED: ${tool.toolName}`,
      deviationType: "failed",
    });
  }

  const stepsPlanned = plannedSteps.length;
  const stepsExecuted = actualTools.length;
  const overallAccuracy = stepsPlanned > 0
    ? Math.max(0, 1 - deviations.filter(d => d.deviationType !== "added").length / stepsPlanned)
    : 1;

  const report: DeviationReport = {
    stepsPlanned,
    stepsExecuted,
    deviations,
    overallAccuracy,
  };

  // Persist to DB
  saveDeviationReport(taskPlan.id, report);

  log.info({
    taskId,
    planId: taskPlan.id,
    stepsPlanned,
    stepsExecuted,
    deviationCount: deviations.length,
    accuracy: overallAccuracy,
  }, "Deviation report generated");

  return report;
}

/**
 * Check if execution was successful based on deviation report.
 */
export function isExecutionSuccessful(report: DeviationReport): boolean {
  const criticalDeviations = report.deviations.filter(
    d => d.deviationType === "failed" || d.deviationType === "skipped",
  );
  return criticalDeviations.length === 0 && report.overallAccuracy >= 0.7;
}
