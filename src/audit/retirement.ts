/**
 * Agent retirement/reinstatement state machine (D-003).
 *
 * Retirement: EMA score < threshold → retired → diagnostic-based learnedRules correction → probation
 * Probation: agent runs N tasks → if EMA recovers above threshold → active; else → re-retire
 */

import { getRole, updateRole } from "../store/roles.js";
import { createEvolutionAudit, generateDiff } from "../store/evolution-audit.js";
import { generateDiagnosticReport, type DiagnosticReport } from "./diagnostic.js";
import { getScoresByRole } from "../store/role-scores.js";
import { getLogger } from "../lib/logger.js";
import { getCurrentTraceId } from "../lib/trace-context.js";
import type { LearnedRules } from "../shared/types.js";

const log = getLogger("audit");

export const DEFAULT_RETIREMENT_THRESHOLD = 0.4;
const DEFAULT_PROBATION_TASKS = 5;

/**
 * Check if agent should be retired based on EMA score.
 * Returns the diagnostic report if retired, undefined otherwise.
 */
export function checkRetirement(
  roleId: string,
  emaScore: number,
  threshold = DEFAULT_RETIREMENT_THRESHOLD,
): DiagnosticReport | undefined {
  if (emaScore >= threshold) return undefined;

  const agent = getRole(roleId);
  if (!agent || agent.status === "retired" || agent.status === "dead") return undefined;

  log.warn({ roleId, emaScore, threshold }, "Agent EMA below threshold, retiring");

  // Generate diagnostic
  const report = generateDiagnosticReport(roleId);

  // Apply targeted learnedRules modification (D-003: not full reset)
  const oldRules = JSON.stringify(agent.learnedRules);
  const updatedRules = applyDiagnosticRecommendations(agent.learnedRules, report);

  // Retire agent
  updateRole(roleId, {
    status: "retired",
    learnedRules: updatedRules,
  });

  // Audit — include diagnostic summary for UI visibility
  const diagnosticSummary = [
    ...report.failureBehaviors.map(f => `${f.category}: ${f.count} occurrences`),
    ...report.rootCauses.map(c => `Root cause: ${c}`),
    ...report.recommendations.map(r => `Recommendation [${r.action}]: ${r.detail}`),
  ].join("\n");
  const rulesDiff = generateDiff(oldRules, JSON.stringify(updatedRules));

  createEvolutionAudit({
    timestamp: Date.now(),
    oldRules,
    newRules: JSON.stringify(updatedRules),
    diff: diagnosticSummary
      ? `--- Diagnostic Report ---\n${diagnosticSummary}\n\n--- Rules Diff ---\n${rulesDiff}`
      : rulesDiff,
    roleId: roleId,
    source: "audit",
    traceId: getCurrentTraceId(),
  });

  log.info({
    roleId,
    oldRulesCount: agent.learnedRules.stylePreferences.length + agent.learnedRules.avoidedActions.length,
    newRulesCount: updatedRules.stylePreferences.length + updatedRules.avoidedActions.length,
    recommendations: report.recommendations.length,
  }, "Agent retired with targeted learnedRules modification");

  return report;
}

/**
 * Reinstate a retired agent into probation (D-003).
 */
export function reinstateAgent(roleId: string): boolean {
  const agent = getRole(roleId);
  if (!agent || agent.status !== "retired") return false;

  updateRole(roleId, { status: "probation" });

  createEvolutionAudit({
    timestamp: Date.now(),
    oldRules: "status: retired",
    newRules: "status: probation",
    diff: "- status: retired\n+ status: probation",
    roleId: roleId,
    source: "audit",
    traceId: getCurrentTraceId(),
  });

  log.info({ roleId }, "Agent reinstated to probation");
  return true;
}

/**
 * Check if probation agent should graduate to active (D-003).
 */
export function checkProbationGraduation(
  roleId: string,
  emaScore: number,
  threshold = DEFAULT_RETIREMENT_THRESHOLD,
  probationTasks = DEFAULT_PROBATION_TASKS,
): boolean {
  const agent = getRole(roleId);
  if (!agent || agent.status !== "probation") return false;

  // Count tasks completed during probation
  const recentScores = getScoresByRole(roleId, probationTasks + 1);
  if (recentScores.length < probationTasks) return false;

  if (emaScore >= threshold) {
    updateRole(roleId, { status: "active" });

    createEvolutionAudit({
      timestamp: Date.now(),
      oldRules: "status: probation",
      newRules: "status: idle",
      diff: `- status: probation\n+ status: idle (graduated, EMA: ${emaScore.toFixed(3)})`,
      roleId: roleId,
      source: "audit",
      traceId: getCurrentTraceId(),
    });

    log.info({ roleId, emaScore }, "Agent graduated from probation to active");
    return true;
  }

  return false;
}

/**
 * Apply diagnostic recommendations to learnedRules (D-003: targeted modification).
 * Adds recommended rules to avoidedActions, does NOT remove existing rules wholesale.
 */
function applyDiagnosticRecommendations(
  existingRules: LearnedRules,
  report: DiagnosticReport,
): LearnedRules {
  const newAvoidedActions = [...existingRules.avoidedActions];

  for (const rec of report.recommendations) {
    const ruleText = `[audit:${rec.action}] ${rec.detail}`;
    if (!newAvoidedActions.includes(ruleText)) {
      newAvoidedActions.push(ruleText);
    }
  }

  // Add failure summary rule
  if (report.failureBehaviors.length > 0) {
    const summaryParts = report.failureBehaviors.map(f => `${f.category}(${f.count})`);
    const summaryRule = `[audit:diagnostic] Failure patterns detected: ${summaryParts.join(", ")}. Review and adjust behavior accordingly.`;
    if (!newAvoidedActions.includes(summaryRule)) {
      newAvoidedActions.push(summaryRule);
    }
  }

  return {
    stylePreferences: existingRules.stylePreferences,
    avoidedActions: newAvoidedActions,
    pinnedParameters: existingRules.pinnedParameters,
  };
}
