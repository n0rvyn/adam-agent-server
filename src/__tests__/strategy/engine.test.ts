import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { StrategyEngine } from "../../strategy/engine.js";
import { createGoal } from "../../store/goals.js";
import { updateStrategy } from "../../store/strategies.js";
import { listTrialsByStrategy } from "../../store/trials.js";
import type { Goal } from "../../shared/types.js";

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

describe("StrategyEngine", () => {
  describe("selectStrategy()", () => {
    it("returns null when no strategies exist", () => {
      expect(StrategyEngine.selectStrategy("engineer", "coding")).toBeNull();
    });

    it("returns a strategy when strategies exist", () => {
      const strategy = StrategyEngine.addStrategy("engineer", "coding", "test", "prompt");
      const result = StrategyEngine.selectStrategy("engineer", "coding");
      expect(result).not.toBeNull();
      expect(result?.id).toBe(strategy.id);
    });
  });

  describe("recordTrial()", () => {
    it("updates Beta distribution and creates trial record", () => {
      seedGoal();
      const strategy = StrategyEngine.addStrategy("engineer", "coding", "test", "prompt");

      StrategyEngine.recordTrial(strategy.id, "goal-1", undefined, 1.0, 0.9, 0.95, "Context");

      const updated = StrategyEngine.getStrategyById(strategy.id);
      expect(updated!.alpha).toBe(1.5); // 0.5 + 1.0
      expect(updated!.beta).toBe(0.5);  // 0.5 + 0
      expect(updated!.totalTrials).toBe(1);
      expect(updated!.avgReward).toBe(1.0);

      const trials = listTrialsByStrategy(strategy.id);
      expect(trials).toHaveLength(1);
      expect(trials[0].reward).toBe(1.0);
      expect(trials[0].metricL2Score).toBe(0.9);
    });

    it("correctly updates with partial reward", () => {
      seedGoal();
      const strategy = StrategyEngine.addStrategy("engineer", "coding", "test", "prompt");

      StrategyEngine.recordTrial(strategy.id, "goal-1", undefined, 0.5);

      const updated = StrategyEngine.getStrategyById(strategy.id);
      expect(updated!.alpha).toBe(1.0); // 0.5 + 0.5
      expect(updated!.beta).toBe(1.0);  // 0.5 + 0.5
    });
  });

  describe("addStrategy()", () => {
    it("creates strategy with Jeffreys prior (DP-002)", () => {
      const strategy = StrategyEngine.addStrategy("analyst", "research", "baseline", "prompt");
      expect(strategy.alpha).toBe(0.5);
      expect(strategy.beta).toBe(0.5);
      expect(strategy.totalTrials).toBe(0);
    });

    it("adds strategy to correct role/task_type", () => {
      StrategyEngine.addStrategy("engineer", "coding", "s1", "p1");
      StrategyEngine.addStrategy("engineer", "coding", "s2", "p2");
      StrategyEngine.addStrategy("analyst", "research", "s3", "p3");

      expect(StrategyEngine.getStrategies("engineer", "coding")).toHaveLength(2);
      expect(StrategyEngine.getStrategies("analyst", "research")).toHaveLength(1);
    });

    it("throws when population at maximum", () => {
      for (let i = 0; i < 20; i++) {
        StrategyEngine.addStrategy("engineer", "coding", `s-${i}`, `p-${i}`);
      }
      expect(() =>
        StrategyEngine.addStrategy("engineer", "coding", "s-21", "p-21"),
      ).toThrow(/maximum/);
    });
  });

  describe("getPopulationStats()", () => {
    it("returns zeros for empty population", () => {
      const stats = StrategyEngine.getPopulationStats("engineer", "coding");
      expect(stats.count).toBe(0);
      expect(stats.avgTrials).toBe(0);
    });

    it("calculates aggregate stats", () => {
      StrategyEngine.addStrategy("engineer", "coding", "s1", "p1");
      StrategyEngine.addStrategy("engineer", "coding", "s2", "p2");

      const stats = StrategyEngine.getPopulationStats("engineer", "coding");
      expect(stats.count).toBe(2);
    });
  });

  describe("shouldEvolve()", () => {
    it("returns true when below minimum", () => {
      expect(StrategyEngine.shouldEvolve("engineer", "coding")).toBe(true);
    });
  });

  describe("getTopStrategies()", () => {
    it("returns strategies sorted by average reward", () => {
      const s1 = StrategyEngine.addStrategy("engineer", "coding", "low", "p1");
      const s2 = StrategyEngine.addStrategy("engineer", "coding", "high", "p2");

      updateStrategy(s1.id, { avgReward: 0.3, totalTrials: 5 });
      updateStrategy(s2.id, { avgReward: 0.8, totalTrials: 5 });

      const top = StrategyEngine.getTopStrategies("engineer", "coding", 2);
      expect(top[0].id).toBe(s2.id);
      expect(top[1].id).toBe(s1.id);
    });
  });

  describe("getSamplingProbabilities()", () => {
    it("returns probability map for strategies", () => {
      StrategyEngine.addStrategy("engineer", "coding", "s1", "p1");
      StrategyEngine.addStrategy("engineer", "coding", "s2", "p2");

      const probs = StrategyEngine.getSamplingProbabilities("engineer", "coding");
      expect(probs).toBeInstanceOf(Map);
      expect(probs.size).toBe(2);

      // Probabilities should sum to 1
      let sum = 0;
      for (const p of probs.values()) sum += p;
      expect(sum).toBeCloseTo(1.0, 5);
    });
  });

  describe("evaluateAndRecord()", () => {
    it("evaluates and records trial with reward", () => {
      const s = StrategyEngine.addStrategy("engineer", "eval-test", "eval-strat", "prompt");

      createGoal({
        id: "goal-eval",
        name: "Eval Goal",
        description: "test",
        roleId: "engineer",
        metricType: "composite",
        targetValue: 100,
        currentValue: 50,
        deadline: Date.now() + 86400000,
        budgetUsd: 10,
        status: "active",
        createdAt: Date.now(),
      });

      const reward = StrategyEngine.evaluateAndRecord(s.id, "goal-eval", undefined);
      expect(typeof reward).toBe("number");
    });
  });

  describe("shouldEvolve() edge cases", () => {
    it("returns false when at max strategies with no trials", () => {
      // Add MAX_STRATEGIES (20) strategies
      for (let i = 0; i < 20; i++) {
        StrategyEngine.addStrategy("engineer", "evolve-test", `s${i}`, `p${i}`);
      }
      expect(StrategyEngine.shouldEvolve("engineer", "evolve-test")).toBe(false);
    });

    it("returns true when below max with some trials", () => {
      const s = StrategyEngine.addStrategy("engineer", "evolve2", "s1", "p1");
      updateStrategy(s.id, { totalTrials: 3 });
      expect(StrategyEngine.shouldEvolve("engineer", "evolve2")).toBe(true);
    });
  });

  describe("getPopulationStats() with no rewards", () => {
    it("returns 0 avgReward when no strategies have rewards", () => {
      StrategyEngine.addStrategy("engineer", "stats-test", "s1", "p1");
      const stats = StrategyEngine.getPopulationStats("engineer", "stats-test");
      expect(stats.avgReward).toBe(0);
    });
  });
});
