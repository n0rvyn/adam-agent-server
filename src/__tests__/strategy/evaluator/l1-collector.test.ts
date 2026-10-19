import { describe, it, expect } from "vitest";
import { L1Collector } from "../../../strategy/evaluator/collectors/l1-collector.js";
import type { L2Metrics } from "../../../strategy/evaluator/collectors/l2-collector.js";

function makeL2(overrides: Partial<L2Metrics> = {}): L2Metrics {
  return {
    date: "2026-03-19", tasksCompleted: 5, tasksFailed: 1, successRate: 0.83,
    avgCostUsd: 0.5, avgDurationMs: 30000, totalCostUsd: 2.5,
    totalToolCount: 15, errorRate: 0.1, rawScore: 0.7, ...overrides,
  };
}

describe("L1Collector", () => {
  it("aggregates L2 metrics into weekly stats", () => {
    const l2s = [makeL2({ date: "2026-03-17" }), makeL2({ date: "2026-03-18" }), makeL2({ date: "2026-03-19" })];
    const m = L1Collector.collectFromL2(l2s);
    expect(m.tasksCompletedTotal).toBe(15);
    expect(m.successRateAvg).toBeCloseTo(0.83, 2);
    expect(m.weekStart).toBe("2026-03-17");
    expect(m.weekEnd).toBe("2026-03-19");
  });

  it("computes growth rate from previous week", () => {
    const current = [makeL2({ successRate: 0.9 })];
    const previous = [makeL2({ successRate: 0.7 })];
    const m = L1Collector.collectFromL2(current, previous);
    expect(m.growthRate).toBeGreaterThan(0);
  });

  it("returns empty metrics for no data", () => {
    const m = L1Collector.collectFromL2([]);
    expect(m.tasksCompletedTotal).toBe(0);
    expect(m.trend).toBe("stable");
  });

  it("calculates trend as improving for positive slope", () => {
    const l2s = [
      makeL2({ date: "2026-03-17", successRate: 0.5 }),
      makeL2({ date: "2026-03-18", successRate: 0.6 }),
      makeL2({ date: "2026-03-19", successRate: 0.7 }),
      makeL2({ date: "2026-03-20", successRate: 0.8 }),
    ];
    expect(L1Collector.calculateTrend(l2s)).toBe("improving");
  });

  it("calculates trend as declining for negative slope", () => {
    const l2s = [
      makeL2({ date: "2026-03-17", successRate: 0.9 }),
      makeL2({ date: "2026-03-18", successRate: 0.7 }),
      makeL2({ date: "2026-03-19", successRate: 0.5 }),
      makeL2({ date: "2026-03-20", successRate: 0.3 }),
    ];
    expect(L1Collector.calculateTrend(l2s)).toBe("declining");
  });

  it("computeRawScore returns 0-1", () => {
    const m = L1Collector.collectFromL2([makeL2()]);
    expect(m.rawScore).toBeGreaterThanOrEqual(0);
    expect(m.rawScore).toBeLessThanOrEqual(1);
  });
});
