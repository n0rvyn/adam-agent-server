/**
 * Task 1-tests: Pricing module tests.
 *
 * This file is written BEFORE the implementation exists; running it produces:
 *   Cannot find module '../../lib/cost-pricing.js'
 *
 * After Task 1-impl the full suite passes.
 */

import { describe, it, expect } from "vitest";
import { recomputeCost, validatePriceTable } from "../../lib/cost-pricing.js";
import type { PriceTable, CostRecompute } from "../../lib/cost-pricing.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const table: PriceTable = {
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cacheRead: 0.30,
    cacheCreation: 3.75,
    estimated: true,
  },
  // operator-set → no `estimated` flag → confirmed
  "MiniMax-M2.7-highspeed": {
    input: 0.26,
    output: 1.00,
    cacheRead: 0.26,
    cacheCreation: 0.26,
  },
};

const miniMaxUsage = {
  "MiniMax-M2.7-highspeed": {
    inputTokens: 117,
    outputTokens: 334,
    cacheReadInputTokens: 20081,
    cacheCreationInputTokens: 9086,
    costUSD: 0.075763,
    webSearchRequests: 0,
    contextWindow: 200000,
    maxOutputTokens: 32000,
  },
};

// ─── recomputeCost ────────────────────────────────────────────────────────────

describe("recomputeCost", () => {
  it("priced + confirmed: correct total, NOT equal to SDK number", () => {
    const result = recomputeCost(miniMaxUsage, table);

    // cost = 117/1e6*0.26 + 334/1e6*1.00 + 20081/1e6*0.26 + 9086/1e6*0.26
    const expected =
      (117 / 1e6) * 0.26 +
      (334 / 1e6) * 1.00 +
      (20081 / 1e6) * 0.26 +
      (9086 / 1e6) * 0.26;

    expect(result.costUsd).toBeCloseTo(expected, 10);
    // Must NOT equal the SDK number
    expect(result.costUsd).not.toBeCloseTo(0.075763, 5);

    const pm = result.perModel[0];
    expect(pm).toBeDefined();
    expect(pm.model).toBe("MiniMax-M2.7-highspeed");
    expect(pm.priced).toBe(true);
    expect(pm.estimated).toBe(false); // operator-set: no estimated flag
  });

  it("priced + estimated: perModel carries estimated=true", () => {
    const usage = {
      "claude-sonnet-4-6": {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.02,
      },
    };

    const result = recomputeCost(usage, table);
    expect(result.perModel[0].priced).toBe(true);
    expect(result.perModel[0].estimated).toBe(true);
  });

  it("unknown: key absent from table → priced=false, contributes 0, in unknownModels", () => {
    const usage = {
      "unknown-model-xyz": {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.1,
      },
    };

    const result = recomputeCost(usage, table);
    expect(result.perModel[0].priced).toBe(false);
    expect(result.perModel[0].costUsd).toBe(0);
    expect(result.unknownModels).toContain("unknown-model-xyz");
    expect(result.costUsd).toBe(0);
  });

  it("mixed: one priced + one absent → pricingStatus=partial, total=priced only", () => {
    const usage = {
      "MiniMax-M2.7-highspeed": {
        inputTokens: 100,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.05,
      },
      "no-such-model": {
        inputTokens: 200,
        outputTokens: 200,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.10,
      },
    };

    const result = recomputeCost(usage, table);
    expect(result.pricingStatus).toBe("partial");
    expect(result.unknownModels).toContain("no-such-model");
    // Only MiniMax-M2.7-highspeed contributes
    const pricedPm = result.perModel.find((p) => p.model === "MiniMax-M2.7-highspeed")!;
    expect(result.costUsd).toBeCloseTo(pricedPm.costUsd, 10);
  });

  it("all priced: pricingStatus=priced, unknownModels=[]", () => {
    const usage = {
      "MiniMax-M2.7-highspeed": {
        inputTokens: 100,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.05,
      },
      "claude-sonnet-4-6": {
        inputTokens: 200,
        outputTokens: 200,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.06,
      },
    };

    const result = recomputeCost(usage, table);
    expect(result.pricingStatus).toBe("priced");
    expect(result.unknownModels).toEqual([]);
  });

  it("empty modelUsage → costUsd=0, perModel=[], pricingStatus=none", () => {
    const result = recomputeCost({}, table);
    expect(result.costUsd).toBe(0);
    expect(result.perModel).toEqual([]);
    expect(result.pricingStatus).toBe("none");
    expect(result.unknownModels).toEqual([]);
  });

  it("sdkTotalCostUsd passthrough", () => {
    const result = recomputeCost(miniMaxUsage, table, 0.075763);
    expect(result.sdkTotalCostUsd).toBe(0.075763);
  });

  it("sdkTotalCostUsd absent → undefined", () => {
    const result = recomputeCost(miniMaxUsage, table);
    expect(result.sdkTotalCostUsd).toBeUndefined();
  });

  it("malformed token fields (undefined) → treated as 0, no throw", () => {
    const usage = {
      "MiniMax-M2.7-highspeed": {
        inputTokens: undefined as unknown as number,
        outputTokens: undefined as unknown as number,
        cacheReadInputTokens: undefined as unknown as number,
        cacheCreationInputTokens: undefined as unknown as number,
        costUSD: 0.01,
      },
    };

    let result: CostRecompute;
    expect(() => {
      result = recomputeCost(usage, table);
    }).not.toThrow();
    // All zero tokens → cost = 0
    expect(result!.costUsd).toBe(0);
    expect(result!.perModel[0].priced).toBe(true);
  });

  it("pricingStatus=unknown when all entries are unpriced", () => {
    const usage = {
      "no-such-model-a": {
        inputTokens: 100,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.01,
      },
      "no-such-model-b": {
        inputTokens: 100,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.01,
      },
    };

    const result = recomputeCost(usage, table);
    expect(result.pricingStatus).toBe("unknown");
    expect(result.unknownModels).toHaveLength(2);
  });

  it("perModel carries correct token counts", () => {
    const result = recomputeCost(miniMaxUsage, table);
    const pm = result.perModel[0];
    expect(pm.inputTokens).toBe(117);
    expect(pm.outputTokens).toBe(334);
    expect(pm.cacheReadTokens).toBe(20081);
    expect(pm.cacheCreationTokens).toBe(9086);
  });
});

