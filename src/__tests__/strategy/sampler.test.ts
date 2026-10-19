import { describe, it, expect } from "vitest";
import { ThompsonSampler } from "../../strategy/sampler.js";
import type { Strategy } from "../../shared/types.js";

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: "test-1",
    roleId: "engineer",
    taskType: "coding",
    name: "test",
    promptTemplate: "test",
    alpha: 1,
    beta: 1,
    totalTrials: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("ThompsonSampler", () => {
  describe("sample()", () => {
    it("returns null for empty strategy array", () => {
      expect(ThompsonSampler.sample([])).toBeNull();
    });

    it("returns the only strategy when one exists", () => {
      const result = ThompsonSampler.sample([makeStrategy()]);
      expect(result).not.toBeNull();
      expect(result?.id).toBe("test-1");
    });

    it("favors high-reward strategy over time (statistical)", () => {
      const strategies: Strategy[] = [
        makeStrategy({ id: "high", alpha: 10, beta: 2, totalTrials: 10, avgReward: 0.83 }),
        makeStrategy({ id: "low", alpha: 2, beta: 10, totalTrials: 10, avgReward: 0.17 }),
      ];

      const probs = ThompsonSampler.getProbabilities(strategies, 5000);
      const highProb = probs.get("high") ?? 0;
      const lowProb = probs.get("low") ?? 0;

      expect(highProb).toBeGreaterThan(0.6);
      expect(lowProb).toBeLessThan(0.4);
      expect(highProb + lowProb).toBeCloseTo(1, 1);
    });

    it("handles Jeffreys prior (alpha=0.5, beta=0.5)", () => {
      const result = ThompsonSampler.sample([makeStrategy({ alpha: 0.5, beta: 0.5 })]);
      expect(result).not.toBeNull();
    });

    it("handles extreme Beta parameters", () => {
      const result = ThompsonSampler.sample([makeStrategy({ id: "extreme", alpha: 100, beta: 100 })]);
      expect(result).not.toBeNull();
    });

    it("with equal priors, selects each strategy roughly equally", () => {
      const strategies: Strategy[] = [
        makeStrategy({ id: "a", alpha: 1, beta: 1 }),
        makeStrategy({ id: "b", alpha: 1, beta: 1 }),
        makeStrategy({ id: "c", alpha: 1, beta: 1 }),
      ];

      const probs = ThompsonSampler.getProbabilities(strategies, 3000);
      for (const [, prob] of probs) {
        expect(prob).toBeGreaterThan(0.15);
        expect(prob).toBeLessThan(0.55);
      }
    });
  });

  describe("getProbabilities()", () => {
    it("returns empty map for empty array", () => {
      const probs = ThompsonSampler.getProbabilities([], 100);
      expect(probs.size).toBe(0);
    });

    it("probabilities sum to approximately 1", () => {
      const strategies: Strategy[] = [
        makeStrategy({ id: "a" }),
        makeStrategy({ id: "b" }),
        makeStrategy({ id: "c" }),
      ];

      const probs = ThompsonSampler.getProbabilities(strategies, 1000);
      const sum = Array.from(probs.values()).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 1);
    });
  });
});
