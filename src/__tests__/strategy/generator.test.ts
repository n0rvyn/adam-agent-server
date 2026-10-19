import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { StrategyGenerator } from "../../strategy/generator.js";
import { StrategyEngine } from "../../strategy/engine.js";
import { createGoal } from "../../store/goals.js";
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

describe("StrategyGenerator", () => {
  describe("generateVariants()", () => {
    it("creates baseline when no strategies exist", async () => {
      const variants = await StrategyGenerator.generateVariants("engineer", "coding", 3, 1);

      expect(variants).toHaveLength(1);
      expect(variants[0]).toContain("baseline");

      const strategies = StrategyEngine.getStrategies("engineer", "coding");
      expect(strategies).toHaveLength(1);
      expect(strategies[0].promptTemplate).toContain("engineer");
    });

    it("creates evolved variants from top strategies", async () => {
      seedGoal();
      StrategyEngine.addStrategy("engineer", "coding", "baseline", "You are a coding agent.");
      const s = StrategyEngine.getStrategies("engineer", "coding")[0];
      StrategyEngine.recordTrial(s.id, "goal-1", undefined, 0.9);

      const variants = await StrategyGenerator.generateVariants("engineer", "coding", 1, 1);

      expect(variants).toHaveLength(1);
      const strategies = StrategyEngine.getStrategies("engineer", "coding");
      expect(strategies).toHaveLength(2);
    });
  });

  describe("generateBaselinePrompt()", () => {
    it("includes role and task type", () => {
      const prompt = StrategyGenerator.generateBaselinePrompt("engineer", "coding");
      expect(prompt).toContain("engineer");
      expect(prompt).toContain("coding");
    });
  });

  describe("generateWithLLM()", () => {
    it("returns placeholder response for Phase 5", async () => {
      const result = await StrategyGenerator.generateWithLLM("engineer", "coding", []);
      expect(result.rationale).toContain("Phase 5");
      expect(result.promptTemplate.length).toBeGreaterThan(0);
    });
  });
});
