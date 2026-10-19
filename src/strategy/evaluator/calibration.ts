import { listMetricsByGoal, updateMetricNode } from "../../store/metrics.js";
import { getDb } from "../../store/db.js";
import { v4 as uuidv4 } from "uuid";
import { getLogger } from "../../lib/logger.js";
import type { MetricNode, MetricLevel } from "../../shared/types.js";

const log = getLogger("agent");

export interface CalibrationResult {
  goalId: string;
  computedAt: number;
  l0Score: number;
  l1Trend: number;
  l2Trend: number;
  l3Trend: number;
  factors: Record<MetricLevel, number>;
  applied: boolean;
}

/**
 * Calibration Engine - adjusts L2/L3 metric weights based on L0/L1 trends.
 * Crystal ref: D-013
 *
 * If L0 improving but L3 declining → decrease L3 calibration_factor
 * If L0 stable but L3 improving → increase L3 calibration_factor
 */
export class CalibrationEngine {
  /**
   * Compute calibration factors by comparing level scores.
   * @param goalId - Goal to calibrate
   * @param levelScores - Map of level → current raw score (from collectors)
   * @param l0GrowthRate - L0 growth rate from L1 metrics
   */
  static computeCalibrationFactors(
    goalId: string,
    levelScores: Record<MetricLevel, number>,
    l0GrowthRate = 0,
  ): CalibrationResult {
    const nodes = listMetricsByGoal(goalId);
    const currentFactors = this.getCurrentFactors(nodes);

    const newFactors: Record<MetricLevel, number> = { ...currentFactors };

    // L0 is the ground truth reference
    const l0Score = levelScores.L0;

    // Calibrate L1, L2, L3 relative to L0
    for (const level of ["L1", "L2", "L3"] as MetricLevel[]) {
      const levelScore = levelScores[level];
      const expected = l0Score * (1 + l0GrowthRate * this.getTimeLag(level));
      const gap = levelScore - expected;

      let factor = currentFactors[level];

      if (gap < -0.1) {
        factor *= 0.95; // level overestimates, reduce weight
      } else if (gap > 0.1) {
        factor *= 1.05; // level underestimates, increase weight
      }

      // Clamp to reasonable range
      newFactors[level] = Math.max(0.5, Math.min(1.5, factor));
    }

    return {
      goalId,
      computedAt: Date.now(),
      l0Score: levelScores.L0,
      l1Trend: levelScores.L1,
      l2Trend: levelScores.L2,
      l3Trend: levelScores.L3,
      factors: newFactors,
      applied: false,
    };
  }

  private static appendToHistory(result: CalibrationResult): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO calibration_history (id, goal_id, factors_json, l0_score, l1_trend, l2_trend, l3_trend, applied, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(),
        result.goalId,
        JSON.stringify(result.factors),
        result.l0Score,
        result.l1Trend,
        result.l2Trend,
        result.l3Trend,
        result.applied ? 1 : 0,
        result.computedAt,
      );
    } catch (err) {
      log.error({ error: err, goalId: result.goalId }, "Failed to persist calibration history");
    }
  }

  /**
   * Apply calibration factors to metric tree nodes and record the run.
   */
  static applyCalibration(goalId: string, result: CalibrationResult): void {
    const nodes = listMetricsByGoal(goalId);

    for (const node of nodes) {
      const newFactor = result.factors[node.level];
      if (newFactor !== undefined && newFactor !== node.calibrationFactor) {
        updateMetricNode(node.id, { calibrationFactor: newFactor });
      }
    }

    result.applied = true;
    this.appendToHistory(result);
  }

  /**
   * Get calibration history for a goal from SQLite.
   */
  static getCalibrationHistory(goalId: string): CalibrationResult[] {
    try {
      const db = getDb();
      const rows = db.prepare(
        "SELECT * FROM calibration_history WHERE goal_id = ? ORDER BY computed_at ASC",
      ).all(goalId) as Array<{
        goal_id: string; computed_at: number; l0_score: number;
        l1_trend: number; l2_trend: number; l3_trend: number;
        factors_json: string; applied: number;
      }>;
      return rows.map((row) => ({
        goalId: row.goal_id,
        computedAt: row.computed_at,
        l0Score: row.l0_score,
        l1Trend: row.l1_trend,
        l2Trend: row.l2_trend,
        l3Trend: row.l3_trend,
        factors: JSON.parse(row.factors_json),
        applied: row.applied === 1,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Clear calibration log (for testing).
   */
  static clearLog(): void {
    try {
      const db = getDb();
      db.prepare("DELETE FROM calibration_history").run();
    } catch {
      // Table may not exist in some test contexts
    }
  }

  /**
   * Check if recalibration is needed.
   */
  static shouldRecalibrate(
    goalId: string,
    lastCalibrationAt?: number,
    progressDelta = 0,
  ): boolean {
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;

    // Recalibrate if never calibrated
    if (!lastCalibrationAt) return true;

    // Recalibrate if > 7 days since last
    if (now - lastCalibrationAt > sevenDays) return true;

    // Recalibrate if significant progress change (> 20%)
    if (Math.abs(progressDelta) > 0.2) return true;

    return false;
  }

  private static getCurrentFactors(nodes: MetricNode[]): Record<MetricLevel, number> {
    const factors: Record<MetricLevel, number> = { L0: 1.0, L1: 1.0, L2: 1.0, L3: 1.0 };

    for (const node of nodes) {
      // Use the first node's factor per level as representative
      if (factors[node.level] === 1.0 && node.calibrationFactor !== 1.0) {
        factors[node.level] = node.calibrationFactor;
      }
    }

    return factors;
  }

  private static getTimeLag(level: MetricLevel): number {
    // Time lag multiplier: how much L0 growth rate should project
    switch (level) {
      case "L1": return 0.5;  // weekly lag
      case "L2": return 0.3;  // daily lag
      case "L3": return 0.1;  // instant lag
      default: return 0;
    }
  }
}
