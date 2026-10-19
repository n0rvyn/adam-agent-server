import type { L2Metrics } from "./l2-collector.js";

export type TrendDirection = "improving" | "stable" | "declining";

export interface L1Metrics {
  weekStart: string;
  weekEnd: string;
  goalId?: string;
  tasksCompletedTotal: number;
  successRateAvg: number;
  avgDailyCost: number;
  avgDailyDuration: number;
  growthRate: number;
  variance: number;
  trend: TrendDirection;
  rawScore: number;
}

/**
 * L1 Collector - weekly trend metrics.
 * Crystal ref: D-012 (L1 = weekly trend metrics)
 */
export class L1Collector {
  /**
   * Aggregate L2 metrics for a week into L1 metrics.
   */
  static collectFromL2(l2Metrics: L2Metrics[], previousWeekL2?: L2Metrics[]): L1Metrics {
    if (l2Metrics.length === 0) {
      return this.emptyMetrics();
    }

    const dates = l2Metrics.map((m) => m.date).sort();
    const weekStart = dates[0];
    const weekEnd = dates[dates.length - 1];

    const tasksCompletedTotal = l2Metrics.reduce((sum, m) => sum + m.tasksCompleted, 0);
    const successRates = l2Metrics.map((m) => m.successRate);
    const successRateAvg = successRates.reduce((a, b) => a + b, 0) / successRates.length;

    const dailyCosts = l2Metrics.map((m) => m.totalCostUsd);
    const avgDailyCost = dailyCosts.reduce((a, b) => a + b, 0) / dailyCosts.length;

    const dailyDurations = l2Metrics.map((m) => m.avgDurationMs);
    const avgDailyDuration = dailyDurations.reduce((a, b) => a + b, 0) / dailyDurations.length;

    // Growth rate: compare with previous week
    let growthRate = 0;
    if (previousWeekL2 && previousWeekL2.length > 0) {
      const prevAvg = previousWeekL2.reduce((sum, m) => sum + m.successRate, 0) / previousWeekL2.length;
      growthRate = prevAvg > 0 ? (successRateAvg - prevAvg) / prevAvg : 0;
    }

    // Variance of daily success rates
    const variance = this.computeVariance(successRates);

    // Trend via linear regression slope
    const trend = this.calculateTrend(l2Metrics);

    const metrics: L1Metrics = {
      weekStart,
      weekEnd,
      goalId: l2Metrics[0].goalId,
      tasksCompletedTotal,
      successRateAvg,
      avgDailyCost,
      avgDailyDuration,
      growthRate,
      variance,
      trend,
      rawScore: 0,
    };

    metrics.rawScore = this.computeRawScore(metrics);
    return metrics;
  }

  /**
   * Compute normalized 0-1 score.
   * 0.4*successRateAvg + 0.35*growthRate + 0.25*variance
   */
  static computeRawScore(m: L1Metrics): number {
    const successScore = m.successRateAvg;

    // Growth rate: clip to -1..+1, shift to 0..1
    const growthScore = (Math.max(-1, Math.min(1, m.growthRate)) + 1) / 2;

    // Variance: lower is better, normalize to max 0.25
    const varianceScore = 1 - Math.min(m.variance / 0.25, 1);

    return (
      0.40 * successScore +
      0.35 * growthScore +
      0.25 * varianceScore
    );
  }

  /**
   * Calculate trend via linear regression on success rates.
   */
  static calculateTrend(l2Metrics: L2Metrics[]): TrendDirection {
    if (l2Metrics.length < 2) return "stable";

    const n = l2Metrics.length;
    const rates = l2Metrics.map((m) => m.successRate);

    // Simple linear regression: y = a + bx
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += rates[i];
      sumXY += i * rates[i];
      sumX2 += i * i;
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    if (slope > 0.02) return "improving";
    if (slope < -0.02) return "declining";
    return "stable";
  }

  private static computeVariance(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map((v) => (v - mean) ** 2);
    return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  }

  private static emptyMetrics(): L1Metrics {
    const now = new Date().toISOString().slice(0, 10);
    return {
      weekStart: now,
      weekEnd: now,
      tasksCompletedTotal: 0,
      successRateAvg: 0,
      avgDailyCost: 0,
      avgDailyDuration: 0,
      growthRate: 0,
      variance: 0,
      trend: "stable",
      rawScore: 0,
    };
  }
}
