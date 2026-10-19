/**
 * Canonical contract rules for a step. `outputContract.contractRules` is the ONE vocabulary
 * (consumed by the Track A/B SDK hooks). There is no legacy derivation — the old
 * lengthTarget/format/expectedArtifacts fields were removed (single-vocabulary, pure design).
 */

import { isTrackA, type ContractRule } from "../store/contract-rules.js";
import type { TaskStep } from "../shared/types.js";

export function resolveContractRules(step: Pick<TaskStep, "outputContract">): ContractRule[] {
  return step.outputContract?.contractRules ?? [];
}

/**
 * v90 (Gap 1 fix): ledger steps (`settlesPredictionsFor` / `publishesClaimsTo`)
 * automatically get a `format=jsonArray` rule attached to their `outputAs`
 * artifact — enforced at the PreToolUse boundary (see pre-tool-verifier.ts).
 *
 * Why harness-enforced, not per-step-config: per-step configuration is exactly
 * the "forgettable config" hazard exposed by Gap 2 (`openLedgerLookbackDays`
 * had a safe default but wasn't surfaced explicitly). The shape contract is
 * derivable from the step's own `settlesPredictionsFor`/`publishesClaimsTo`
 * fields — those are ALREADY required to be set, so deriving the shape rule
 * from them costs nothing and can't be forgotten.
 *
 * Returns `[]` (no rule) when:
 *   - step has no `outputAs` (no way to key-scope the rule — see Threat Model
 *     on key-scoping), OR
 *   - step has neither `settlesPredictionsFor` nor `publishesClaimsTo`
 *     (non-ledger step → no shape constraint).
 *
 * Dedup with the caller's `resolveContractRules(step)` output is the caller's
 * responsibility (execution-manager.ts:396 strips the legacy `format=json`
 * rule on ledger steps before concat) — `deriveLedgerShapeRules` itself
 * returns ONLY its own single new rule, never the existing ones.
 */
export function deriveLedgerShapeRules(
  step: Pick<TaskStep, "outputContract" | "settlesPredictionsFor" | "publishesClaimsTo" | "outputAs">,
): ContractRule[] {
  if (!step.outputAs) return [];
  if (!step.settlesPredictionsFor && !step.publishesClaimsTo) return [];
  return [{ kind: "format", value: "jsonArray" }];
}

/**
 * Whether a step's declared contract requires a file-on-disk deliverable (so a
 * structured JSON value would NOT satisfy it). True when the contract declares any
 * Track-B rule (fileSizeBytes / audioDurationMs / audioZeroCrossingRatePerS — physical
 * file properties) OR a `mime` rule whose declared type is not `application/json`
 * (binary or text mimes are published as file blobs; only application/json maps to a
 * kind="json" artifact).
 *
 * Single source of truth for "file vs structured-value deliverable" — consumed by the
 * delivery-completeness gate so it accepts format=json deliverables as complete while
 * still requiring real files for audio/image/binary steps.
 */
export function stepRequiresFileArtifact(step: Pick<TaskStep, "outputContract">): boolean {
  return resolveContractRules(step).some(
    (r) =>
      !isTrackA(r) ||
      (r.kind === "mime" && r.declared.toLowerCase() !== "application/json"),
  );
}

/**
 * Whether a step produces a PURE structured-data deliverable that the narrative Layer B
 * verifier must NOT judge. Narrative verification ("does this narrate as 我 in first person")
 * is a category error for a JSON data array (e.g. the 本期下注 bets / 结算 verdicts): the
 * verifier can only hedge → confidence ~0.7 → spurious contract failure.
 *
 * True only when ALL hold:
 *   - no `persona` — a persona step (e.g. 定稿, JSON wrapping narrative voice) DOES carry an
 *     identity to verify, so it keeps Layer B.
 *   - no `mustReferenceArtifacts` — a grounding check is still meaningful, keep Layer B.
 *   - declares `format=json` OR `format=jsonArray` (ledger steps may carry either: the stored
 *     `json` rule, or the `jsonArray` rule derived at the PreToolUse boundary — see
 *     deriveLedgerShapeRules above).
 *
 * Structural validation of the JSON itself is unaffected — it runs at the publish boundary
 * (Track A, pre-tool-verifier.ts). This helper only gates the SEMANTIC narrative verifier.
 */
export function stepIsPureStructuredOutput(
  step: Pick<TaskStep, "outputContract" | "persona">,
): boolean {
  if (step.persona) return false;
  if (step.outputContract?.mustReferenceArtifacts) return false;
  return resolveContractRules(step).some(
    (r) => r.kind === "format" && (r.value === "json" || r.value === "jsonArray"),
  );
}

