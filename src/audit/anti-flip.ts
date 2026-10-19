/**
 * Anti-pattern auto-flip module.
 *
 * Detects beliefs that consistently fail (low success_rate after minimum uses)
 * and rewrites them via Haiku as anti-pattern warnings.
 *
 * Every Haiku failure mode (network, malformed response, timeout) defers
 * the flip and records an evolution_audit row — the belief row is NEVER
 * mutated without a successful Haiku rewrite (DP-003).
 */

import { getRuntimeConfig } from "../config/runtime.js";
import { getBelief, updateBeliefContentAndMarkAnti } from "../store/beliefs.js";
import { createEvolutionAudit } from "../store/evolution-audit.js";
import { callClaudeForEvaluation } from "../lib/llm-eval.js";
import type { MemoryConfig } from "../shared/types.js";

/** Haiku rewrite prompt template. */
function buildRewritePrompt(content: string): string {
  return `Rewrite the following belief as an anti-pattern warning, prefixed with ❌ 历史失败模式: .
Keep it short (200 characters maximum). Original:
${content}`;
}

/**
 * Invoke Haiku with a 10-second timeout.
 * Wrapping the call in Promise.race ensures a hung Haiku call does not
 * chain-block evaluateTaskCompletion — timeout routes to the deferral path.
 */
async function callHaikuWithTimeout(
  prompt: string,
  timeoutMs = 10_000,
): Promise<string> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Haiku timeout after ${timeoutMs / 1000}s`)), timeoutMs);
  });
  const haikuPromise = callClaudeForEvaluation(prompt, {
    systemPrompt: "Output exactly one string prefixed with ❌ . No JSON. No code fences.",
    model: getRuntimeConfig().anthropic?.defaultHaikuModel || "claude-haiku-4-5",
    maxBudgetUsd: 0.01,
    maxTurns: 1,
  });
  return Promise.race([haikuPromise, timeoutPromise]);
}

/**
 * Check and potentially flip a belief to anti-pattern.
 * Predicate v3: skip if injectCount < antiFlipMinUses OR successEma >= antiFlipSuccessEmaThreshold.
 * DP-001 Option A: injectCount is incremented exactly +1 per inject in materializeOnTouch.
 * On Haiku success: rewrite content + set is_anti = 1 (atomically in one UPDATE).
 * On any Haiku failure: record evolution_audit with kind = "anti_flip_deferred"; belief unchanged.
 */
export async function checkAndFlipAntiPattern(
  beliefIds: string[],
  cfg: MemoryConfig,
): Promise<void> {
  const threshold = cfg.antiFlipSuccessEmaThreshold ?? 0.25;
  const minTouches = cfg.antiFlipMinUses ?? 5;

  for (const beliefId of beliefIds) {
    const b = getBelief(beliefId);
    if (!b || b.isAnti) continue;

    // Predicate gate v3: need minimum inject touches and persistently low success_ema
    if ((b.injectCount ?? 0) < minTouches) continue;
    if ((b.successEma ?? 1.0) >= threshold) continue;

    // Trigger Haiku rewrite
    const prompt = buildRewritePrompt(b.content);
    let rewritten: string;
    try {
      const raw = await callHaikuWithTimeout(prompt);
      rewritten = raw.trim();

      // Validate: must be non-empty and start with ❌ after trimming
      if (!rewritten || !rewritten.startsWith("❌")) {
        throw new Error("Haiku rewrite returned malformed content (missing ❌ prefix)");
      }

      await updateBeliefContentAndMarkAnti(beliefId, rewritten);
    } catch (err) {
      // DP-003 deferral: do NOT flip the bit; record into evolution_audit.
      createEvolutionAudit({
        timestamp: Date.now(),
        oldRules: "",
        newRules: "",
        diff: JSON.stringify({
          kind: "anti_flip_deferred",
          beliefId,
          injectCount: b.injectCount ?? 0,
          successEma: b.successEma ?? 1.0,
          error: String(err),
        }),
        roleId: b.roleId,
        source: "audit-monitor",
      });
    }
  }
}
