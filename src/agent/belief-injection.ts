/**
 * belief-injection.ts — Unified belief injection (Belief Evolution v3)
 *
 * Replaces the old champion/challenger injection path (belief-scope.ts).
 * All active beliefs are eligible; top-K=5 by effective_ema (decay-adjusted).
 * DP-002 Option B: bumpInjectCount called ONLY here, strictly once per inject.
 */

import type { Belief } from "../shared/types.js";
import { searchBeliefsByVector, listBeliefsByRole, bumpInjectCount } from "../store/beliefs.js";
import { getRoleTaskSeq } from "../store/roles.js";
import { computeEffectiveEma, materializeOnTouch } from "./belief-mechanism.js";

const TOP_K = 5;

/**
 * Unified injection selection: top-K=5 active beliefs for role + optional stepKind.
 *
 * - If stepKind given: filter to beliefs with scope_key === `${roleId}::${stepKind}` OR null (role-wide pool)
 * - If no stepKind: all active beliefs for the role
 * - Sorts by effective_ema (decay-adjusted), highest first
 * - Materializes (write-back) and bumps inject_count for each selected belief
 * - Cold-start safe: returns [] when no active beliefs exist
 */
export async function selectInjectionBeliefs(
  roleId: string,
  stepKind: string | undefined,
  queryEmbedding?: Float32Array,
): Promise<Belief[]> {
  const currentSeq = getRoleTaskSeq(roleId);
  const scopeKey = stepKind ? `${roleId}::${stepKind}` : undefined;

  // Fetch candidates: vector search if embedding available, else recency-based list.
  // Top up with recency list when vector search returns fewer than TOP_K * 4 — dedup by id.
  // Prior bug: `length === 0` fallback meant a single low-cosine embedded belief monopolized
  // top-K forever; non-embedded actives never surfaced.
  let candidates: Belief[];
  if (queryEmbedding) {
    const hits = searchBeliefsByVector(roleId, queryEmbedding, TOP_K * 4);
    candidates = hits.map((r) => r.node).filter((b) => b.status === "active");
    if (candidates.length < TOP_K * 4) {
      const seen = new Set(candidates.map((b) => b.id));
      const recency = listBeliefsByRole(roleId, { onlyActive: true }).slice(0, TOP_K * 4);
      for (const b of recency) {
        if (seen.has(b.id)) continue;
        candidates.push(b);
        if (candidates.length >= TOP_K * 4) break;
      }
    }
  } else {
    candidates = listBeliefsByRole(roleId, { onlyActive: true }).slice(0, TOP_K * 4);
  }

  // Filter by scope if stepKind given (include beliefs with no scope_key = role-wide pool).
  // v82 migration normalized all legacy `::pool` rows to NULL, so the filter is single-path.
  if (scopeKey) {
    candidates = candidates.filter((b) => b.scopeKey === scopeKey || b.scopeKey == null);
  }

  // Score by effective_ema (decay-adjusted); null EMA falls back to 0.5 seed
  const scored = candidates.map((b) => ({
    belief: b,
    score: computeEffectiveEma(b, currentSeq) ?? 0.5,
  }));
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, TOP_K).map((s) => s.belief);

  // Materialize on touch (lazy decay write-back) AND bump inject_count (DP-002 B: only here).
  // Update in-memory belief.injectCount too so callers reading the returned array see consistent state.
  for (const b of selected) {
    materializeOnTouch(b, currentSeq);
    bumpInjectCount(b.id);
    b.injectCount = (b.injectCount ?? 0) + 1;
  }

  return selected;
}

/**
 * Format selected beliefs into a context string for prompt injection.
 * mode: "initial" → [Memory Context ...]; "refresh" → [Memory Refresh ...]
 */
export function formatInjectionContext(beliefs: Belief[], mode: "initial" | "refresh"): string {
  if (beliefs.length === 0) return "";

  const header =
    mode === "initial"
      ? "[Memory Context — retrieved from prior interactions]"
      : "[Memory Refresh — 过往观察,可能过时;Step 指令为权威,冲突则忽略]";

  const lines = beliefs.map((b) =>
    b.isAnti ? `- [anti-pattern] ❌ ${b.content}` : `- [belief] ${b.content}`,
  );

  return `${header}\n${lines.join("\n")}\n\n[User Request]\n`;
}
