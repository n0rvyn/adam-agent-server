import { callClaudeForEvaluation } from "../lib/llm-eval.js";
import { getRuntimeConfig } from "../config/runtime.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("audit");

export interface AssertionResult {
  assertion: string;
  passed: boolean;
  reason: string;
}

export interface CustomAssertionsCheckResult {
  passed: boolean;
  results: AssertionResult[];
}

const SYSTEM_PROMPT = `You are an editorial judge. Output exactly one JSON object of the shape:
{"results": [{"assertion": "<original assertion text>", "passed": true|false, "reason": "<1-2 sentence explanation>"}]}
No prose before or after. No code fences. Each assertion in input must appear in results with the same string.`;

// EXPORTED so Task 2-tests can snapshot-assert the constructed prompt directly
// (kb lesson 2026-05-16 prevention #2: prompt-construction needs snapshot tests, not just response-parsing mocks)
export function buildPrompt(assertions: string[], stepResult: string): string {
  const TRUNCATE_AT = 30000;
  let body = stepResult;
  if (stepResult.length > TRUNCATE_AT) {
    body = stepResult.slice(0, TRUNCATE_AT) + "\n\n[...truncated]";
    log.warn(
      { originalLength: stepResult.length, truncatedTo: TRUNCATE_AT },
      "assertion-judge: stepResult truncated for Haiku judge — assertion evidence at position > 30000 may produce false-negatives",
    );
  }
  return `Evaluate the following content against each assertion. For each, decide pass/fail and give a brief reason citing the content.

ASSERTIONS:
${assertions.map((a, i) => `${i + 1}. ${a}`).join("\n")}

CONTENT:
${body}

Output JSON now.`;
}

function parseJudgeResponse(raw: string, assertions: string[]): CustomAssertionsCheckResult | null {
  try {
    // Strip optional code fence: ```json / ```javascript / bare ``` / etc.
    // Previous regex `^```json?` parsed as `\`\`\`` + `jso` + optional `n` — failed on any
    // non-json language tag or no tag at all. `^```[a-z]*` covers all common language tags.
    const stripped = raw.trim().replace(/^```[a-z]*\s*|\s*```$/g, "");
    const parsed = JSON.parse(stripped) as { results?: unknown };
    if (!parsed.results || !Array.isArray(parsed.results)) return null;
    const results: AssertionResult[] = [];
    for (const item of parsed.results) {
      const obj = item as Record<string, unknown>;
      if (
        typeof obj.assertion !== "string" ||
        typeof obj.passed !== "boolean" ||
        typeof obj.reason !== "string"
      ) {
        return null;
      }
      results.push({ assertion: obj.assertion, passed: obj.passed, reason: obj.reason });
    }
    if (results.length !== assertions.length) return null;
    const passed = results.every((r) => r.passed);
    return { passed, results };
  } catch {
    return null;
  }
}

/**
 * Evaluate each assertion against stepResult using a Haiku one-shot call.
 * Retries the LLM call once if the response cannot be parsed as expected JSON.
 * On any unrecoverable error (timeout, persistent malformed JSON), returns all-fail
 * with the error captured in reason — callers (template-executor Layer C) decide
 * whether to retry the step itself or persist the violation.
 */
export async function runCustomAssertionsCheck(args: {
  assertions: string[];
  stepResult: string;
}): Promise<CustomAssertionsCheckResult> {
  const { assertions, stepResult } = args;
  let haikuModel = "claude-haiku-4-5";
  try {
    haikuModel = getRuntimeConfig().anthropic?.defaultHaikuModel || "claude-haiku-4-5";
  } catch {
    // Config not yet initialized (e.g., in unit tests without full server setup) — use default
  }

  log.info(
    { assertionsCount: assertions.length, stepResultLength: stepResult.length, model: haikuModel },
    "assertion-judge: entering check",
  );

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await callClaudeForEvaluation(buildPrompt(assertions, stepResult), {
        systemPrompt: SYSTEM_PROMPT,
        model: haikuModel,
        // 2026-05-19 raised from 0.05 → 0.30 after dry-run found 0.05 was exhausted
        // before Haiku finished evaluating a ~10KB script + 4 assertions. Budget needs to
        // cover input tokens (~3K for script + assertions) + output tokens (~500 for JSON) at
        // Haiku-4.5 pricing. 0.30 is ~6× headroom; revisit if Haiku pricing changes.
        maxBudgetUsd: 0.30,
        maxTurns: 1,
      });
      const parsed = parseJudgeResponse(raw, assertions);
      if (parsed) {
        // Success-path logging (kb lesson 2026-05-16 prevention #1: log success not just failures).
        // Without this, "Layer C ran successfully" is indistinguishable from "Layer C never ran" in logs.
        log.info(
          { attempt, passed: parsed.passed, perAssertionPasses: parsed.results.map((r) => r.passed) },
          "assertion-judge: parsed successfully",
        );
        return parsed;
      }
      log.warn({ attempt, rawPreview: raw.slice(0, 200) }, "assertion-judge: malformed JSON, retrying");
    } catch (err) {
      log.warn({ attempt, err: (err as Error).message }, "assertion-judge: LLM call failed");
      if (attempt === 2) {
        return {
          passed: false,
          results: assertions.map((a) => ({
            assertion: a,
            passed: false,
            reason: `judge unavailable: ${(err as Error).message}`,
          })),
        };
      }
    }
  }

  // Both attempts returned malformed JSON (no exception); record all-fail with explanation
  return {
    passed: false,
    results: assertions.map((a) => ({
      assertion: a,
      passed: false,
      reason: "judge response could not be parsed after 2 attempts",
    })),
  };
}
