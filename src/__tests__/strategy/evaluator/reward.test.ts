import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { calculateReward, calculateFullReward, evaluate } from "../../../strategy/evaluator/reward.js";
import { createGoal } from "../../../store/goals.js";
import { createTask } from "../../../store/tasks.js";
import { createStepLog } from "../../../store/logs.js";
import type { Goal, Task } from "../../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedGoal(): void {
  const goal: Goal = {
    id: "goal-1",
    name: "Test",
    roleId: "engineer",
    metricType: "coverage",
    targetValue: 80,
    currentValue: 40,
    deadline: Date.now() + 30 * 24 * 60 * 60 * 1000,
    budgetUsd: 100,
    status: "active",
    createdAt: Date.now() - 7 * 24 * 60 * 60 * 1000,
  };
  createGoal(goal);
}

function seedCompletedTask(): void {
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
  };
  createTask(task);
  createStepLog({ id: "log-1", taskId: "task-1", index: 0, type: "tool_call", content: "test", toolName: "Read", timestamp: Date.now() });
}

describe("calculateReward", () => {
  it("returns reward for goal with completed task (objective)", () => {
    seedGoal();
    seedCompletedTask();
    const result = calculateReward("goal-1", "task-1");
    expect(result.reward).toBeGreaterThan(0);
    expect(result.reward).toBeLessThanOrEqual(1);
    expect(result.source).toBe("objective");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("returns fallback reward for goal without task", () => {
    seedGoal();
    const result = calculateReward("goal-1");
    expect(result.reward).toBeGreaterThanOrEqual(0);
    expect(result.source).toBe("fallback");
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("returns llm_judge for non-existent task (fallback path)", () => {
    seedGoal();
    const result = calculateReward("goal-1", "nonexistent");
    // Non-existent task: shouldUseObjective returns false → LLM Judge path
    expect(result.source).toBe("llm_judge");
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("includes breakdown by level", () => {
    seedGoal();
    seedCompletedTask();
    const result = calculateReward("goal-1", "task-1");
    expect(result.breakdown).toBeDefined();
    expect(result.breakdown.L0).toBeGreaterThanOrEqual(0);
    expect(result.breakdown.L3).toBeGreaterThanOrEqual(0);
  });
});

describe("calculateFullReward", () => {
  it("returns objective reward with multi-level scores", () => {
    seedGoal();
    const scores = new Map<string, number>();
    const result = calculateFullReward("goal-1", scores);
    expect(result.source).toBe("objective");
    expect(result.confidence).toBe(0.85);
    expect(typeof result.reward).toBe("number");
    expect(result.breakdown.L0).toBeDefined();
  });
});

describe("evaluate (async)", () => {
  it("returns objective result when L3 is complete", async () => {
    seedGoal();
    seedCompletedTask();
    const result = await evaluate("task-1", "goal-1");
    expect(result.goalId).toBe("goal-1");
    expect(result.taskId).toBe("task-1");
    expect(typeof result.reward).toBe("number");
  });

  it("falls back to LLM judge when L3 incomplete", async () => {
    seedGoal();
    // No completed task - L3 will be incomplete
    const result = await evaluate("nonexistent-task", "goal-1", "quality");
    expect(["objective", "llm_judge"]).toContain(result.source);
    expect(typeof result.reward).toBe("number");
  });
});
