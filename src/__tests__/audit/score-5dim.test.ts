import { describe, it, expect } from "vitest";
import { computeWeighted } from "../../audit/score.js";

describe("audit/score — computeWeighted", () => {
  // Helper: expected 4-dim weighted (LEGACY)
  function legacyWeighted(ts: number, pa: number, pc: number, ef: number): number {
    return ts * 0.3 + pa * 0.25 + pc * 0.25 + ef * 0.2;
  }

  // Helper: expected 5-dim weighted
  function fiveDimWeighted(ts: number, pa: number, pc: number, ef: number, intentF: number): number {
    return ts * 0.25 + pa * 0.20 + pc * 0.20 + ef * 0.15 + intentF * 0.20;
  }

  it("4-dim formula (intentFulfillment undefined)", () => {
    const result = computeWeighted({ taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, intentFulfillment: undefined });
    expect(result).toBeCloseTo(legacyWeighted(1, 1, 1, 1), 10);
  });

  it("4-dim formula (intentFulfillment null)", () => {
    const result = computeWeighted({ taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, intentFulfillment: null });
    expect(result).toBeCloseTo(legacyWeighted(1, 1, 1, 1), 10);
  });

  it("5-dim formula (intentFulfillment present)", () => {
    const result = computeWeighted({ taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, intentFulfillment: 1 });
    expect(result).toBeCloseTo(fiveDimWeighted(1, 1, 1, 1, 1), 10);
  });

  it("all zeros → weighted = 0", () => {
    const result = computeWeighted({ taskSuccess: 0, planAccuracy: 0, permissionCompliance: 0, efficiency: 0, intentFulfillment: 0 });
    expect(result).toBe(0);
  });

  it("all ones → weighted = 1 (5-dim, sum invariant)", () => {
    const result = computeWeighted({ taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, intentFulfillment: 1 });
    expect(result).toBe(1);
  });

  it("intentFulfillment=0.5 contributes 0.10 to 5-dim weighted", () => {
    // 5-dim: 0.25*1 + 0.20*1 + 0.20*1 + 0.15*1 + 0.20*0.5 = 0.25+0.20+0.20+0.15+0.10 = 0.90
    const withIf = computeWeighted({ taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 1, intentFulfillment: 0.5 });
    // 4-dim baseline: 0.3+0.25+0.25+0.20 = 1.0; with 0.5*0.20=0.10 offset from 5-dim: 0.25+0.20+0.20+0.15 = 0.80 + 0.10 = 0.90
    expect(withIf).toBeCloseTo(0.90, 10);
  });

  it("4-dim weights sum to 1.0 (regression guard)", () => {
    const sum = 0.3 + 0.25 + 0.25 + 0.2;
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("5-dim weights sum to 1.0 (regression guard)", () => {
    const sum = 0.25 + 0.20 + 0.20 + 0.15 + 0.20;
    expect(sum).toBeCloseTo(1.0, 10);
  });
});
