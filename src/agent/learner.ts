import { generateDeviationReport, isExecutionSuccessful } from "./review.js";
import { getTaskPlanByTaskId, saveLearnedRules, updateTaskPlanStatus } from "../store/task-plans.js";
import { getTask } from "../store/tasks.js";
import { getRole, updateRole } from "../store/roles.js";
import { getRoleWorkspacePath, writeRoleCLAUDEmd } from "../store/role-workspace.js";
import type { DeviationReport, LearnedRules } from "../shared/types.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("agent");

/**
 * Split raw string[] rules (with [+]/[-]/[~] prefix tags) into Role slot arrays.
 * Used after extraction to update the structured LearnedRules object.
 */
function classifyRulesForRoleSlots(rules: string[]): { stylePreferences: string[]; avoidedActions: string[] } {
  const stylePreferences: string[] = [];
  const avoidedActions: string[] = [];
  for (const rule of rules) {
    if (rule.startsWith("[-]")) {
      avoidedActions.push(rule);
    } else {
      // [+](positive), [~](added/modified) → stylePreferences
      stylePreferences.push(rule);
    }
  }
  return { stylePreferences, avoidedActions };
}

/**
 * Extract structured rules from a deviation report (D-012).
 * Both positive (plan accurate) and negative (deviations) experiences are captured.
 */
export function extractRulesFromDeviation(
  taskId: string,
  report: DeviationReport,
): string[] {
  const rules: string[] = [];
  const task = getTask(taskId);
  const promptSummary = task?.prompt.slice(0, 100) ?? "unknown task";

  if (isExecutionSuccessful(report)) {
    rules.push(
      `[+] Task "${promptSummary}" completed successfully with ${report.overallAccuracy * 100}% plan accuracy (${report.stepsExecuted} steps). [sourceTaskId:${taskId}]`,
    );
  }

  for (const deviation of report.deviations) {
    switch (deviation.deviationType) {
      case "skipped":
        rules.push(
          `[-] Planned step "${deviation.planned}" was skipped during "${promptSummary}". Consider if this step is necessary for similar tasks. [sourceTaskId:${taskId}]`,
        );
        break;
      case "failed":
        rules.push(
          `[-] Step failed: "${deviation.actual}" during "${promptSummary}". Check permissions and tool availability. [sourceTaskId:${taskId}]`,
        );
        break;
      case "added":
        rules.push(
          `[~] Unplanned action: "${deviation.actual}" during "${promptSummary}". Consider adding to plan for similar tasks. [sourceTaskId:${taskId}]`,
        );
        break;
      case "modified":
        rules.push(
          `[~] Step modified: planned "${deviation.planned}" but did "${deviation.actual}" during "${promptSummary}". [sourceTaskId:${taskId}]`,
        );
        break;
    }
  }

  return rules;
}

/**
 * Process task review and learning after task completion.
 * Called from Manager decision cycle on task_complete/task_error.
 *
 * Flow: generate deviation report → extract rules → update agent/role learnedRules.
 */
export async function processTaskReview(taskId: string): Promise<void> {
  const taskPlan = getTaskPlanByTaskId(taskId);
  if (!taskPlan) {
    log.debug({ taskId }, "No plan for task, skipping review/learn");
    return;
  }

  // Review phase (D-011)
  const report = generateDeviationReport(taskId);
  if (!report) return;

  // Learn phase (D-012)
  const rules = extractRulesFromDeviation(taskId, report);
  if (rules.length === 0) return;

  saveLearnedRules(taskPlan.id, rules);

  // Append to role's learnedRules and write to CLAUDE.md (D-027)
  const task = getTask(taskId);
  if (task?.roleId) {
    const role = getRole(task.roleId);
    if (role) {
      const classified = classifyRulesForRoleSlots(rules);
      const next: LearnedRules = {
        stylePreferences: [...role.learnedRules.stylePreferences, ...classified.stylePreferences],
        avoidedActions: [...role.learnedRules.avoidedActions, ...classified.avoidedActions],
        pinnedParameters: role.learnedRules.pinnedParameters, // untouched by deviation extraction
      };
      updateRole(task.roleId, { learnedRules: next });
      // Write updated rules to Role's CLAUDE.md
      const wsPath = getRoleWorkspacePath(role.name);
      writeRoleCLAUDEmd(wsPath, { ...role, learnedRules: next });
      log.info({ roleId: task.roleId, newRulesCount: rules.length }, "Role learnedRules updated and CLAUDE.md written");
    }
  }

  // Mark plan as completed
  updateTaskPlanStatus(taskPlan.id, "completed");

  log.info({
    taskId,
    planId: taskPlan.id,
    rulesExtracted: rules.length,
    accuracy: report.overallAccuracy,
  }, "Task review and learning completed");
}
