import { describe, it, expect } from "vitest";
import { Reflexion } from "../../strategy/reflexion.js";
import type { Strategy } from "../../shared/types.js";

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: "test",
    roleId: "engineer",
    taskType: "coding",
    name: "test",
    promptTemplate: "Test template",
    alpha: 1,
    beta: 1,
    totalTrials: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("Reflexion", () => {
  describe("analyzeFailure()", () => {
    it("includes error in reflection", () => {
      const result = Reflexion.analyzeFailure(
        makeStrategy(),
        "Do the thing",
        "Error: something failed",
      );
      expect(result).toContain("Error: something failed");
    });

    it("includes partial result", () => {
      const result = Reflexion.analyzeFailure(
        makeStrategy(),
        "Do the thing",
        undefined,
        "Partial output here",
      );
      expect(result).toContain("Partial output here");
    });

    it("analyzes template for missing elements", () => {
      const result = Reflexion.analyzeFailure(
        makeStrategy({ promptTemplate: "Simple prompt with no keywords" }),
        "task",
      );
      expect(result).toContain("verification");
    });
  });

  describe("generateRetryPrompt()", () => {
    it("includes original prompt and reflection", () => {
      const result = Reflexion.generateRetryPrompt("Original task", "Analysis", 1);
      expect(result).toContain("Original task");
      expect(result).toContain("Analysis");
      expect(result).toContain("attempt #2");
    });

    it("increments attempt number", () => {
      const result = Reflexion.generateRetryPrompt("task", "analysis", 3);
      expect(result).toContain("attempt #4");
    });
  });

  describe("shouldRetry()", () => {
    it("returns true when reward below threshold", () => {
      expect(Reflexion.shouldRetry(0.3, 0.5)).toBe(true);
    });

    it("returns false when reward above threshold", () => {
      expect(Reflexion.shouldRetry(0.7, 0.5)).toBe(false);
    });

    it("returns false when reward equals threshold", () => {
      expect(Reflexion.shouldRetry(0.5, 0.5)).toBe(false);
    });
  });

  describe("calculateRetryReward()", () => {
    it("applies diminishing returns", () => {
      const original = 1.0;
      const r1 = Reflexion.calculateRetryReward(original, 1);
      const r2 = Reflexion.calculateRetryReward(original, 2);
      const r3 = Reflexion.calculateRetryReward(original, 3);

      expect(r1).toBeLessThanOrEqual(original);
      expect(r2).toBeLessThanOrEqual(r1);
      expect(r3).toBeLessThanOrEqual(r2);
    });

    it("first attempt has no penalty", () => {
      expect(Reflexion.calculateRetryReward(1.0, 1)).toBe(1.0);
    });
  });
});
