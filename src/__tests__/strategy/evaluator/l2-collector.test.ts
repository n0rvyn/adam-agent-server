import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { L2Collector } from "../../../strategy/evaluator/collectors/l2-collector.js";
import type { L3Metrics } from "../../../strategy/evaluator/collectors/l3-collector.js";
import { createTask, updateTask } from "../../../store/tasks.js";
import { createStepLog } from "../../../store/logs.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function makeL3(overrides: Partial<L3Metrics> = {}): L3Metrics {
  return {
    taskId: "t1", timestamp: Date.now(), durationMs: 30000, costUsd: 0.5,
    turns: 5, toolCount: 3, errorCount: 0, approvalCount: 0,
    rawScore: 0.8, isComplete: true, ...overrides,
  };
}

describe("L2Collector", () => {
  describe("aggregateFromL3()", () => {
    it("aggregates L3 metrics into daily stats", () => {
      const l3s = [makeL3(), makeL3({ taskId: "t2", costUsd: 1.0 })];
      const m = L2Collector.aggregateFromL3(l3s);
      expect(m.tasksCompleted).toBe(2);
      expect(m.totalCostUsd).toBeCloseTo(1.5, 5);
      expect(m.avgCostUsd).toBeCloseTo(0.75, 5);
    });

    it("calculates success rate correctly", () => {
      const l3s = [
        makeL3({ isComplete: true }),
        makeL3({ taskId: "t2", isComplete: true }),
        makeL3({ taskId: "t3", isComplete: false }),
      ];
      const m = L2Collector.aggregateFromL3(l3s);
      expect(m.successRate).toBeCloseTo(2 / 3, 2);
    });

    it("includes totalToolCount", () => {
      const l3s = [makeL3({ toolCount: 5 }), makeL3({ taskId: "t2", toolCount: 3 })];
      const m = L2Collector.aggregateFromL3(l3s);
      expect(m.totalToolCount).toBe(8);
    });

    it("returns empty for no metrics", () => {
      const m = L2Collector.aggregateFromL3([]);
      expect(m.tasksCompleted).toBe(0);
      expect(m.rawScore).toBe(0);
    });

    it("computeRawScore returns 0-1", () => {
      const m = L2Collector.aggregateFromL3([makeL3()]);
      expect(m.rawScore).toBeGreaterThanOrEqual(0);
      expect(m.rawScore).toBeLessThanOrEqual(1);
    });
  });

  describe("collect()", () => {
    it("collects daily metrics from DB tasks", () => {
      const now = Date.now();
      const today = new Date(now);

      // Create completed task for today
      createTask({
        id: "t-today",
        status: "pending",
        prompt: "test",
        config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
        createdAt: now - 10000,
      });
      updateTask("t-today", {
        status: "completed",
        completedAt: now,
        costUsd: 0.5,
        totalDurationMs: 30000,
        numTurns: 5,
      });
      createStepLog({ id: "log-1", taskId: "t-today", index: 0, type: "tool_call", content: "test", toolName: "Read", timestamp: now });

      const metrics = L2Collector.collect(today);
      expect(metrics.tasksCompleted).toBe(1);
      expect(metrics.successRate).toBe(1);
      expect(metrics.totalCostUsd).toBeCloseTo(0.5, 2);
      expect(metrics.rawScore).toBeGreaterThan(0);
    });

    it("handles string date input", () => {
      const metrics = L2Collector.collect("2025-01-01");
      expect(metrics.tasksCompleted).toBe(0);
      expect(metrics.date).toBe("2025-01-01");
    });

    it("includes failed tasks in stats", () => {
      const now = Date.now();
      const today = new Date(now);

      createTask({
        id: "t-fail",
        status: "pending",
        prompt: "test",
        config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
        createdAt: now - 10000,
      });
      updateTask("t-fail", { status: "failed", completedAt: now });

      const metrics = L2Collector.collect(today);
      expect(metrics.tasksFailed).toBe(1);
      expect(metrics.successRate).toBe(0);
    });

    it("accepts goalId parameter", () => {
      const metrics = L2Collector.collect(new Date(), "goal-123");
      expect(metrics.goalId).toBe("goal-123");
    });
  });

  describe("computeRawScore edge cases", () => {
    it("handles high cost correctly", () => {
      const score = L2Collector.computeRawScore({
        date: "2025-01-01", tasksCompleted: 10, tasksFailed: 0, successRate: 1.0,
        avgCostUsd: 15, avgDurationMs: 1000, totalCostUsd: 150, totalToolCount: 50, errorRate: 0, rawScore: 0,
      });
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it("handles zero tasks correctly", () => {
      const score = L2Collector.computeRawScore({
        date: "2025-01-01", tasksCompleted: 0, tasksFailed: 0, successRate: 0,
        avgCostUsd: 0, avgDurationMs: 0, totalCostUsd: 0, totalToolCount: 0, errorRate: 0, rawScore: 0,
      });
      expect(score).toBeGreaterThanOrEqual(0);
    });
  });
});
