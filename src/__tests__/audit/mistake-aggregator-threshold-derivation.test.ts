/**
 * Verifies the architectural link between the aggregator's EMA threshold and
 * the retirement system's retirement threshold.
 *
 * Context: mistake-aggregator.ts originally imported `DEFAULT_RETIREMENT_THRESHOLD`
 * from retirement.ts, but module-load-time coupling broke existing tests that
 * mock retirement.js without exporting the constant. The constant was inlined
 * with a comment; this test guards the design invariant: if retirement's
 * threshold moves, the aggregator's threshold must be recomputed.
 */
import { describe, it, expect } from "vitest";
import { MISTAKE_EMA_THRESHOLD } from "../../audit/mistake-aggregator.js";

describe("mistake-aggregator threshold derivation", () => {
  it("MISTAKE_EMA_THRESHOLD equals retirement threshold (0.4) + 0.1 buffer = 0.5", async () => {
    // Read the actual module (no mock) to catch drift if retirement.ts changes.
    const actual = await import("../../audit/retirement.js");
    const retirement = (actual as { DEFAULT_RETIREMENT_THRESHOLD?: number }).DEFAULT_RETIREMENT_THRESHOLD;
    expect(retirement).toBe(0.4);
    expect(MISTAKE_EMA_THRESHOLD).toBe(retirement! + 0.1);
    expect(MISTAKE_EMA_THRESHOLD).toBe(0.5);
  });
});
