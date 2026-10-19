import { listTasksByDateRange } from "../../../store/tasks.js";
import { L3Collector } from "./l3-collector.js";
import type { L3Metrics } from "./l3-collector.js";

export interface L2Metrics {
  date: string;
  goalId?: string;
  tasksCompleted: number;
  tasksFailed: number;
  successRate: number;
  avgCostUsd: number;
  avgDurationMs: number;
  totalCostUsd: number;
  totalToolCount: number;
  errorRate: number;
  rawScore: number;
}

/**
 * L2 Collector - daily aggregated metrics.
 * Crystal ref: D-012 (L2 = daily process metrics)
 */
export class L2Collector {
  static collect(date: string | Date, goalId?: string): L2Metrics {
    const d = typeof date === "string" ? new Date(date) : date;
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000 - 1;

    const completed = listTasksByDateRange("completed", dayStart, dayEnd);
    const failed = listTasksByDateRange("failed", dayStart, dayEnd);

    const total = completed.length + failed.length;
    const successRate = total > 0 ? completed.length / total : 0;

    const costs = completed.map((t) => t.costUsd ?? 0);
    const durations = completed.map((t) => t.totalDurationMs ?? 0);
    const totalCostUsd = costs.reduce((a, b) => a + b, 0);
    const avgCostUsd = costs.length > 0 ? totalCostUsd / costs.length : 0;
    const avgDurationMs = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;

    // Count errors and tools from L3 metrics
    let totalErrors = 0;
    let totalToolCount = 0;
    for (const task of completed) {
      const l3 = L3Collector.collect(task.id, goalId);
      totalErrors += l3.errorCount;
      totalToolCount += l3.toolCount;
    }
    const errorRate = total > 0 ? totalErrors / total : 0;

    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const metrics: L2Metrics = {
      date: dateStr,
      goalId,
      tasksCompleted: completed.length,
      tasksFailed: failed.length,
      successRate,
      avgCostUsd,
      avgDurationMs,
      totalCostUsd,
      totalToolCount,
      errorRate,
      rawScore: 0,
    };

    metrics.rawScore = this.computeRawScore(metrics);
    return metrics;
  }

  /**
   * Aggregate L3 metrics into L2 for a specific date.
   */
  static aggregateFromL3(l3Metrics: L3Metrics[]): L2Metrics {
    if (l3Metrics.length === 0) {
      return {
        date: new Date().toISOString().slice(0, 10),
        tasksCompleted: 0,
        tasksFailed: 0,
        successRate: 0,
        avgCostUsd: 0,
        avgDurationMs: 0,
        totalCostUsd: 0,
        totalToolCount: 0,
        errorRate: 0,
        rawScore: 0,
      };
    }

    const completed = l3Metrics.filter((m) => m.isComplete);
    const total = l3Metrics.length;
    const successRate = total > 0 ? completed.length / total : 0;

    const costs = l3Metrics.map((m) => m.costUsd);
    const durations = l3Metrics.map((m) => m.durationMs);
    const totalCostUsd = costs.reduce((a, b) => a + b, 0);
    const avgCostUsd = costs.length > 0 ? totalCostUsd / costs.length : 0;
    const avgDurationMs = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;

    const totalErrors = l3Metrics.reduce((sum, m) => sum + m.errorCount, 0);
    const totalToolCount = l3Metrics.reduce((sum, m) => sum + m.toolCount, 0);
    const errorRate = total > 0 ? totalErrors / total : 0;

    const metrics: L2Metrics = {
      date: new Date(l3Metrics[0].timestamp).toISOString().slice(0, 10),
      tasksCompleted: completed.length,
      tasksFailed: total - completed.length,
      successRate,
      avgCostUsd,
      avgDurationMs,
      totalCostUsd,
      totalToolCount,
      errorRate,
      rawScore: 0,
    };

    metrics.rawScore = this.computeRawScore(metrics);
    return metrics;
  }

  /**
   * Compute normalized 0-1 score.
   * 0.4*successRate + 0.2*avgCost + 0.2*avgDuration + 0.1*tasksCompleted + 0.1*errorRate
   */
  static computeRawScore(m: L2Metrics): number {
    const successScore = m.successRate;
    const costScore = 1 - Math.min(m.avgCostUsd / 10, 1);
    const durationScore = 1 - Math.min(m.avgDurationMs / (8 * 60 * 60 * 1000), 1);
    const completedScore = Math.min(1, Math.log2(m.tasksCompleted + 1) / 5);
    const errorScore = 1 - Math.min(m.errorRate, 1);

    return (
      0.40 * successScore +
      0.20 * costScore +
      0.20 * durationScore +
      0.10 * completedScore +
      0.10 * errorScore
    );
  }
}
