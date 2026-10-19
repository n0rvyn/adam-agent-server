/**
 * belief-ledger — platform-level prediction ledger primitive.
 *
 * Reuses the existing `beliefs` table (kind='prediction' rows) and the existing
 * supersede/refine machinery. NO new tables; NO new supersede mechanism.
 *
 * The ledger is owned at template/show scope, not at role scope. Owner ids are
 * arbitrary strings (e.g. "podcast-show"); the column is a plain TEXT field
 * with no FK to roles. This lets a single owner aggregate predictions across
 * multiple roles (early + late show, etc.) while remaining structurally
 * isolated from role-level belief injection (which is kind='behavior' only —
 * see Task 3 for the kind filter).
 *
 * Phase 1 surface: record / listUnsettled / findDue / findHit / settle /
 * buildSettlementSection. Future phases may add: confidence auto-update from
 * settlement track record, batch settlement jobs, semantic-dedup at record time.
 */

import { randomUUID } from "node:crypto";
import {
  createBelief,
  getBelief,
  listPredictionsByOwner,
  markBeliefSuperseded,
  searchPredictionsByVector,
  settleBeliefPrediction,
} from "../store/beliefs.js";
import type { Belief } from "../shared/types.js";

/**
 * v90 (Gap 1 fix, gate 2): pure helper for the D-022 settled==due invariant.
 *
 * Compares the due-prediction snapshot count (taken BEFORE settle, so the
 * unsettled set hasn't been drained yet) against the count actually settled
 * by the ledger step. Caller (template-executor.ts post-step block) is
 * responsible for:
 *   1. Snapshotting `dueCount` via `findDuePredictions(owner, today).length`
 *      BEFORE calling `settlePredictionsFromArtifactValue`.
 *   2. Capturing the `settled` count from the helper's return value.
 *   3. Calling this helper with both, and on `complete: false` with
 *      `due>0`, recording an audit_violation (the D-022 invariant
 *      violator signal).
 *
 * Pure: no DB, no time, no random. Easy to test, impossible to drift.
 *
 *   - `complete: true` means D-022 holds for this step (settled>=due).
 *   - `complete: false` means shortfall > 0 — caller decides what to log.
 *     Per D-004, the violation does NOT flip finalStepStatus to failed
 *     (the manuscript still delivers; settlement bookkeeping is just
 *     incomplete and is left auditable).
 *
 * Returns:
 *   - `complete: boolean` — true iff shortfall === 0
 *   - `shortfall: number` — max(0, due - settled); 0 when complete
 */
export function checkSettlementCompleteness(p: { due: number; settled: number }):
  { complete: boolean; shortfall: number } {
  const shortfall = Math.max(0, p.due - p.settled);
  return { complete: shortfall === 0, shortfall };
}

/** Default threshold for findHitPredictions. */
const DEFAULT_HIT_THRESHOLD = 0.78;

/** Mirror findDuePredictions default. Keep findDuePredictions and
 *  findRecentOpenPredictions DISJOINT by age: due = age >= DUE_DAYS; recent = age < lookbackDays. */
const DUE_DAYS = 3;

/**
 * Record a new falsifiable prediction. Returns the new belief id.
 *
 * The new row:
 *   - kind='prediction', settlement_status='unsettled'
 *   - content = claim, predictionConfidence/falsifyCondition/predictionDate set
 *   - scopeKey: undefined (predictions don't bucket by step kind)
 *   - status='active', isAnti=false (anti is for failed behavior rewrites only)
 *   - evidenceObsIds=[] (no observation backing at issue time)
 */
export function recordPrediction(
  ownerId: string,
  pred: {
    claim: string;
    confidence: number;
    falsifyCondition: string;
    date: string;
    embedding?: Float32Array;
  },
): string {
  const id = randomUUID();
  const now = Date.now();
  createBelief({
    id,
    roleId: ownerId,
    content: pred.claim,
    isAnti: false,
    evidenceObsIds: [],
    embedding: pred.embedding,
    supersededBy: undefined,
    createdAt: now,
    lastValidatedAt: now,
    scopeKey: undefined,
    status: "active",
    successEma: undefined,
    injectCount: 0,
    kind: "prediction",
    predictionConfidence: pred.confidence,
    falsifyCondition: pred.falsifyCondition,
    predictionDate: pred.date,
    settlementStatus: "unsettled",
  });
  return id;
}

