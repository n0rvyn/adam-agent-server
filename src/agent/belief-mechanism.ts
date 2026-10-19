/**
 * belief-mechanism.ts — Belief Evolution v3 core mechanics
 *
 * Provides lazy effective_ema computation, materialize-on-touch, fitness update,
 * archive threshold check, and soft-delete archive. All functions are pure relative
 * to the DB — they read/write via store functions, never accumulate local state.
 *
 * DP-002 Option B contract:
 *   - materializeOnTouch and applyFitnessUpdate do NOT touch inject_count.
 *   - Only selectInjectionBeliefs (belief-injection.ts) calls bumpInjectCount, strictly +1 per inject.
 */

import type { Belief } from "../shared/types.js";
import { getRuntimeConfig } from "../config/runtime.js";
import { setBeliefSuccessEmaAndSeq, updateBeliefStatus } from "../store/beliefs.js";

const DEFAULT_DECAY_BASE = 0.995;
const DEFAULT_ARCHIVE_THRESHOLD = 0.2;
const DEFAULT_EMA_ALPHA = 0.3;

function getMechanismConfig() {
  try {
    const cfg = getRuntimeConfig().memory?.scope;
    return {
      decayBase: (cfg as { decayBase?: number } | undefined)?.decayBase ?? DEFAULT_DECAY_BASE,
      archiveThreshold: (cfg as { archiveThreshold?: number } | undefined)?.archiveThreshold ?? DEFAULT_ARCHIVE_THRESHOLD,
      emaAlpha: (cfg as { emaAlpha?: number } | undefined)?.emaAlpha ?? DEFAULT_EMA_ALPHA,
    };
  } catch {
    return {
      decayBase: DEFAULT_DECAY_BASE,
      archiveThreshold: DEFAULT_ARCHIVE_THRESHOLD,
      emaAlpha: DEFAULT_EMA_ALPHA,
    };
  }
}

/**
 * Compute effective EMA = success_ema × decayBase^(currentSeq − lastUsedSeq).
 * Returns null if success_ema is null/undefined (never-seeded beliefs are not scored).
 */
export function computeEffectiveEma(belief: Belief, currentSeq: number): number | null {
  if (belief.successEma == null) return null;
  const delta = Math.max(0, currentSeq - belief.lastUsedAt);
  const { decayBase } = getMechanismConfig();
  return belief.successEma * Math.pow(decayBase, delta);
}

/**
 * Pure in-memory decay step (no SQL): mutate belief.successEma to the post-decay value
 * (or seed 0.5 if null) and bump last_used_at. Used by materializeOnTouch and
 * applyFitnessUpdate so each public function performs at most one SQL write.
 */
function decayBeliefInPlace(belief: Belief, currentSeq: number): void {
  if (belief.successEma == null) {
    belief.successEma = 0.5; // Bug #4 seed
  } else {
    const delta = Math.max(0, currentSeq - belief.lastUsedAt);
    const { decayBase } = getMechanismConfig();
    belief.successEma = belief.successEma * Math.pow(decayBase, delta);
  }
  belief.lastUsedAt = currentSeq;
}

/**
 * Materialize lazy decay: write effective_ema back to success_ema and set last_used_at = currentSeq.
 * Mutates `belief` in place so callers see fresh values (bug #1 fix).
 * If success_ema is null (never-seeded), seeds to 0.5 AND updates last_used_at (bug #4 fix).
 * Idempotent: calling twice with the same seq yields the same result.
 * Does NOT touch inject_count (DP-002 B).
 */
export function materializeOnTouch(belief: Belief, currentSeq: number): void {
  decayBeliefInPlace(belief, currentSeq);
  setBeliefSuccessEmaAndSeq(belief.id, belief.successEma!, currentSeq);
}

/**
 * Apply weighted-score EMA update after materializing lazy decay.
 * Single SQL write: blends the decayed value with taskScore, then persists once.
 * Does NOT touch inject_count (DP-002 B).
 */
export function applyFitnessUpdate(belief: Belief, taskScore: number, currentSeq: number): void {
  decayBeliefInPlace(belief, currentSeq); // belief.successEma now reflects post-decay (bug #1 fix)
  const { emaAlpha } = getMechanismConfig();
  const newEma = (1 - emaAlpha) * belief.successEma! + emaAlpha * taskScore;
  belief.successEma = newEma; // keep in-memory consistent
  setBeliefSuccessEmaAndSeq(belief.id, newEma, currentSeq);
}

/**
 * Returns true if the belief's effective_ema is below the archive threshold (< 0.2 by default).
 * Null EMAs (never-seeded) never trigger archiving.
 */
export function checkArchiveThreshold(belief: Belief, currentSeq: number): boolean {
  const eff = computeEffectiveEma(belief, currentSeq);
  if (eff == null) return false;
  return eff < getMechanismConfig().archiveThreshold;
}

/**
 * Soft-delete a belief: set status='archived'. Row is preserved, never DELETEd.
 */
export function archiveBelief(beliefId: string): void {
  updateBeliefStatus(beliefId, "archived" as Parameters<typeof updateBeliefStatus>[1]);
}
