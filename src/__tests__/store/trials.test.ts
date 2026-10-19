import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createGoal } from "../../store/goals.js";
import { createStrategy } from "../../store/strategies.js";
import { createTask } from "../../store/tasks.js";
import { createTrial, getTrial, listTrialsByStrategy, listTrialsByGoal, listTrialsByTask } from "../../store/trials.js";
import type { Goal, Strategy, Trial, Task } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedDeps(): void {
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

  const strategy: Strategy = {
    id: "strat-1",
    roleId: "engineer",
    taskType: "unit_test",
    name: "Default",
    promptTemplate: "Write tests",
    alpha: 0.5,
    beta: 0.5,
    totalTrials: 0,
    createdAt: Date.now(),
  };
  createStrategy(strategy);
}

function makeTrial(overrides: Partial<Trial> = {}): Trial {
  return {
    id: "trial-1",
    strategyId: "strat-1",
    goalId: "goal-1",
    reward: 0.8,
    metricL2Score: 0.7,
    metricL3Score: 0.9,
    completedAt: Date.now(),
    ...overrides,
  };
}

describe("store/trials", () => {
  describe("createTrial", () => {
    it("should insert a trial", () => {
      seedDeps();
      createTrial(makeTrial());
      const trial = getTrial("trial-1");
      expect(trial).toBeDefined();
      expect(trial!.strategyId).toBe("strat-1");
      expect(trial!.goalId).toBe("goal-1");
      expect(trial!.reward).toBe(0.8);
      expect(trial!.metricL2Score).toBe(0.7);
      expect(trial!.metricL3Score).toBe(0.9);
    });

    it("should enforce FK to strategies", () => {
      seedDeps();
      expect(() => createTrial(makeTrial({ strategyId: "nonexistent" }))).toThrow();
    });

    it("should enforce FK to goals", () => {
      seedDeps();
      expect(() => createTrial(makeTrial({ goalId: "nonexistent" }))).toThrow();
    });

    it("should handle optional fields", () => {
      seedDeps();
      createTrial(makeTrial({ taskId: undefined, reward: undefined, context: undefined }));
      const trial = getTrial("trial-1");
      expect(trial!.taskId).toBeUndefined();
      expect(trial!.reward).toBeUndefined();
    });
  });

  describe("listTrialsByStrategy", () => {
    it("should list trials for a strategy", () => {
      seedDeps();
      createTrial(makeTrial({ id: "t1", completedAt: Date.now() }));
      createTrial(makeTrial({ id: "t2", completedAt: Date.now() + 1 }));
      const trials = listTrialsByStrategy("strat-1");
      expect(trials).toHaveLength(2);
      // DESC order
      expect(trials[0].id).toBe("t2");
    });
  });

  describe("listTrialsByGoal", () => {
    it("should list trials for a goal", () => {
      seedDeps();
      createTrial(makeTrial({ id: "t1" }));
      const trials = listTrialsByGoal("goal-1");
      expect(trials).toHaveLength(1);
    });
  });

  describe("listTrialsByTask", () => {
    it("should list trials for a task", () => {
      seedDeps();
      const taskBase: Task = {
        id: "task-abc",
        status: "completed",
        prompt: "test",
        config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
        createdAt: Date.now(),
      };
      createTask(taskBase);
      createTask({ ...taskBase, id: "task-xyz" });
      createTrial(makeTrial({ id: "t1", taskId: "task-abc" }));
      createTrial(makeTrial({ id: "t2", taskId: "task-abc" }));
      createTrial(makeTrial({ id: "t3", taskId: "task-xyz" }));
      const trials = listTrialsByTask("task-abc");
      expect(trials).toHaveLength(2);
    });
  });

  describe("cascade delete", () => {
    it("should cascade delete trials when strategy is deleted", () => {
      seedDeps();
      createTrial(makeTrial());
      const db = getTestDb();
      db.prepare("DELETE FROM strategies WHERE id = ?").run("strat-1");
      expect(getTrial("trial-1")).toBeUndefined();
    });

    it("should cascade delete trials when goal is deleted", () => {
      seedDeps();
      createTrial(makeTrial());
      const db = getTestDb();
      // Must delete strategy first (it also references goal via trials)
      db.prepare("DELETE FROM strategies WHERE id = ?").run("strat-1");
      db.prepare("DELETE FROM goals WHERE id = ?").run("goal-1");
      expect(getTrial("trial-1")).toBeUndefined();
    });
  });
});
