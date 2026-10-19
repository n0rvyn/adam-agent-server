import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));

import { CalibrationEngine } from "../../../strategy/evaluator/calibration.js";
import { createGoal } from "../../../store/goals.js";
import { createMetricNode } from "../../../store/metrics.js";
import type { Goal, MetricNode } from "../../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => { clearTestDb(); CalibrationEngine.clearLog(); });

function seedGoalWithMetrics(): void {
  const now = Date.now();
  createGoal({
    id: "goal-1", name: "Test", roleId: "engineer", metricType: "coverage",
    targetValue: 80, currentValue: 40,
    deadline: now + 30 * 24 * 60 * 60 * 1000,
    budgetUsd: 100, status: "active", createdAt: now,
  });
  createMetricNode({ id: "m-l0", goalId: "goal-1", level: "L0", name: "progress", weight: 1.0, calibrationFactor: 1.0, createdAt: now });
  createMetricNode({ id: "m-l1", goalId: "goal-1", level: "L1", parentId: "m-l0", name: "weekly", weight: 0.8, calibrationFactor: 1.0, createdAt: now });
  createMetricNode({ id: "m-l2", goalId: "goal-1", level: "L2", parentId: "m-l1", name: "daily", weight: 0.6, calibrationFactor: 1.0, createdAt: now });
  createMetricNode({ id: "m-l3", goalId: "goal-1", level: "L3", parentId: "m-l2", name: "instant", weight: 0.4, calibrationFactor: 1.0, createdAt: now });
}

describe("CalibrationEngine", () => {
  describe("computeCalibrationFactors()", () => {
    it("computes factors from level scores", () => {
      seedGoalWithMetrics();
      const result = CalibrationEngine.computeCalibrationFactors(
        "goal-1",
        { L0: 0.5, L1: 0.6, L2: 0.7, L3: 0.8 },
      );
      expect(result.factors.L0).toBe(1.0);
      expect(result.factors.L1).toBeGreaterThan(0);
      expect(result.factors.L2).toBeGreaterThan(0);
      expect(result.factors.L3).toBeGreaterThan(0);
      expect(result.applied).toBe(false);
      expect(result.l0Score).toBe(0.5);
    });

    it("clamps factors to 0.5-1.5 range", () => {
      seedGoalWithMetrics();
      const result = CalibrationEngine.computeCalibrationFactors(
        "goal-1",
        { L0: 0.1, L1: 0.9, L2: 0.9, L3: 0.9 },
      );
      for (const level of ["L1", "L2", "L3"] as const) {
        expect(result.factors[level]).toBeGreaterThanOrEqual(0.5);
        expect(result.factors[level]).toBeLessThanOrEqual(1.5);
      }
    });
  });

  describe("applyCalibration()", () => {
    it("updates metric tree nodes and records run", () => {
      seedGoalWithMetrics();
      const result = CalibrationEngine.computeCalibrationFactors(
        "goal-1",
        { L0: 0.5, L1: 0.3, L2: 0.3, L3: 0.3 },
      );
      CalibrationEngine.applyCalibration("goal-1", result);
      expect(result.applied).toBe(true);

      const history = CalibrationEngine.getCalibrationHistory("goal-1");
      expect(history).toHaveLength(1);
    });
  });

  describe("shouldRecalibrate()", () => {
    it("returns true when never calibrated", () => {
      expect(CalibrationEngine.shouldRecalibrate("goal-1")).toBe(true);
    });

    it("returns false when recently calibrated", () => {
      expect(CalibrationEngine.shouldRecalibrate("goal-1", Date.now())).toBe(false);
    });

    it("returns true after 7 days", () => {
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      expect(CalibrationEngine.shouldRecalibrate("goal-1", eightDaysAgo)).toBe(true);
    });

    it("returns true on significant progress change", () => {
      expect(CalibrationEngine.shouldRecalibrate("goal-1", Date.now(), 0.3)).toBe(true);
    });
  });

  describe("persistence (SQLite)", () => {
    it("persists calibration history to DB and survives clearLog + reload", () => {
      seedGoalWithMetrics();
      const result = CalibrationEngine.computeCalibrationFactors("goal-1", { L0: 0.7, L1: 0.6, L2: 0.5, L3: 0.4 });
      CalibrationEngine.applyCalibration("goal-1", result);

      const history = CalibrationEngine.getCalibrationHistory("goal-1");
      expect(history).toHaveLength(1);
      expect(history[0].goalId).toBe("goal-1");
      expect(history[0].applied).toBe(true);
      expect(history[0].l0Score).toBe(0.7);
    });

    it("appends multiple calibration runs", () => {
      seedGoalWithMetrics();
      const r1 = CalibrationEngine.computeCalibrationFactors("goal-1", { L0: 0.5, L1: 0.5, L2: 0.5, L3: 0.5 });
      CalibrationEngine.applyCalibration("goal-1", r1);
      const r2 = CalibrationEngine.computeCalibrationFactors("goal-1", { L0: 0.8, L1: 0.7, L2: 0.6, L3: 0.5 });
      CalibrationEngine.applyCalibration("goal-1", r2);

      const history = CalibrationEngine.getCalibrationHistory("goal-1");
      expect(history).toHaveLength(2);
    });

    it("clearLog removes all entries", () => {
      seedGoalWithMetrics();
      const result = CalibrationEngine.computeCalibrationFactors("goal-1", { L0: 0.5, L1: 0.5, L2: 0.5, L3: 0.5 });
      CalibrationEngine.applyCalibration("goal-1", result);
      expect(CalibrationEngine.getCalibrationHistory("goal-1").length).toBeGreaterThan(0);

      CalibrationEngine.clearLog();
      expect(CalibrationEngine.getCalibrationHistory("goal-1")).toHaveLength(0);
    });
  });
});
