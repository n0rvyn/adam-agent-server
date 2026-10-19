import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createGoal, getGoal, updateGoal, listGoals, deleteGoal } from "../../store/goals.js";
import type { Goal } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    name: "Grow X followers",
    description: "Reach 1000 followers on X within 1 month",
    roleId: "content_creator",
    metricType: "follower_count",
    targetValue: 1000,
    currentValue: 0,
    deadline: Date.now() + 30 * 24 * 60 * 60 * 1000,
    budgetUsd: 100,
    status: "active",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("store/goals", () => {
  describe("createGoal", () => {
    it("should insert a goal", () => {
      createGoal(makeGoal());
      const goal = getGoal("goal-1");
      expect(goal).toBeDefined();
      expect(goal!.id).toBe("goal-1");
      expect(goal!.name).toBe("Grow X followers");
      expect(goal!.roleId).toBe("content_creator");
      expect(goal!.metricType).toBe("follower_count");
      expect(goal!.targetValue).toBe(1000);
      expect(goal!.currentValue).toBe(0);
      expect(goal!.status).toBe("active");
    });

    it("should throw on duplicate id", () => {
      createGoal(makeGoal());
      expect(() => createGoal(makeGoal())).toThrow();
    });

    it("should handle optional description as undefined", () => {
      createGoal(makeGoal({ description: undefined }));
      const goal = getGoal("goal-1");
      expect(goal!.description).toBeUndefined();
    });
  });

  describe("getGoal", () => {
    it("should return undefined for non-existent goal", () => {
      expect(getGoal("non-existent")).toBeUndefined();
    });
  });

  describe("updateGoal", () => {
    it("should update currentValue", () => {
      createGoal(makeGoal());
      updateGoal("goal-1", { currentValue: 250, updatedAt: Date.now() });
      const goal = getGoal("goal-1");
      expect(goal!.currentValue).toBe(250);
      expect(goal!.updatedAt).toBeDefined();
    });

    it("should update status", () => {
      createGoal(makeGoal());
      updateGoal("goal-1", { status: "paused" });
      const goal = getGoal("goal-1");
      expect(goal!.status).toBe("paused");
    });

    it("should no-op on empty updates", () => {
      createGoal(makeGoal());
      updateGoal("goal-1", {});
      const goal = getGoal("goal-1");
      expect(goal!.name).toBe("Grow X followers");
    });
  });

  describe("listGoals", () => {
    it("should list all goals", () => {
      createGoal(makeGoal({ id: "goal-1" }));
      createGoal(makeGoal({ id: "goal-2", name: "Test coverage" }));
      const goals = listGoals();
      expect(goals).toHaveLength(2);
    });

    it("should filter by status", () => {
      createGoal(makeGoal({ id: "goal-1", status: "active" }));
      createGoal(makeGoal({ id: "goal-2", status: "completed" }));
      const active = listGoals("active");
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe("goal-1");
    });

    it("should respect limit and offset", () => {
      for (let i = 0; i < 5; i++) {
        createGoal(makeGoal({ id: `goal-${i}`, createdAt: Date.now() + i }));
      }
      const page = listGoals(undefined, 2, 1);
      expect(page).toHaveLength(2);
    });
  });

  describe("deleteGoal", () => {
    it("should delete a goal", () => {
      createGoal(makeGoal());
      deleteGoal("goal-1");
      expect(getGoal("goal-1")).toBeUndefined();
    });
  });
});
