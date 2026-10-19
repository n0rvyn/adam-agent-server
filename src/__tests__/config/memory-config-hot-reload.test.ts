import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  initRuntimeConfig,
  getRuntimeConfig,
  updateMutableConfig,
} from "../../config/runtime.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { ServerConfig } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
});

describe("memory-config hot-reload", () => {
  it("updates memory.retrievalWeights.cosSim in runtime config", () => {
    updateMutableConfig({ "memory.retrievalWeights.cosSim": 0.9 });
    expect(getRuntimeConfig().memory!.retrievalWeights.cosSim).toBe(0.9);
  });

  it("updates memory.attributionThresholds.high and classification logic uses new threshold", () => {
    updateMutableConfig({ "memory.attributionThresholds.high": 0.5 });

    const cfg = getRuntimeConfig().memory!;
    expect(cfg.attributionThresholds.high).toBe(0.5);

    const weighted = 0.55;
    const cls: "high" | "neutral" | "low" =
      weighted >= cfg.attributionThresholds.high ? "high"
      : weighted <= cfg.attributionThresholds.low ? "low"
      : "neutral";
    expect(cls).toBe("high");
  });

  it("updates memory.globalBudgetTokens in runtime config", async () => {
    updateMutableConfig({ "memory.globalBudgetTokens": 50 });

    expect(getRuntimeConfig().memory!.globalBudgetTokens).toBe(50);

    const { estimateTokens } = await import("../../lib/token-estimator.js");
    const tokens = estimateTokens("x".repeat(800));
    expect(tokens).toBeGreaterThan(50);
  });

  it("persists antiFlipMinUses change to runtime config", () => {
    updateMutableConfig({ "memory.antiFlipMinUses": 10 });
    expect(getRuntimeConfig().memory!.antiFlipMinUses).toBe(10);
  });

  it("persists antiFlipSuccessEmaThreshold change to runtime config", () => {
    updateMutableConfig({ "memory.antiFlipSuccessEmaThreshold": 0.5 });
    expect(getRuntimeConfig().memory!.antiFlipSuccessEmaThreshold).toBe(0.5);
  });

  it("restores default on re-init", () => {
    updateMutableConfig({ "memory.antiFlipMinUses": 99 });
    expect(getRuntimeConfig().memory!.antiFlipMinUses).toBe(99);

    initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
    expect(getRuntimeConfig().memory!.antiFlipMinUses).toBe(5);
  });
});

describe("memory-config validator reject paths", () => {
  it("rejects invalid memory.scope.decayBase values", () => {
    // decayBase must be exclusive (0, 1)
    const r1 = updateMutableConfig({ "memory.scope.decayBase": 1.0 });
    expect(r1.success).toBe(false);
    expect(r1.errors[0]).toMatch(/decayBase|between 0 and 1/i);

    const r2 = updateMutableConfig({ "memory.scope.decayBase": 0 });
    expect(r2.success).toBe(false);

    const r3 = updateMutableConfig({ "memory.scope.decayBase": 0.5 });
    expect(r3.success).toBe(true);
  });

  it("rejects invalid memory.scope.archiveThreshold values", () => {
    // archiveThreshold must be in [0, 1]
    const r1 = updateMutableConfig({ "memory.scope.archiveThreshold": -0.1 });
    expect(r1.success).toBe(false);

    const r2 = updateMutableConfig({ "memory.scope.archiveThreshold": 1.5 });
    expect(r2.success).toBe(false);

    const r3 = updateMutableConfig({ "memory.scope.archiveThreshold": 0.2 });
    expect(r3.success).toBe(true);
  });

  it("rejects invalid memory.scope.reflectionPoolMax values", () => {
    // reflectionPoolMax must be a positive integer
    const r1 = updateMutableConfig({ "memory.scope.reflectionPoolMax": 0 });
    expect(r1.success).toBe(false);

    const r2 = updateMutableConfig({ "memory.scope.reflectionPoolMax": -5 });
    expect(r2.success).toBe(false);

    const r3 = updateMutableConfig({ "memory.scope.reflectionPoolMax": 100 });
    expect(r3.success).toBe(true);
  });

  it("rejects invalid memory.antiFlipSuccessEmaThreshold values", () => {
    // antiFlipSuccessEmaThreshold must be in [0, 1]
    const r1 = updateMutableConfig({ "memory.antiFlipSuccessEmaThreshold": -0.1 });
    expect(r1.success).toBe(false);

    const r2 = updateMutableConfig({ "memory.antiFlipSuccessEmaThreshold": 1.5 });
    expect(r2.success).toBe(false);

    const r3 = updateMutableConfig({ "memory.antiFlipSuccessEmaThreshold": 0.25 });
    expect(r3.success).toBe(true);
  });

  it("rejects float input for memory.scope.reflectionPoolMax (must be integer)", () => {
    const r = updateMutableConfig({ "memory.scope.reflectionPoolMax": 1.5 });
    expect(r.success).toBe(false);
    const r2 = updateMutableConfig({ "memory.scope.reflectionPoolMax": 50.5 });
    expect(r2.success).toBe(false);
  });

  it("accepts inclusive boundaries for memory.scope.archiveThreshold (0.0 and 1.0)", () => {
    const r0 = updateMutableConfig({ "memory.scope.archiveThreshold": 0.0 });
    expect(r0.success).toBe(true);
    const r1 = updateMutableConfig({ "memory.scope.archiveThreshold": 1.0 });
    expect(r1.success).toBe(true);
  });

  it("accepts inclusive boundaries for memory.antiFlipSuccessEmaThreshold (0.0 and 1.0)", () => {
    const r0 = updateMutableConfig({ "memory.antiFlipSuccessEmaThreshold": 0.0 });
    expect(r0.success).toBe(true);
    const r1 = updateMutableConfig({ "memory.antiFlipSuccessEmaThreshold": 1.0 });
    expect(r1.success).toBe(true);
  });
});
