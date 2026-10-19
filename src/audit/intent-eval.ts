import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { findMessageByTaskId, getMessagesBySession } from "../store/messages.js";
import { getTask } from "../store/tasks.js";
import { getRole } from "../store/roles.js";
import { getConfigValue } from "../store/config.js";
import { getRuntimeConfig } from "../config/runtime.js";
import { callClaudeForEvaluation } from "../lib/llm-eval.js";
import { getLogger } from "../lib/logger.js";
import { getStartOfDayMs } from "../lib/time.js";

const log = getLogger("audit");
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * tsup bundles everything to flat dist/ files and does NOT copy .md assets,
 * so `join(__dirname, "prompts/intent-eval.md")` fails in production.
 * Try multiple locations: dev layout, built layout, cwd fallback.
 * Matches src/sandbox/macos.ts:31-45 pattern.
 */
function resolvePromptPath(): string {
  const candidates = [
    join(__dirname, "prompts", "intent-eval.md"),
    join(__dirname, "..", "src", "audit", "prompts", "intent-eval.md"),
    join(process.cwd(), "src", "audit", "prompts", "intent-eval.md"),
  ];
  for (const p of candidates) {
    try { readFileSync(p, "utf8"); return p; } catch { /* try next */ }
  }
  return candidates[candidates.length - 1];
}

/**
 * Lazy-load + cache the prompt template.
 * Module-level readFileSync would fail in test environments that mock fs without exporting readFileSync.
 */
let cachedTemplate: string | undefined;
function getPromptTemplate(): string {
  if (cachedTemplate === undefined) {
    cachedTemplate = readFileSync(resolvePromptPath(), "utf8");
  }
  return cachedTemplate;
}

/** Hardcoded fallback when neither evaluation.model nor anthropic.defaultHaikuModel is set. */
const HARDCODED_HAIKU = "claude-haiku-4-5-20251001";
const DEFAULT_INTENT_EVAL_MAX_BUDGET_USD = 1.0;
const DEFAULT_INTENT_EVAL_TIMEOUT_MS = 30_000;

let intentEvalDegradedToday = 0;
let intentEvalDayStartMs = getStartOfDayMs();

export interface IntentEvalResult {
  score: number | null;          // 0..1, or null on failure
  reason?: string;
  failed: boolean;
}

function ensureIntentEvalDayBoundary(): void {
  const currentDayStartMs = getStartOfDayMs();
  if (currentDayStartMs !== intentEvalDayStartMs) {
    intentEvalDayStartMs = currentDayStartMs;
    intentEvalDegradedToday = 0;
  }
}

