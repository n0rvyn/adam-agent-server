import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { L3Collector } from "../../../strategy/evaluator/collectors/l3-collector.js";
import { createTask } from "../../../store/tasks.js";
import { createStepLog } from "../../../store/logs.js";
import type { Task, StepLog } from "../../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedTask(overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: "task-1",
    status: "completed",
    prompt: "test",
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
    createdAt: Date.now() - 60000,
    startedAt: Date.now() - 50000,
    completedAt: Date.now(),
    costUsd: 0.5,
    numTurns: 10,
    totalDurationMs: 50000,
    ...overrides,
  };
  createTask(task);
  return task;
}

function seedLog(taskId: string, index: number, type: StepLog["type"], toolName?: string): void {
  createStepLog({
    id: `log-${taskId}-${index}`,
    taskId,
    index,
    type,
    content: "test",
    toolName,
    timestamp: Date.now(),
  });
}

describe("L3Collector", () => {
  describe("collect()", () => {
    it("collects metrics from completed task", () => {
      seedTask();
      seedLog("task-1", 0, "tool_call", "Read");
      seedLog("task-1", 1, "tool_call", "Write");
      seedLog("task-1", 2, "error");

      const m = L3Collector.collect("task-1");
      expect(m.taskId).toBe("task-1");
      expect(m.durationMs).toBe(50000);
      expect(m.costUsd).toBe(0.5);
      expect(m.turns).toBe(10);
      expect(m.toolCount).toBe(2); // Read, Write
      expect(m.errorCount).toBe(1);
      expect(m.isComplete).toBe(true);
    });

    it("returns empty metrics for non-existent task", () => {
      const m = L3Collector.collect("nonexistent");
      expect(m.isComplete).toBe(false);
      expect(m.durationMs).toBe(0);
    });

    it("counts unique tool names", () => {
      seedTask();
      seedLog("task-1", 0, "tool_call", "Read");
      seedLog("task-1", 1, "tool_call", "Read"); // duplicate
      seedLog("task-1", 2, "tool_call", "Bash");

      const m = L3Collector.collect("task-1");
      expect(m.toolCount).toBe(2); // Read, Bash
    });
  });

  describe("computeRawScore()", () => {
    it("returns 0-1 range", () => {
      const score = L3Collector.computeRawScore({
        taskId: "t1", timestamp: Date.now(), durationMs: 30000, costUsd: 0.5,
        turns: 5, toolCount: 5, errorCount: 0, approvalCount: 1,
        rawScore: 0, isComplete: true,
      });
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it("penalizes errors", () => {
      const noErrors = L3Collector.computeRawScore({
        taskId: "t1", timestamp: Date.now(), durationMs: 30000, costUsd: 0.5,
        turns: 5, toolCount: 5, errorCount: 0, approvalCount: 0,
        rawScore: 0, isComplete: true,
      });
      const withErrors = L3Collector.computeRawScore({
        taskId: "t2", timestamp: Date.now(), durationMs: 30000, costUsd: 0.5,
        turns: 5, toolCount: 5, errorCount: 3, approvalCount: 0,
        rawScore: 0, isComplete: true,
      });
      expect(noErrors).toBeGreaterThan(withErrors);
    });

    it("penalizes high cost", () => {
      const lowCost = L3Collector.computeRawScore({
        taskId: "t1", timestamp: Date.now(), durationMs: 30000, costUsd: 0.1,
        turns: 5, toolCount: 5, errorCount: 0, approvalCount: 0,
        rawScore: 0, isComplete: true,
      });
      const highCost = L3Collector.computeRawScore({
        taskId: "t2", timestamp: Date.now(), durationMs: 30000, costUsd: 4.5,
        turns: 5, toolCount: 5, errorCount: 0, approvalCount: 0,
        rawScore: 0, isComplete: true,
      });
      expect(lowCost).toBeGreaterThan(highCost);
    });
  });
});
