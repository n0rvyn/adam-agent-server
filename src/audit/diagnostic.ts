/**
 * Diagnostic report generation (D-002).
 * Triggered daily or when score drops below threshold.
 */

import { getScoresByRole } from "../store/role-scores.js";
import { getRole } from "../store/roles.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("audit");

export interface DiagnosticReport {
  roleId: string;
  agentName: string;
  period: { start: number; end: number };
  taskCount: number;
  avgScore: number;
  scoreHistory: number[];
  failureBehaviors: { category: string; count: number; examples: string[] }[];
  rootCauses: string[];
  recommendations: { action: "remove_rule" | "add_rule" | "adjust_permission"; detail: string }[];
}

/**
 * Generate diagnostic report for an agent based on recent scores.
 */
export function generateDiagnosticReport(roleId: string, lookbackDays = 7): DiagnosticReport {
  const agent = getRole(roleId);
  const scores = getScoresByRole(roleId, 100);
  const now = Date.now();
  const cutoff = now - lookbackDays * 24 * 60 * 60 * 1000;
  const recentScores = scores.filter(s => s.createdAt >= cutoff);

  const scoreHistory = recentScores.map(s => s.emaScore);
  const avgScore = recentScores.length > 0
    ? recentScores.reduce((sum, s) => sum + s.scores.weighted, 0) / recentScores.length
    : 1.0;

  // Classify failure behaviors
  const failureBehaviors: DiagnosticReport["failureBehaviors"] = [];

  const lowTaskSuccess = recentScores.filter(s => s.scores.taskSuccess < 0.5);
  if (lowTaskSuccess.length > 0) {
    failureBehaviors.push({
      category: "task_failures",
      count: lowTaskSuccess.length,
      examples: lowTaskSuccess.slice(0, 3).map(s => s.taskId),
    });
  }

  const lowPlanAccuracy = recentScores.filter(s => s.scores.planAccuracy < 0.5);
  if (lowPlanAccuracy.length > 0) {
    failureBehaviors.push({
      category: "plan_deviations",
      count: lowPlanAccuracy.length,
      examples: lowPlanAccuracy.slice(0, 3).map(s => s.taskId),
    });
  }

  const lowCompliance = recentScores.filter(s => s.scores.permissionCompliance < 0.8);
  if (lowCompliance.length > 0) {
    failureBehaviors.push({
      category: "permission_violations",
      count: lowCompliance.length,
      examples: lowCompliance.slice(0, 3).map(s => s.taskId),
    });
  }

  const lowEfficiency = recentScores.filter(s => s.scores.efficiency < 0.3);
  if (lowEfficiency.length > 0) {
    failureBehaviors.push({
      category: "inefficiency",
      count: lowEfficiency.length,
      examples: lowEfficiency.slice(0, 3).map(s => s.taskId),
    });
  }

  // Determine root causes and recommendations
  const rootCauses: string[] = [];
  const recommendations: DiagnosticReport["recommendations"] = [];

  if (lowTaskSuccess.length > recentScores.length * 0.3) {
    rootCauses.push("High task failure rate");
    recommendations.push({
      action: "add_rule",
      detail: "Add rule: verify task feasibility before execution",
    });
  }

  if (lowCompliance.length > 0) {
    rootCauses.push("Permission boundary violations");
    recommendations.push({
      action: "adjust_permission",
      detail: "Review and expand allowedTools if tasks legitimately need wider access",
    });
  }

  if (lowPlanAccuracy.length > recentScores.length * 0.5) {
    rootCauses.push("Frequent plan deviations");
    recommendations.push({
      action: "add_rule",
      detail: "Add rule: follow execution plan steps more closely, request plan revision if steps are unclear",
    });
  }

  log.info({
    roleId,
    taskCount: recentScores.length,
    avgScore: avgScore.toFixed(3),
    failureCategories: failureBehaviors.map(f => f.category),
  }, "Diagnostic report generated");

  return {
    roleId,
    agentName: agent?.name ?? "Unknown",
    period: { start: cutoff, end: now },
    taskCount: recentScores.length,
    avgScore,
    scoreHistory,
    failureBehaviors,
    rootCauses,
    recommendations,
  };
}
