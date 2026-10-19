/**
 * Lightweight token count estimator.
 * Uses character-based heuristic (avg 4 chars/token for English, 2 for CJK).
 * Accurate enough for budget allocation; not for billing.
 */
export function estimateTokens(text: string): number {
  // Count CJK characters (each ≈ 1 token)
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
  // Remaining characters at ~4 chars/token
  const nonCjkChars = text.length - cjkCount;
  return cjkCount + Math.ceil(nonCjkChars / 4);
}
