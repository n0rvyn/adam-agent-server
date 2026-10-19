import { getTask } from "../../../store/tasks.js";
import { getStepLogs } from "../../../store/logs.js";
import type { Task, StepLog } from "../../../shared/types.js";

export interface L3Metrics {
  taskId: string;
  goalId?: string;
  timestamp: number;
  durationMs: number;
  costUsd: number;
  turns: number;
  toolCount: number;
  errorCount: number;
  approvalCount: number;
  rawScore: number;
  isComplete: boolean;
}

/**
 * L3 Collector - per-task instant metrics.
 * Crystal ref: D-012 (L3 = per-task metrics)
 */
export class L3Collector {
  static collect(taskId: string, goalId?: string): L3Metrics {
    const task = getTask(taskId);
    if (!task) {
      return this.emptyMetrics(taskId, goalId);
    }

    const logs = getStepLogs(taskId, 500, 0);

    const durationMs = (task.completedAt && task.startedAt)
      ? task.completedAt - task.startedAt
      : 0;

    const toolNames = new Set<string>();
    let errorCount = 0;
    let approvalCount = 0;

    for (const log of logs) {
      if (log.type === "tool_call" && log.toolName) {
        toolNames.add(log.toolName);
      }
      if (log.type === "error") {
        errorCount++;
      }
      if (log.type === "approval_request") {
        approvalCount++;
      }
    }

    const metrics: L3Metrics = {
      taskId,
      goalId,
      timestamp: Date.now(),
      durationMs,
      costUsd: task.costUsd ?? 0,
      turns: task.numTurns ?? 0,
      toolCount: toolNames.size,
      errorCount,
      approvalCount,
      rawScore: 0,
      isComplete: task.status === "completed",
    };

    metrics.rawScore = this.computeRawScore(metrics);
    return metrics;
  }

  /**
   * Compute normalized 0-1 score from L3 metrics.
   * Weighted: 0.3*duration + 0.2*cost + 0.2*turns + 0.1*tool + 0.15*error + 0.05*approval
   */
  static computeRawScore(m: L3Metrics): number {
    // Duration: faster is better, normalize to 10min max
    const maxDuration = 10 * 60 * 1000;
    const durationScore = 1 - Math.min(m.durationMs / maxDuration, 1);

    // Cost: lower is better, normalize to $5 max
    const maxCost = 5;
    const costScore = 1 - Math.min(m.costUsd / maxCost, 1);

    // Turns: fewer is better, normalize to 50 max
    const maxTurns = 50;
    const turnsScore = 1 - Math.min(m.turns / maxTurns, 1);

    // Tool count: optimal range 3-15
    let toolScore: number;
    if (m.toolCount >= 3 && m.toolCount <= 15) {
      toolScore = 1.0;
    } else if (m.toolCount < 3) {
      toolScore = m.toolCount / 3;
    } else {
      toolScore = Math.max(0, 1 - (m.toolCount - 15) / 15);
    }

    // Errors: zero is best
    const errorScore = m.errorCount === 0 ? 1.0 : Math.max(0, 1 - m.errorCount * 0.2);

    // Approvals: mild positive signal
    const approvalScore = Math.min(1, 0.5 + m.approvalCount * 0.25);

    return (
      0.30 * durationScore +
      0.20 * costScore +
      0.20 * turnsScore +
      0.10 * toolScore +
      0.15 * errorScore +
      0.05 * approvalScore
    );
  }

  // In-memory cache for recent L3 metrics (query interface)
  private static cache = new Map<string, L3Metrics>();

  /**
   * Persist metrics to in-memory cache for query by other collectors.
   */
  static persist(metrics: L3Metrics): void {
    this.cache.set(metrics.taskId, metrics);
  }

  /**
   * Query cached L3 metrics by taskId.
   */
  static getCached(taskId: string): L3Metrics | undefined {
    return this.cache.get(taskId);
  }

  /**
   * Clear cache (for testing).
   */
  static clearCache(): void {
    this.cache.clear();
  }

  private static emptyMetrics(taskId: string, goalId?: string): L3Metrics {
    return {
      taskId,
      goalId,
      timestamp: Date.now(),
      durationMs: 0,
      costUsd: 0,
      turns: 0,
      toolCount: 0,
      errorCount: 0,
      approvalCount: 0,
      rawScore: 0,
      isComplete: false,
    };
  }
}