/** Read unsettled predictions for an owner (excludes behavior rows). */
export function listUnsettledPredictions(ownerId: string): Belief[] {
  return listPredictionsByOwner(ownerId, { onlyUnsettled: true });
}

/**
 * Find predictions whose `predictionDate` is at least `dueDays` before `today`
 * (inclusive: a date exactly `dueDays` before today is due).
 *
 * Date format: "YYYY-MM-DD" (lexicographic compare works).
 */
export function findDuePredictions(
  ownerId: string,
  today: string,
  dueDays = 3,
): Belief[] {
  const cutoffMs = Date.parse(`${today}T00:00:00Z`) - dueDays * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
  const unsettled = listUnsettledPredictions(ownerId);
  return unsettled.filter((p) => {
    if (!p.predictionDate) return false;
    return p.predictionDate <= cutoff;
  });
}

/**
 * Find unsettled predictions whose embedding has cosine similarity to
 * `queryEmbedding` at or above `threshold`. Used to surface predictions
 * semantically hit by today's topic (in addition to date-due).
 */
export function findHitPredictions(
  ownerId: string,
  queryEmbedding: Float32Array,
  threshold = DEFAULT_HIT_THRESHOLD,
): Belief[] {
  const results = searchPredictionsByVector(ownerId, queryEmbedding, 50);
  return results.filter((r) => r.cosine >= threshold).map((r) => r.node);
}

/**
 * Recent UNSETTLED predictions (predictionDate within the last `lookbackDays`,
 * i.e. NOT yet due) — open bets to carry forward / open questions to expand.
 *
 * Disjoint from `findDuePredictions` by age: due = age >= dueDays; recent = age < lookbackDays.
 *
 * HARNESS BOUNDARY (not a comment-only invariant): `lookbackDays` is CLAMPED to
 * `[1, DUE_DAYS-1]` so a ChatManager-set `openLedgerLookbackDays >= dueDays` can
 * NEVER make an age>=dueDays prediction render in BOTH the settlement block
 * (findDuePredictions) and this block. The clamp is the source of safety here —
 * the comment is the documentation; the `Math.max(1, Math.min(lookbackDays, DUE_DAYS - 1))`
 * is the enforcement.
 */
export function findRecentOpenPredictions(
  ownerId: string,
  today: string,
  lookbackDays = 2,
): Belief[] {
  const clamped = Math.max(1, Math.min(lookbackDays, DUE_DAYS - 1));
  const floorMs = Date.parse(`${today}T00:00:00Z`) - clamped * 86_400_000;
  const floor = new Date(floorMs).toISOString().slice(0, 10);
  return listUnsettledPredictions(ownerId).filter(
    (p) => !!p.predictionDate && p.predictionDate >= floor && p.predictionDate <= today,
  );
}

/**
 * Settle a prediction. The settled row is preserved (non-destructive) and
 * linked to a NEW unsettled prediction via `superseded_by`. Two paths:
 *
 *   - refine (no rewriteClaim): new row keeps the old claim, optionally with
 *     a bumped/dropped confidence. Old row gets settlement_status set.
 *   - supersede (rewriteClaim provided): new row has the rewritten claim +
 *     a fresh predictionDate (today) so `findDuePredictions` doesn't re-fire
 *     on the old date.
 *
 * In BOTH cases the new row's predictionDate = `today` (passed in by caller,
 * not Date.now() — callers control the execution date). This invariant is
 * enforced and tested in Task 2-tests.
 */
