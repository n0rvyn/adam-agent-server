/**
 * reflection-budget.ts — shared budget resolver for the reflection pipeline.
 *
 * Used by `reflection.ts` (belief synthesis Haiku call) and `conflict-resolver.ts`
 * (merge/supersede/coexist classifier). Extracted to its own module so the two
 * sibling files can both depend on the resolver without forming a circular
 * import (`reflection.ts` already imports `resolveBeliefConflict` from
 * `conflict-resolver.ts`).
 */

import { getRuntimeConfig } from "../config/runtime.js";

const DEFAULT_REFLECTION_MAX_BUDGET_USD = 5.0;

/**
 * Resolve the per-Haiku-call USD budget for the reflection pipeline.
 * Reads `memory.reflection.maxBudgetUsd` from the runtime config; falls back
 * to 5.0 when the config tree is missing or the value is not a positive finite
 * number.
 */
export function resolveReflectionBudgetUsd(): number {
  try {
    const v = getRuntimeConfig().memory?.reflection?.maxBudgetUsd;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  } catch {
    // Runtime config is not initialized in some unit tests.
  }
  return DEFAULT_REFLECTION_MAX_BUDGET_USD;
}
