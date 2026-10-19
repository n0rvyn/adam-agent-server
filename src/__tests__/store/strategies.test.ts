import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createStrategy, getStrategy, updateStrategy, listStrategiesByRole, listStrategiesByTaskType, deleteStrategy, betaUpdate } from "../../store/strategies.js";
import type { Strategy } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: "strat-1",
    roleId: "engineer",
    taskType: "unit_test",
    name: "Default test strategy",
    promptTemplate: "Write unit tests for the given module",
    alpha: 0.5,
    beta: 0.5,
    totalTrials: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("store/strategies", () => {
  describe("createStrategy", () => {
    it("should insert a strategy with Jeffreys prior", () => {
      createStrategy(makeStrategy());
      const s = getStrategy("strat-1");
      expect(s).toBeDefined();
      expect(s!.roleId).toBe("engineer");
      expect(s!.taskType).toBe("unit_test");
      expect(s!.alpha).toBe(0.5);
      expect(s!.beta).toBe(0.5);
      expect(s!.totalTrials).toBe(0);
    });

    it("should enforce unique index on (role, task_type, name)", () => {
      createStrategy(makeStrategy());
      expect(() => createStrategy(makeStrategy({ id: "strat-2" }))).toThrow();
    });

    it("should allow same name with different task_type", () => {
      createStrategy(makeStrategy());
      createStrategy(makeStrategy({ id: "strat-2", taskType: "refactor" }));
      expect(getStrategy("strat-2")).toBeDefined();
    });
  });

  describe("betaUpdate", () => {
    it("should increase alpha on success", () => {
      createStrategy(makeStrategy());
      betaUpdate("strat-1", 1.0);
      const s = getStrategy("strat-1");
      expect(s!.alpha).toBe(1.5); // 0.5 + 1.0
      expect(s!.beta).toBe(0.5);  // 0.5 + 0
      expect(s!.totalTrials).toBe(1);
      expect(s!.avgReward).toBe(1.0);
    });

    it("should increase beta on failure", () => {
      createStrategy(makeStrategy());
      betaUpdate("strat-1", 0.0);
      const s = getStrategy("strat-1");
      expect(s!.alpha).toBe(0.5);  // 0.5 + 0
      expect(s!.beta).toBe(1.5);   // 0.5 + 1.0
      expect(s!.totalTrials).toBe(1);
      expect(s!.avgReward).toBe(0.0);
    });

    it("should update running average reward", () => {
      createStrategy(makeStrategy());
      betaUpdate("strat-1", 0.8);
      betaUpdate("strat-1", 0.6);
      const s = getStrategy("strat-1");
      expect(s!.totalTrials).toBe(2);
      expect(s!.avgReward).toBeCloseTo(0.7, 5);
    });

    it("should handle partial reward (0.5)", () => {
      createStrategy(makeStrategy());
      betaUpdate("strat-1", 0.5);
      const s = getStrategy("strat-1");
      expect(s!.alpha).toBe(1.0);  // 0.5 + 0.5
      expect(s!.beta).toBe(1.0);   // 0.5 + 0.5
    });
  });

  describe("listStrategiesByRole", () => {
    it("should list strategies by role", () => {
      createStrategy(makeStrategy({ id: "s1", name: "S1" }));
      createStrategy(makeStrategy({ id: "s2", name: "S2", taskType: "refactor" }));
      createStrategy(makeStrategy({ id: "s3", roleId: "analyst", name: "S3", taskType: "research" }));
      const engineers = listStrategiesByRole("engineer");
      expect(engineers).toHaveLength(2);
    });
  });

  describe("listStrategiesByTaskType", () => {
    it("should list strategies by role and task type", () => {
      createStrategy(makeStrategy({ id: "s1", name: "Strategy A" }));
      createStrategy(makeStrategy({ id: "s2", name: "Strategy B" }));
      createStrategy(makeStrategy({ id: "s3", name: "Strategy C", taskType: "refactor" }));
      const strategies = listStrategiesByTaskType("engineer", "unit_test");
      expect(strategies).toHaveLength(2);
      const refactorStrategies = listStrategiesByTaskType("engineer", "refactor");
      expect(refactorStrategies).toHaveLength(1);
    });
  });

  describe("updateStrategy", () => {
    it("should update prompt template", () => {
      createStrategy(makeStrategy());
      updateStrategy("strat-1", { promptTemplate: "New prompt", updatedAt: Date.now() });
      const s = getStrategy("strat-1");
      expect(s!.promptTemplate).toBe("New prompt");
      expect(s!.updatedAt).toBeDefined();
    });
  });

  describe("deleteStrategy", () => {
    it("should delete a strategy", () => {
      createStrategy(makeStrategy());
      deleteStrategy("strat-1");
      expect(getStrategy("strat-1")).toBeUndefined();
    });
  });
});