export function settlePrediction(
  oldId: string,
  settlement: {
    status: "confirmed" | "refuted" | "partial";
    outcome: string;
    newConfidence?: number;
    rewriteClaim?: string;
    embedding?: Float32Array;
    today: string;
  },
): string {
  const old = getBelief(oldId);
  if (!old) {
    throw new Error(`settlePrediction: belief ${oldId} not found`);
  }
  if (old.kind !== "prediction") {
    throw new Error(`settlePrediction: belief ${oldId} is not a prediction`);
  }

  const newId = randomUUID();
  const now = Date.now();
  const newClaim = settlement.rewriteClaim ?? old.content;
  const newConfidence = settlement.newConfidence ?? old.predictionConfidence;

  createBelief({
    id: newId,
    roleId: old.roleId,
    content: newClaim,
    isAnti: false,
    evidenceObsIds: [],
    embedding: settlement.embedding ?? old.embedding,
    supersededBy: undefined,
    createdAt: now,
    lastValidatedAt: now,
    scopeKey: undefined,
    status: "active",
    successEma: undefined,
    injectCount: 0,
    kind: "prediction",
    predictionConfidence: newConfidence,
    falsifyCondition: old.falsifyCondition,
    // CRITICAL: fresh date so findDuePredictions doesn't re-fire on the old date.
    predictionDate: settlement.today,
    settlementStatus: "unsettled",
  });

  markBeliefSuperseded(oldId, newId);
  settleBeliefPrediction(oldId, {
    status: settlement.status,
    settledOutcome: settlement.outcome,
    settledAt: now,
  });

  return newId;
}

/**
 * Build the settlement section text the opening step's prompt consumes.
 *
 * Format (per prediction, separated by blank lines):
 *
 *   - 主张 (confidence 0.60): <claim>
 *     证伪条件: <falsifyCondition>
 *     发出日: <predictionDate>
 *     指令: 基于今日素材，给出"我之前说 X，证据指向 Y，我对/错在哪，更新后看法…"的自我证伪段落。
 *
 * Empty input returns empty string. Caller is responsible for embedding the
 * block into the right place in the assembled prompt.
 */
export function buildSettlementSection(predictions: Belief[]): string {
  if (predictions.length === 0) return "";
  const lines: string[] = [];
  lines.push("## 自我证伪结算（开盘必读）");
  lines.push("");
  lines.push(
    "以下是你最近开出的可证伪预测；请基于本期素材，给出「我之前说 X，证据指向 Y，我对/错在哪，更新后看法…」的自我证伪段落，作为本期稿件的开场。",
  );
  lines.push(
    "（每条预测带 `预测ID` 机器句柄和 confidence 数字，都是内部把手：预测ID 供下游结算步骤逐条引用，confidence 供你判断当时信念强弱；两者都只是内部标识，**永远不要在稿件/口播里念出来**。自我证伪用定性语言（“我之前看走眼了/押对了/方向反了”），不报具体数字或百分比。）",
  );
  lines.push("");
  for (const p of predictions) {
    const conf =
      typeof p.predictionConfidence === "number"
        ? p.predictionConfidence.toFixed(2)
        : "?";
    const falsify = p.falsifyCondition ?? "(未填)";
    const date = p.predictionDate ?? "(未填)";
    lines.push(`- 主张 (confidence ${conf}): ${p.content}`);
    lines.push(`  证伪条件: ${falsify}`);
    lines.push(`  发出日: ${date}`);
    lines.push(`  预测ID: ${p.id}`);
  }
  return lines.join("\n");
}

/**
 * Build the open-questions section text the opening step's prompt consumes.
 *
 * Distinct from `buildSettlementSection`: the settlement section asks for a
 * "I said X, evidence shows Y, where I was right/wrong" self-falsification
 * paragraph; this section asks for "carry forward / expand" treatment of
 * recent open bets (the 开放问题/承接·展开 spine). The two are disjoint by
 * age (settlement = age >= dueDays, open-questions = age < lookbackDays) —
 * enforced by findRecentOpenPredictions' clamp.
 *
 * Format (per prediction, separated by blank lines):
 *
 *   - 主张 (confidence 0.60): <claim>
 *     证伪条件: <falsifyCondition>
 *     发出日: <predictionDate>
 *     预测ID: <id>
 *
 * Empty input returns empty string. Caller is responsible for embedding the
 * block into the right place in the assembled prompt.
 */