function isValidIntentEvalBudgetUsd(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidIntentEvalTimeoutMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function resolveIntentEvalBudgetUsd(): number {
  const persistedValue = getConfigValue("audit.intentEval.maxBudgetUsd");
  if (isValidIntentEvalBudgetUsd(persistedValue)) {
    return persistedValue;
  }
  try {
    const runtimeValue = getRuntimeConfig().audit?.intentEval?.maxBudgetUsd;
    if (isValidIntentEvalBudgetUsd(runtimeValue)) {
      return runtimeValue;
    }
  } catch {
    // Runtime config is not initialized in some unit tests.
  }
  return DEFAULT_INTENT_EVAL_MAX_BUDGET_USD;
}

function resolveIntentEvalTimeoutMs(): number {
  const persistedValue = getConfigValue("audit.intentEval.timeoutMs");
  if (isValidIntentEvalTimeoutMs(persistedValue)) {
    return persistedValue;
  }
  try {
    const runtimeValue = getRuntimeConfig().audit?.intentEval?.timeoutMs;
    if (isValidIntentEvalTimeoutMs(runtimeValue)) {
      return runtimeValue;
    }
  } catch {
    // Runtime config is not initialized in some unit tests.
  }
  return DEFAULT_INTENT_EVAL_TIMEOUT_MS;
}

function recordIntentEvalDegradation(): void {
  ensureIntentEvalDayBoundary();
  intentEvalDegradedToday += 1;
}

export function getIntentEvalStats(): { intentEvalDegradedToday: number; intentEvalBudgetUsd: number } {
  ensureIntentEvalDayBoundary();
  return {
    intentEvalDegradedToday,
    intentEvalBudgetUsd: resolveIntentEvalBudgetUsd(),
  };
}

export function resetIntentEvalStatsForTests(): void {
  intentEvalDayStartMs = getStartOfDayMs();
  intentEvalDegradedToday = 0;
}

/**
 * Run intent-fulfillment LLM eval for a completed task.
 * Async, non-blocking — caller fires-and-forgets via setImmediate.
 * On any failure (timeout, API error, parse error, missing data), returns { score: null, failed: true }.
 */
export async function evaluateIntentFulfillment(taskId: string, roleId: string): Promise<IntentEvalResult> {
  try {
    const task = getTask(taskId);
    if (!task || !task.result) {
      return { score: null, failed: true, reason: "task missing or no result" };
    }
    const role = getRole(roleId);
    const userRequest = extractUserRequest(taskId, task.prompt);

    const prompt = getPromptTemplate()
      .replace("{{userRequest}}", userRequest)
      .replace("{{roleName}}", role?.name ?? "(unknown)")
      .replace("{{roleCag}}", role?.cagPrompt ?? "(none)")
      .replace("{{taskResult}}", task.result);

    // Model fallback chain: evaluation.model → anthropic.defaultHaikuModel → hardcoded
    const evalModel = (getConfigValue("evaluation.model") as string | undefined)
      ?? (getConfigValue("anthropic.defaultHaikuModel") as string | undefined)
      ?? HARDCODED_HAIKU;
    const maxBudgetUsd = resolveIntentEvalBudgetUsd();
    const timeoutMs = resolveIntentEvalTimeoutMs();

    // Call the evaluation LLM with explicit model + budget overrides.
    // Promise.race timeout below does not abort the SDK call; the SDK self-terminates on budget exhaustion.
    const evalCall = callClaudeForEvaluation(prompt, {
      model: evalModel,
      maxBudgetUsd,
      // 2026-05-29 raised 2→10: non-Claude proxied models need more turns than Claude (see contract-verifier).
      maxTurns: 10,
    });
    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error(`eval timeout after ${timeoutMs}ms`)), timeoutMs),
    );
    const responseText = await Promise.race([evalCall, timeoutPromise]);

    // Parse JSON from response (strip optional markdown code fences)
    const trimmed = responseText.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const parsed = JSON.parse(trimmed) as { score: number; reason?: string };
    if (typeof parsed.score !== "number" || parsed.score < 0 || parsed.score > 1 || Number.isNaN(parsed.score)) {
      throw new Error(`invalid score: ${parsed.score}`);
    }
    return { score: parsed.score, reason: parsed.reason, failed: false };
  } catch (err) {
    recordIntentEvalDegradation();
    log.error(
      { taskId, roleId, degraded: true, err: err instanceof Error ? err.message : String(err) },
      "Intent eval failed; degrading to neutral",
    );
    return { score: null, failed: true, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Extract the user's original request that triggered this task.
 * Strategy: find the assistant chat message linked to this task (via findMessageByTaskId);
 * the user message immediately preceding it (in the same session) is the request.
 * Falls back to task.prompt if linkage is missing.
 */
function extractUserRequest(taskId: string, fallbackPrompt: string): string {
  try {
    const linkedMsg = findMessageByTaskId(taskId);
    if (!linkedMsg?.sessionId) return fallbackPrompt;

    const sessionMessages = getMessagesBySession(linkedMsg.sessionId, 100, 0);
    // Find the linked message's index, then walk back to find the most recent user message before it
    const idx = sessionMessages.findIndex(m => m.id === linkedMsg.id);
    if (idx === -1) return fallbackPrompt;
    for (let i = idx - 1; i >= 0; i--) {
      if (sessionMessages[i].role === "user") {
        return sessionMessages[i].content;
      }
    }
    return fallbackPrompt;
  } catch {
    return fallbackPrompt;
  }
}
