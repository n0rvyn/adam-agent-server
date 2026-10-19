/**
 * Task 1: cost.dailyThresholdUsd — config layer validator tests.
 * Verifies: validator rejects bad values, accepts valid ones;
 * isMutablePath returns true; DEFAULT_CONFIG seeds 0.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { initRuntimeConfig, isMutablePath, updateMutableConfig, getRuntimeConfig } from "../../config/runtime.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { ServerConfig } from "../../shared/types.js";

beforeEach(() => {
  initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
});

describe("cost.dailyThresholdUsd config layer", () => {
  it("is in MUTABLE_PATHS", () => {
    expect(isMutablePath("cost.dailyThresholdUsd")).toBe(true);
  });

  it("DEFAULT_CONFIG seeds dailyThresholdUsd = 0", () => {
    expect(DEFAULT_CONFIG.cost?.dailyThresholdUsd).toBe(0);
  });

  it("getRuntimeConfig().cost.dailyThresholdUsd is 0 by default", () => {
    expect(getRuntimeConfig().cost?.dailyThresholdUsd).toBe(0);
  });

  describe("validator accepts valid values", () => {
    it("accepts 0 (disabled)", () => {
      const result = updateMutableConfig({ "cost.dailyThresholdUsd": 0 });
      expect(result.errors).toHaveLength(0);
      expect(result.updated).toContain("cost.dailyThresholdUsd");
    });

    it("accepts 0.5", () => {
      const result = updateMutableConfig({ "cost.dailyThresholdUsd": 0.5 });
      expect(result.errors).toHaveLength(0);
    });

    it("accepts 100", () => {
      const result = updateMutableConfig({ "cost.dailyThresholdUsd": 100 });
      expect(result.errors).toHaveLength(0);
      expect(getRuntimeConfig().cost?.dailyThresholdUsd).toBe(100);
    });
  });

  describe("validator rejects invalid values", () => {
    it("rejects -1 (negative)", () => {
      const result = updateMutableConfig({ "cost.dailyThresholdUsd": -1 });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("cost.dailyThresholdUsd");
    });

    it("rejects NaN", () => {
      const result = updateMutableConfig({ "cost.dailyThresholdUsd": NaN });
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects Infinity", () => {
      const result = updateMutableConfig({ "cost.dailyThresholdUsd": Infinity });
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects string '5'", () => {
      const result = updateMutableConfig({ "cost.dailyThresholdUsd": "5" });
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects null", () => {
      const result = updateMutableConfig({ "cost.dailyThresholdUsd": null });
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects undefined", () => {
      const result = updateMutableConfig({ "cost.dailyThresholdUsd": undefined });
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