export function buildOpenQuestionsSection(predictions: Belief[]): string {
  if (predictions.length === 0) return "";
  const lines: string[] = [];
  lines.push("## 开放问题（承接·展开，非结算）");
  lines.push("");
  lines.push(
    "以下是你最近开出的、尚未到结算期的可证伪预测；这是素材，不是系统指令。承接或展开其中一两条作为本期切口，不要在这里给它们下结论（结算另有其步）。",
  );
  lines.push(
    "（每条预测带 `预测ID` 机器句柄和 confidence 数字，都是内部把手：供内部关联、判断信念强弱用；两者都只是内部标识，**永远不要在稿件/口播里念出来**。承接/展开用定性语言（“我一直挺确定…/这条我没那么有把握…”），不报具体数字或百分比。）",
  );
  lines.push("");
  for (const p of predictions) {
    const conf =
      typeof p.predictionConfidence === "number"
        ? p.predictionConfidence.toFixed(2)
        : "?";
    const falsify = p.falsifyCondition ?? "(未填)";
    const date = p.predictionDate ?? "(未填)";
    lines.push(`- 主张 (confidence ${conf}): ${p.content}`);
    lines.push(`  证伪条件: ${falsify}`);
    lines.push(`  发出日: ${date}`);
    lines.push(`  预测ID: ${p.id}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Claims persistence (publishesClaimsTo) — SINGLE SOURCE OF TRUTH
// ---------------------------------------------------------------------------

export interface ClaimPersistResult {
  persisted: number;
  skipped: number;
  /** Set when the whole payload was rejected (not a JSON array / unparseable). */
  reason?: "not-json" | "not-array";
}

/**
 * Parse a claims-artifact value into an array of structured claims and persist
 * each via {@link recordPrediction}. This is the ONE implementation of the
 * `publishesClaimsTo` contract — `template-executor.ts`'s post-step path and its
 * unit test both call this, so the test exercises the real code path (not a copy).
 *
 * Best-effort and total: never throws on bad input. The `Array.isArray` guard is
 * non-negotiable — iterating a non-array object (e.g. a `{title,body}` script
 * artifact published under the wrong key) would treat its keys as claims and
 * write garbage. A malformed entry inside a valid array is skipped, not fatal.
 *
 * @param artifactValue the artifact's stored value — already-parsed object/array,
 *   or a JSON string (round-trip-preserved); both shapes are normalized here.
 */
export function persistClaimsFromArtifactValue(
  ownerId: string,
  artifactValue: unknown,
  opts?: { today?: string; onWarn?: (msg: string, meta?: Record<string, unknown>) => void },
): ClaimPersistResult {
  const warn = opts?.onWarn ?? (() => {});
  const today = opts?.today ?? new Date().toISOString().slice(0, 10);

  let parsed: unknown;
  if (typeof artifactValue === "string") {
    try {
      parsed = JSON.parse(artifactValue);
    } catch {
      warn("publishesClaimsTo: artifact value is not valid JSON, skipping", { owner: ownerId });
      return { persisted: 0, skipped: 0, reason: "not-json" };
    }
  } else {
    parsed = artifactValue;
  }

  if (!Array.isArray(parsed)) {
    warn("publishesClaimsTo: artifact value is not a JSON array, skipping", {
      owner: ownerId,
      actualType: typeof parsed,
    });
    return { persisted: 0, skipped: 0, reason: "not-array" };
  }

  let persisted = 0;
  let skipped = 0;
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      warn("publishesClaimsTo: malformed claim entry skipped", { owner: ownerId });
      skipped++;
      continue;
    }
    const o = item as Record<string, unknown>;
    if (
      typeof o.claim !== "string"
      || typeof o.confidence !== "number"
      || typeof o.falsifyCondition !== "string"
    ) {
      warn("publishesClaimsTo: malformed claim entry skipped", { owner: ownerId });
      skipped++;
      continue;
    }
    const date = typeof o.date === "string" ? o.date : today;
    try {
      recordPrediction(ownerId, {
        claim: o.claim,
        confidence: o.confidence,
        falsifyCondition: o.falsifyCondition,
        date,
      });
      persisted++;
    } catch (err) {
      warn("publishesClaimsTo: recordPrediction failed for one claim, continuing", {
        owner: ownerId,
        err: (err as Error).message,
      });
      skipped++;
    }
  }
  return { persisted, skipped };
}

// ---------------------------------------------------------------------------
// Settle persistence (settlesPredictionsFor) — SINGLE SOURCE OF TRUTH
// ---------------------------------------------------------------------------

export interface SettlePersistResult {
  settled: number;
  skipped: number;
  /** Set when the whole payload was rejected (not a JSON array / unparseable). */
  reason?: "not-json" | "not-array";
}

const VALID_SETTLE_STATUS = new Set(["confirmed", "refuted", "partial"]);

/**
 * Parse a settle-verdict artifact and settle each referenced prediction via
 * {@link settlePrediction}. This is the EXACT REVERSE of
 * {@link persistClaimsFromArtifactValue} and the ONE implementation of the
 * `settlesPredictionsFor` contract — `template-executor.ts`'s post-step path and
 * its unit test both call this, so the test exercises the real code path.
 *
 * Verdict shape: `[{predictionId, status, outcome, newConfidence?, rewriteClaim?}]`.
 *
 * Best-effort and total: never throws on bad input. The `Array.isArray` guard is
 * non-negotiable (same rationale as the publish helper). Per `feedback_llm_not_reliable`,
 * the LLM-supplied `predictionId` is NEVER trusted blindly — each is validated against
 * the owner's CURRENT unsettled predictions (`getBelief`: exists ∧ roleId===owner ∧
 * kind==='prediction' ∧ settlementStatus unsettled). Unknown / cross-owner / already-settled
 * ids are skipped with a precise WARN — this is the harness boundary
 * (`feedback_harness_engineering`).
 *
 * @param artifactValue the artifact's stored value — already-parsed object/array,
 *   or a JSON string; both shapes are normalized here.
 */
export function settlePredictionsFromArtifactValue(
  ownerId: string,
  artifactValue: unknown,
  opts?: { today?: string; onWarn?: (msg: string, meta?: Record<string, unknown>) => void },
): SettlePersistResult {
  const warn = opts?.onWarn ?? (() => {});
  const today = opts?.today ?? new Date().toISOString().slice(0, 10);

  let parsed: unknown;
  if (typeof artifactValue === "string") {
    try {
      parsed = JSON.parse(artifactValue);
    } catch {
      warn("settlesPredictionsFor: artifact value is not valid JSON, skipping", { owner: ownerId });
      return { settled: 0, skipped: 0, reason: "not-json" };
    }
  } else {
    parsed = artifactValue;
  }

  if (!Array.isArray(parsed)) {
    warn("settlesPredictionsFor: artifact value is not a JSON array, skipping", {
      owner: ownerId,
      actualType: typeof parsed,
    });
    return { settled: 0, skipped: 0, reason: "not-array" };
  }

  let settled = 0;
  let skipped = 0;
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      warn("settlesPredictionsFor: malformed verdict entry skipped", { owner: ownerId });
      skipped++;
      continue;
    }
    const o = item as Record<string, unknown>;
    if (
      typeof o.predictionId !== "string"
      || typeof o.status !== "string"
      || !VALID_SETTLE_STATUS.has(o.status)
      || typeof o.outcome !== "string"
    ) {
      warn("settlesPredictionsFor: malformed verdict entry skipped", { owner: ownerId });
      skipped++;
      continue;
    }

    // Never trust the LLM-supplied id: validate ownership + unsettled state.
    const pred = getBelief(o.predictionId);
    if (
      !pred
      || pred.roleId !== ownerId
      || pred.kind !== "prediction"
      || pred.settlementStatus !== "unsettled"
    ) {
      warn("settlesPredictionsFor: predictionId not a settleable prediction for this owner, skipping", {
        owner: ownerId,
        predictionId: o.predictionId,
        found: !!pred,
        actualOwner: pred?.roleId,
        kind: pred?.kind,
        settlementStatus: pred?.settlementStatus,
      });
      skipped++;
      continue;
    }

    const newConfidence = typeof o.newConfidence === "number" ? o.newConfidence : undefined;
    const rewriteClaim = typeof o.rewriteClaim === "string" ? o.rewriteClaim : undefined;
    try {
      settlePrediction(o.predictionId, {
        status: o.status as "confirmed" | "refuted" | "partial",
        outcome: o.outcome,
        newConfidence,
        rewriteClaim,
        today,
      });
      settled++;
    } catch (err) {
      warn("settlesPredictionsFor: settlePrediction failed for one verdict, continuing", {
        owner: ownerId,
        predictionId: o.predictionId,
        err: (err as Error).message,
      });
      skipped++;
    }
  }
  return { settled, skipped };
}
