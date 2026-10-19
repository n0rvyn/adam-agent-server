/**
 * Task 1-tests: checkSettlementCompleteness — pure helper for D-022 invariant.
 *
 * Compares `due` count (from findDuePredictions snapshot) vs `settled` count
 * (from settle helper's settled field). If due>0 and settled<due, the calling
 * site records an audit_violation. This helper does NO DB I/O — it's a pure
 * function over two numbers.
 *
 * Pre-impl: tests FAIL because `checkSettlementCompleteness` is not exported from
 * `src/agent/belief-ledger.ts` (TBD-impl step 8).
 *
 * Post-impl (Task 1-impl): all tests pass.
 */

import { describe, it, expect } from "vitest";
import { checkSettlementCompleteness } from "../../agent/belief-ledger.js";

describe("checkSettlementCompleteness (gate 2 pure helper)", () => {
  it("(a) due=0, settled=0 → complete:true (0-due correct output, no violation)", () => {
    const r = checkSettlementCompleteness({ due: 0, settled: 0 });
    expect(r).toEqual({ complete: true, shortfall: 0 });
  });

  it("(b) due=2, settled=2 → complete:true (D-022 satisfied)", () => {
    const r = checkSettlementCompleteness({ due: 2, settled: 2 });
    expect(r).toEqual({ complete: true, shortfall: 0 });
  });

  it("(c) due=2, settled=0 → complete:false, shortfall=2 (LLM emitted [] when due>0)", () => {
    const r = checkSettlementCompleteness({ due: 2, settled: 0 });
    expect(r.complete).toBe(false);
    expect(r.shortfall).toBe(2);
  });

  it("(d) due=2, settled=1 → complete:false, shortfall=1 (partial settle)", () => {
    const r = checkSettlementCompleteness({ due: 2, settled: 1 });
    expect(r.complete).toBe(false);
    expect(r.shortfall).toBe(1);
  });

  it("(e) due=0, settled=1 → complete:true (settled>=due; shouldn't occur, but doesn't false-alarm)", () => {
    // Defensive: the helper clamps at 0 shortfall, so settled>due (extra work, not
    // a violation) is treated as complete. D-022 doesn't have a "settled too much"
    // failure mode.
    const r = checkSettlementCompleteness({ due: 0, settled: 1 });
    expect(r).toEqual({ complete: true, shortfall: 0 });
  });

  it("(f) due=3, settled=0 → complete:false, shortfall=3 (3 due, 0 settled)", () => {
    const r = checkSettlementCompleteness({ due: 3, settled: 0 });
    expect(r.complete).toBe(false);
    expect(r.shortfall).toBe(3);
  });
});
