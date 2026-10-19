import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));

import { L0Collector } from "../../../strategy/evaluator/collectors/l0-collector.js";
import { createGoal } from "../../../store/goals.js";
import type { Goal } from "../../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedGoal(overrides: Partial<Goal> = {}): Goal {
  const goal: Goal = {
    id: "goal-1", name: "Test", roleId: "engineer", metricType: "coverage",
    targetValue: 100, currentValue: 50,
    deadline: Date.now() + 30 * 24 * 60 * 60 * 1000,
    budgetUsd: 100, status: "active",
    createdAt: Date.now() - 7 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
  createGoal(goal);
  return goal;
}

describe("L0Collector", () => {
  it("collects goal progress metrics", () => {
    seedGoal();
    const m = L0Collector.collect("goal-1");
    expect(m.progressPct).toBeCloseTo(0.5, 1);
    expect(m.deadlineRemainingDays).toBeGreaterThan(25);
    expect(m.budgetRemainingPct).toBeGreaterThanOrEqual(0);
  });

  it("returns empty for non-existent goal", () => {
    const m = L0Collector.collect("nonexistent");
    expect(m.progressPct).toBe(0);
  });

  it("caps progressPct at 1.0", () => {
    seedGoal({ currentValue: 150, targetValue: 100 });
    const m = L0Collector.collect("goal-1");
    expect(m.progressPct).toBe(1);
  });

  it("handles zero targetValue", () => {
    seedGoal({ targetValue: 0 });
    const m = L0Collector.collect("goal-1");
    expect(m.progressPct).toBe(0);
  });

  it("computeRawScore returns 0-1", () => {
    seedGoal();
    const m = L0Collector.collect("goal-1");
    expect(m.rawScore).toBeGreaterThanOrEqual(0);
    expect(m.rawScore).toBeLessThanOrEqual(1);
  });

  it("calculateExpectedCompletion returns ratio of progress/time", () => {
    const goal = seedGoal();
    const result = L0Collector.calculateExpectedCompletion(goal);
    expect(result).toBeGreaterThanOrEqual(0);
  });
});