// ─── validatePriceTable ───────────────────────────────────────────────────────

describe("validatePriceTable", () => {
  it("valid table → null (no error)", () => {
    const result = validatePriceTable({
      "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 3.75 },
    });
    expect(result).toBeNull();
  });

  it("valid table with estimated flag → null", () => {
    const result = validatePriceTable({
      "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 3.75, estimated: true },
    });
    expect(result).toBeNull();
  });

  it("valid table with estimated=false → null", () => {
    const result = validatePriceTable({
      "my-model": { input: 1, output: 2, cacheRead: 0.5, cacheCreation: 1, estimated: false },
    });
    expect(result).toBeNull();
  });

  it("non-object (null) → error", () => {
    const result = validatePriceTable(null);
    expect(result).not.toBeNull();
    expect(result).toContain("object");
  });

  it("non-object (array) → error", () => {
    const result = validatePriceTable([]);
    expect(result).not.toBeNull();
  });

  it("non-object (string) → error", () => {
    const result = validatePriceTable("oops");
    expect(result).not.toBeNull();
  });

  it("entry missing required 'output' key → error naming model and field", () => {
    const result = validatePriceTable({
      "my-model": { input: 1, cacheRead: 0.5, cacheCreation: 1 },
    });
    expect(result).not.toBeNull();
    expect(result).toContain("my-model");
    expect(result).toContain("output");
  });

  it("entry missing required 'input' key → error naming model and field", () => {
    const result = validatePriceTable({
      "my-model": { output: 2, cacheRead: 0.5, cacheCreation: 1 },
    });
    expect(result).not.toBeNull();
    expect(result).toContain("my-model");
    expect(result).toContain("input");
  });

  it("negative price → error", () => {
    const result = validatePriceTable({
      "my-model": { input: -1, output: 2, cacheRead: 0.5, cacheCreation: 1 },
    });
    expect(result).not.toBeNull();
  });

  it("non-finite price (Infinity) → error", () => {
    const result = validatePriceTable({
      "my-model": { input: Infinity, output: 2, cacheRead: 0.5, cacheCreation: 1 },
    });
    expect(result).not.toBeNull();
  });

  it("non-numeric price (string) → error", () => {
    const result = validatePriceTable({
      "my-model": { input: "oops", output: 2, cacheRead: 0.5, cacheCreation: 1 },
    });
    expect(result).not.toBeNull();
  });

  it("estimated present but non-boolean → error", () => {
    const result = validatePriceTable({
      "my-model": { input: 1, output: 2, cacheRead: 0.5, cacheCreation: 1, estimated: "yes" },
    });
    expect(result).not.toBeNull();
    expect(result).toContain("estimated");
  });

  it("zero prices allowed (free model)", () => {
    const result = validatePriceTable({
      "free-model": { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    });
    expect(result).toBeNull();
  });

  it("entry is not an object → error naming model", () => {
    const result = validatePriceTable({
      "bad-entry": "not-an-object",
    });
    expect(result).not.toBeNull();
    expect(result).toContain("bad-entry");
  });
});
