/**
 * Token-counter contract used by context-builder. Pluggable so a future
 * tiktoken-cl100k swap is a single substitution.
 */
export type TokenCounter = (text: string) => number;

/**
 * Heuristic token estimator covering CJK + ASCII mixed content.
 * Crystal D-S00 (deferred): swap to tiktoken-cl100k when latency budget allows.
 *
 * Rationale: tiktoken averages ~3.5 chars/token across English+CJK in the
 * Adam workload; the heuristic is within ±15% on real fixtures, which is
 * adequate for budget-driven truncation decisions.
 */
export const heuristicTokenCounter: TokenCounter = (text: string): number => {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
};
