/**
 * Canonical step id → step kind mapping.
 *
 * When a template step is created without an explicit `kind`, `deriveStepKind`
 * looks up the step id in this table so the belief-injection scope_key contract
 * (`{roleId}::{kind}`) produces meaningful buckets instead of routing everything
 * to `{roleId}::default`.
 *
 * Mapping rules:
 * - Direct match: stepId.toLowerCase().trim() → kind
 * - Suffix-strip match: strip trailing [abc0-9]+ then re-lookup (handles 写稿A/B/C etc.)
 * - Fallback: use stepId verbatim + emit a warn-log for operator visibility
 */

import { getLogger } from "../lib/logger.js";

const log = getLogger("agent");

const CANONICAL_STEP_KIND_MAP: Record<string, string> = {
  // English / role-named step ids
  "jay": "tts",
  "audio": "tts",
  "tts": "tts",
  "picasso": "image",
  "image": "image",
  // Chinese podcast pipeline step ids
  "采集": "collection",
  "写稿": "drafting",
  "写稿a": "drafting",
  "写稿b": "drafting",
  "写稿c": "drafting",
  "批判": "criticism",
  "批判a": "criticism",
  "批判b": "criticism",
  "批判c": "criticism",
  "润色": "polishing",
  "润色a": "polishing",
  "润色b": "polishing",
  "润色c": "polishing",
  "评分": "scoring",
  "定稿": "finalizing",
};

/**
 * Derive the step kind for a template step id.
 *
 * @param stepId - The step's `id` field (e.g. "写稿A", "jay", "myCustomStep")
 * @returns The canonical kind string (e.g. "drafting", "tts") or the step id
 *          verbatim when no mapping is found.
 */
export function deriveStepKind(stepId: string): string {
  const lookup = stepId.toLowerCase().trim();

  // Direct map hit
  if (CANONICAL_STEP_KIND_MAP[lookup] !== undefined) {
    return CANONICAL_STEP_KIND_MAP[lookup];
  }

  // Suffix-strip: remove trailing [abc0-9]+ (handles 写稿A, 批判B, 润色C, etc.)
  const stripped = lookup.replace(/[abc0-9]+$/, "");
  if (stripped !== lookup && CANONICAL_STEP_KIND_MAP[stripped] !== undefined) {
    return CANONICAL_STEP_KIND_MAP[stripped];
  }

  // Fallback: use step id as-is; log for operator visibility
  log.warn({ stepId, derived: stepId }, "deriveStepKind: no canonical mapping, using stepId as kind");
  return stepId;
}
