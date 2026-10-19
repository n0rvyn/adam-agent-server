import { callClaudeForEvaluation } from "../lib/llm-eval.js";
import { getRuntimeConfig } from "../config/runtime.js";
import { getLogger } from "../lib/logger.js";
import { resolveReflectionBudgetUsd } from "./reflection-budget.js";
import type { Belief } from "../shared/types.js";

const log = getLogger("manager");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConflictVerdict =
  | { action: "coexist" }
  | { action: "merge"; intoBeliefId: string; mergedContent: string }
  | { action: "supersede"; oldBeliefId: string };

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Strip markdown code fences from a JSON string before parsing.
 */
function stripFences(raw: string): string {
  let s = raw.trim();
  // Strip opening fence: ```json ... or ``` ...
  const openMatch = s.match(/^```(\w*)\s*/);
  if (openMatch) s = s.slice(openMatch[0].length);
  // Strip trailing fence: ```
  if (s.endsWith("```")) s = s.slice(0, s.length - 3);
  return s.trim();
}

export function parseVerdict(raw: string, neighbors: Belief[]): ConflictVerdict {
  const stripped = stripFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { action: "coexist" };
  }

  if (!parsed || typeof parsed !== "object") return { action: "coexist" };
  const obj = parsed as Record<string, unknown>;

  if (obj.action === "coexist") return { action: "coexist" };

  if (obj.action === "merge") {
    const intoBeliefId = typeof obj.intoBeliefId === "string" ? obj.intoBeliefId.trim() : "";
    const mergedContent = typeof obj.mergedContent === "string" ? obj.mergedContent.trim() : "";
    if (
      intoBeliefId.length > 0 &&
      mergedContent.length > 0 &&
      neighbors.some((n) => n.id === intoBeliefId)
    ) {
      return { action: "merge", intoBeliefId, mergedContent };
    }
    return { action: "coexist" };
  }

  if (obj.action === "supersede") {
    const oldBeliefId = typeof obj.oldBeliefId === "string" ? obj.oldBeliefId.trim() : "";
    if (oldBeliefId.length > 0 && neighbors.some((n) => n.id === oldBeliefId)) {
      return { action: "supersede", oldBeliefId };
    }
    return { action: "coexist" };
  }

  return { action: "coexist" };
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

export async function resolveBeliefConflict(
  candidate: { content: string },
  neighbors: Belief[],
): Promise<ConflictVerdict> {
  if (neighbors.length === 0) return { action: "coexist" };

  const cfg = getRuntimeConfig();
  const haikuModel = cfg.anthropic?.defaultHaikuModel || "claude-haiku-4-5";

  const neighborBlock = neighbors
    .map((n, i) => `${i + 1}. id=${n.id} ${n.content}`)
    .join("\n");

  const prompt = `You are a belief conflict resolver.

Existing beliefs for this role:
${neighborBlock}

New candidate belief: "${candidate.content}"

Choose ONE of three actions and output exactly one JSON object on one line with no code fences:
- "coexist": candidate is meaningfully different from existing beliefs; keep both.
- "merge": candidate overlaps significantly with one existing belief; merge into it with the "intoBeliefId" field pointing to the existing belief's id, and "mergedContent" being the combined text.
- "supersede": candidate directly contradicts an existing belief; "oldBeliefId" is the existing belief's id.

Examples:
{"action":"coexist"}
{"action":"merge","intoBeliefId":"bid-123","mergedContent":"Merged belief text."}
{"action":"supersede","oldBeliefId":"bid-456"}

Respond with only the JSON object.`;

  try {
    const result = await callClaudeForEvaluation(prompt, {
      systemPrompt: "You output exactly one JSON line classifying a belief conflict. No prose.",
      model: haikuModel,
      maxBudgetUsd: resolveReflectionBudgetUsd(),
      maxTurns: 10,
    });
    return parseVerdict(result, neighbors);
  } catch (err) {
    log.warn({ err, content: candidate.content }, "Haiku failed for belief conflict resolution; coexisting");
    return { action: "coexist" };
  }
}
