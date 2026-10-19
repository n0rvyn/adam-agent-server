/**
 * Task 1-tests: deriveLedgerShapeRules — automatic shape rule derivation for
 * ledger steps (settlesPredictionsFor / publishesClaimsTo).
 *
 * Pre-impl: tests FAIL because `deriveLedgerShapeRules` is not exported from
 * `src/lib/resolve-contract-rules.ts` (TBD-impl step 5).
 *
 * Post-impl (Task 1-impl): all tests pass.
 */

import { describe, it, expect } from "vitest";
import { deriveLedgerShapeRules } from "../../lib/resolve-contract-rules.js";
import type { TaskStep } from "../../shared/types.js";

type StepShape = Pick<TaskStep, "outputContract" | "settlesPredictionsFor" | "publishesClaimsTo" | "outputAs">;

function step(s: Partial<StepShape> = {}): StepShape {
  return {
    outputContract: s.outputContract,
    settlesPredictionsFor: s.settlesPredictionsFor,
    publishesClaimsTo: s.publishesClaimsTo,
    outputAs: s.outputAs,
  };
}

describe("deriveLedgerShapeRules", () => {
  it("(a) step with settlesPredictionsFor + outputAs → returns one format=jsonArray rule", () => {
    const rules = deriveLedgerShapeRules(
      step({ settlesPredictionsFor: "podcast-show", outputAs: "verdicts" }),
    );
    expect(rules).toEqual([{ kind: "format", value: "jsonArray" }]);
  });

  it("(b) step with publishesClaimsTo + outputAs → returns one format=jsonArray rule", () => {
    const rules = deriveLedgerShapeRules(
      step({ publishesClaimsTo: "podcast-show", outputAs: "claims" }),
    );
    expect(rules).toEqual([{ kind: "format", value: "jsonArray" }]);
  });

  it("(c) step with neither ledger field → returns [] (no auto-injection)", () => {
    const rules = deriveLedgerShapeRules(
      step({ outputAs: "any-key" }),
    );
    expect(rules).toEqual([]);
  });

  it("(d) step with ledger field but no outputAs → returns [] (can't key-scope → skip)", () => {
    const rules = deriveLedgerShapeRules(
      step({ settlesPredictionsFor: "podcast-show" }),
    );
    expect(rules).toEqual([]);
  });

  it("(e) ledger step with outputContract already declaring format=json → derive does NOT add a second format=json rule (dedup with caller)", () => {
    // The execution-manager caller is responsible for de-dup:
    //   resolveContractRules(step) + deriveLedgerShapeRules(step)
    // with a .filter() that strips the legacy `format=json` when ledger fields are set.
    // This test asserts the DERIVED function returns ONLY its one jsonArray rule —
    // the caller's de-dup logic is verified separately by inspecting the caller.
    const existing = [{ kind: "format", value: "json" }] as const;
    const rules = deriveLedgerShapeRules(
      step({
        settlesPredictionsFor: "podcast-show",
        outputAs: "verdicts",
        outputContract: { contractRules: [...existing] },
      }),
    );
    expect(rules).toEqual([{ kind: "format", value: "jsonArray" }]);
    // Sanity: the existing format=json rule does NOT show up in the derived result
    // (caller adds them together with a dedup filter; derive itself only emits the new rule).
    expect(rules).toHaveLength(1);
  });

  it("(f) step with both settlesPredictionsFor AND publishesClaimsTo → still one rule (idempotent)", () => {
    const rules = deriveLedgerShapeRules(
      step({
        settlesPredictionsFor: "podcast-show",
        publishesClaimsTo: "podcast-show",
        outputAs: "verdicts",
      }),
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({ kind: "format", value: "jsonArray" });
  });
});
