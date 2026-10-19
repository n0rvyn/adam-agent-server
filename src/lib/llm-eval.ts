import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { getLogger } from "./logger.js";
import { recomputeCost } from "./cost-pricing.js";
import { recordLlmCost } from "./record-llm-cost.js";
import { getRuntimeConfig } from "../config/runtime.js";

const log = getLogger("manager");
const WORKSPACE = path.join(os.homedir(), ".adam", "llm-eval");

export interface LlmEvalOptions {
  systemPrompt?: string;
  /** Override model — falls through to SDK default when unset. */
  model?: string;
  /** Override budget (USD). Default 0.05 preserves legacy boundary-expansion cost. */
  maxBudgetUsd?: number;
  /** Override maxTurns. Default 3. */
  maxTurns?: number;
}

/**
 * Call Claude for a one-shot evaluation using the SDK query() pattern.
 * Used by Manager boundary expansion evaluation and intent-fulfillment scoring.
 *
 * Default budget kept at 0.05 to preserve legacy caller economics; callers that
 * need more headroom (e.g. intent-eval against MiniMax-routed Sonnet pricing)
 * pass `maxBudgetUsd` explicitly.
 */
export async function callClaudeForEvaluation(
  prompt: string,
  systemPromptOrOptions?: string | LlmEvalOptions,
): Promise<string> {
  await fs.mkdir(WORKSPACE, { recursive: true });

  const opts: LlmEvalOptions = typeof systemPromptOrOptions === "string"
    ? { systemPrompt: systemPromptOrOptions }
    : (systemPromptOrOptions ?? {});

  const options: Record<string, unknown> = {
    cwd: WORKSPACE,
    maxTurns: opts.maxTurns ?? 3,
    maxBudgetUsd: opts.maxBudgetUsd ?? 0.05,
    persistSession: false,
  };
  if (opts.systemPrompt) options.systemPrompt = opts.systemPrompt;
  if (opts.model) options.model = opts.model;

  const q = query({ prompt, options });
  let result = "";
  let sdkTotalCostUsd: number | undefined;
  let modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD?: number }> | undefined;
  let numTurns: number | undefined;

  for await (const event of q) {
    const ev = event as Record<string, unknown>;
    if (ev["type"] === "result" && typeof ev["result"] === "string") {
      result = ev["result"] as string;
      if (typeof ev["total_cost_usd"] === "number") {
        sdkTotalCostUsd = ev["total_cost_usd"] as number;
      }
      if (ev["modelUsage"] && typeof ev["modelUsage"] === "object") {
        modelUsage = ev["modelUsage"] as typeof modelUsage;
      }
      if (typeof ev["num_turns"] === "number") {
        numTurns = ev["num_turns"] as number;
      }
    }
  }

  // Capture cost as a side-effect (failure must not break eval return value)
  if (modelUsage) {
    try {
      const priceTable = getRuntimeConfig().pricing?.models ?? {};
      const recompute = recomputeCost(modelUsage, priceTable, sdkTotalCostUsd);
      void recordLlmCost({ source: "eval", recompute, numTurns, mirror: false });
    } catch (err) {
      log.warn({ err }, "llm-eval: cost capture failed (non-fatal)");
    }
  }

  return result;
}
