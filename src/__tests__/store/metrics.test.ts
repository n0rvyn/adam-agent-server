import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createGoal } from "../../store/goals.js";
import { createMetricNode, getMetricNode, updateMetricNode, listMetricsByGoal, listMetricsByParent, deleteMetricNode } from "../../store/metrics.js";
import type { Goal, MetricNode } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedGoal(): void {
  const goal: Goal = {
    id: "goal-1",
    name: "Test goal",
    roleId: "engineer",
    metricType: "test_coverage",
    targetValue: 80,
    currentValue: 40,
    deadline: Date.now() + 30 * 24 * 60 * 60 * 1000,
    budgetUsd: 50,
    status: "active",
    createdAt: Date.now(),
  };
  createGoal(goal);
}

function makeMetric(overrides: Partial<MetricNode> = {}): MetricNode {
  return {
    id: "metric-1",
    goalId: "goal-1",
    level: "L0",
    name: "Goal Progress",
    weight: 1.0,
    calibrationFactor: 1.0,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("store/metrics", () => {
  describe("createMetricNode", () => {
    it("should insert a metric node", () => {
      seedGoal();
      createMetricNode(makeMetric());
      const node = getMetricNode("metric-1");
      expect(node).toBeDefined();
      expect(node!.goalId).toBe("goal-1");
      expect(node!.level).toBe("L0");
      expect(node!.weight).toBe(1.0);
    });

    it("should enforce level CHECK constraint", () => {
      seedGoal();
      expect(() => createMetricNode(makeMetric({ level: "L5" as any }))).toThrow();
    });

    it("should enforce FK to goals", () => {
      expect(() => createMetricNode(makeMetric({ goalId: "nonexistent" }))).toThrow();
    });
  });

  describe("parent-child relationships", () => {
    it("should link parent and child metrics", () => {
      seedGoal();
      createMetricNode(makeMetric({ id: "m-l0", level: "L0" }));
      createMetricNode(makeMetric({ id: "m-l1", level: "L1", parentId: "m-l0" }));
      createMetricNode(makeMetric({ id: "m-l2", level: "L2", parentId: "m-l1" }));

      const children = listMetricsByParent("m-l0");
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe("m-l1");

      const grandchildren = listMetricsByParent("m-l1");
      expect(grandchildren).toHaveLength(1);
      expect(grandchildren[0].id).toBe("m-l2");
    });
  });

  describe("updateMetricNode", () => {
    it("should update calibration factor", () => {
      seedGoal();
      createMetricNode(makeMetric());
      updateMetricNode("metric-1", { calibrationFactor: 0.8 });
      const node = getMetricNode("metric-1");
      expect(node!.calibrationFactor).toBe(0.8);
    });

    it("should update weight", () => {
      seedGoal();
      createMetricNode(makeMetric());
      updateMetricNode("metric-1", { weight: 2.5 });
      const node = getMetricNode("metric-1");
      expect(node!.weight).toBe(2.5);
    });
  });

  describe("listMetricsByGoal", () => {
    it("should list all metrics for a goal ordered by level", () => {
      seedGoal();
      createMetricNode(makeMetric({ id: "m-l3", level: "L3" }));
      createMetricNode(makeMetric({ id: "m-l0", level: "L0" }));
      createMetricNode(makeMetric({ id: "m-l1", level: "L1" }));
      const metrics = listMetricsByGoal("goal-1");
      expect(metrics).toHaveLength(3);
      expect(metrics[0].level).toBe("L0");
      expect(metrics[1].level).toBe("L1");
      expect(metrics[2].level).toBe("L3");
    });
  });

  describe("deleteMetricNode", () => {
    it("should delete a metric node", () => {
      seedGoal();
      createMetricNode(makeMetric());
      deleteMetricNode("metric-1");
      expect(getMetricNode("metric-1")).toBeUndefined();
    });

    it("should SET NULL parent_id on child when parent deleted", () => {
      seedGoal();
      createMetricNode(makeMetric({ id: "parent", level: "L0" }));
      createMetricNode(makeMetric({ id: "child", level: "L1", parentId: "parent" }));
      deleteMetricNode("parent");
      const child = getMetricNode("child");
      expect(child).toBeDefined();
      expect(child!.parentId).toBeUndefined();
    });
  });
});