/**
 * Whether a write_artifact `value` should be stored as a raw text blob (kind="file",
 * text/markdown) rather than a JSON value (kind="json"). True only when the value is a
 * string AND the step's contract declares format markdown|text. A bare string with no
 * text-format contract stays JSON so read_artifact (which returns the JSON value) keeps working.
 */
export function isTextDeliverable(step: Pick<TaskStep, "outputContract">, value: unknown): boolean {
  if (typeof value !== "string") return false;
  return resolveContractRules(step).some(
    (r) => r.kind === "format" && (r.value === "markdown" || r.value === "text"),
  );
}

/**
 * The internal sentinel string that ExecutionManager writes as `tasks.result` when
 * the inactivity force-close fires and no real result was received (em:851).
 *
 * This is the DELIVERABLE sentinel — the one that leaked to users.
 * Distinct from the em:780 log message "...after inactivity timeout" (never a deliverable).
 *
 * Single source of truth — import this constant in any guard that must match the sentinel.
 * Task 8 will wire this back to the em:851 producer; for now the literal is here (defense-in-depth).
 */
export const INACTIVITY_SENTINEL = "ExecutionManager: SDK loop force-closed after activity timeout";

/**
 * Returns true when `text` is the internal inactivity sentinel that ExecutionManager
 * sets when the SDK loop force-closes with no real result (em:851).
 *
 * Used as a universal floor in capture-primary (template-executor) and delivery guards
 * (template-summary-assembler) so the sentinel can never become a user-facing deliverable.
 */
export function isInternalSentinel(text: string): boolean {
  return text === INACTIVITY_SENTINEL;
}

/**
 * Universal floor validity check for an outputAs artifact.
 *
 * An artifact is valid if and only if it exists AND:
 *   - Is a kind="json" no_content marker (`{status:"no_content"}`) — valid declared outcome
 *     representing a deliberate "nothing to deliver" signal, distinct from the sentinel.
 *   - OR is a kind="json" artifact whose string value is non-empty and NOT the internal sentinel.
 *   - OR is a kind="file" artifact with sizeBytes > 0 (non-empty blob on disk).
 *
 * This is the universal floor below any per-step outputContract (length/format) checks.
 * It catches the "role-published-but-degenerate" case: an artifact that was present at
 * validator-loop time but whose content is the internal sentinel or empty.
 *
 * NOTE: for kind="file" artifacts we check only sizeBytes (blob content not read here).
 * The sentinel-string check applies only to kind="json" artifacts where value IS available.
 * Capture-primary (template-executor:907) guards the file-kind sentinel path separately
 * via isInternalSentinel(capturedText) (Task 3-impl).
 */
export function isValidDeliverable(artifact: { kind: string; value?: unknown; sizeBytes: number }): boolean {
  if (artifact.kind === "json") {
    const v = artifact.value;
    // No-content marker is a valid declared outcome — always accept it
    if (typeof v === "object" && v !== null && (v as { status?: unknown }).status === "no_content") {
      return true;
    }
    // String JSON value: reject ONLY positively-identified degeneracy (the internal
    // sentinel or an empty string). The threat this gate exists for is the sentinel
    // STRING; do not reject a present json artifact merely for a missing/undefined
    // value — that would break the #228 presence contract ("artifact present → no retry"),
    // and a value-less json never occurs for a real published deliverable.
    if (typeof v === "string") {
      if (v.trim().length === 0) return false;
      if (isInternalSentinel(v)) return false;
    }
    // Present json artifact (object value, or value not yet materialized in a mock) = valid.
    return true;
  }
  // kind="file": only check sizeBytes (content not read here)
  return artifact.sizeBytes > 0;
}

/**
 * Whether a step's deliverable can be captured verbatim from its text response and stored as a
 * markdown text artifact (platform-side, no publish tool call). The capture-primary path for
 * text steps (see TemplateExecutor + captureTextArtifact).
 *
 * Three-bucket discriminant — capturable ONLY when the deliverable is free text:
 * - FALSE for binary (file/audio/non-json mime) — `stepRequiresFileArtifact`; nothing to capture
 *   from a text response, must publish a real file.
 * - FALSE for structured JSON (`format=json` / `mime=application/json`) — the deliverable is a
 *   typed value, not free text; storing the raw response as a markdown blob is the wrong kind, so
 *   such a step must publish its JSON artifact explicitly (falls through to the presence-gate nudge).
 * - TRUE otherwise (no contract, or `format=markdown|text`) — the response IS the deliverable.
 */
export function isTextCapturable(step: Pick<TaskStep, "outputContract">): boolean {
  if (stepRequiresFileArtifact(step)) return false;
  return !resolveContractRules(step).some(
    (r) =>
      (r.kind === "format" && r.value === "json") ||
      (r.kind === "mime" && r.declared.toLowerCase() === "application/json"),
  );
}
