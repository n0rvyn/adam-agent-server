import type {
  ClaimSpec,
  ClaimSpecOutboundExpected,
  ClaimSpecFieldChangeExpected,
  ClaimSpecBatchExpected,
  ClaimAuditPerClaimResult,
  ClaimAuditResult,
  EffectReceipt,
  EffectReceiptFieldChange,
} from "../shared/types.js";

export interface VerifyInput {
  traceId: string;
  claims: ClaimSpec[];
  receipts: EffectReceipt[];
}

/**
 * Verifies declared claims against a trace's actual effect receipts.
 *
 * Filters receipts to outcome='success' internally (failure receipts are debugging
 * substrate per Phase 2 DP-002, not evidence). No time-window filter (Phase 3 DP-003).
 *
 * Returns per-claim verdicts. Overall status is 'blocked' iff any claim is blocked
 * (Phase 3 DP-002 — granular blocking).
 *
 * Matching semantics per kind:
 * - outbound: receipt with target.channelId == claim.target.channelId (chatId only
 *   compared when claim provides it), outcome=success, payload.attachmentCount >=
 *   claim.attachmentCount (when provided), payload.textChars > 0 (when textPresent=true).
 * - field_change: receipt with entityType=claim.entityType, entityId=claim.entityId,
 *   and a fieldChange entry where path=claim.fieldPath and op=claim.op AND content
 *   match per op (Phase 3 DP-001 superset for added/removed; deep-equal for set.after).
 * - batch: receipt with entityType=claim.entityType, AND either receipt.entityIds ⊇
 *   claim.entityIds (when claim provides entityIds), OR receipt.scope.matchedCount >=
 *   claim.scope.expectedCount (when claim provides scope).
 */
export function verifyClaimsAgainstReceipts(input: VerifyInput): ClaimAuditResult {
  const successReceipts = input.receipts.filter((r) => r.outcome === "success");
  const perClaim: ClaimAuditPerClaimResult[] = input.claims.map((claim) =>
    verifySingleClaim(claim, successReceipts),
  );
  const blockedClaims = perClaim.filter((p) => p.verdict === "blocked");
  const status = blockedClaims.length === 0 ? "passed" : "blocked";
  const replacementText = status === "blocked" ? buildReplacementText(blockedClaims) : undefined;
  // Note: claimSource is set by the caller (claim-receipt-auditor.ts) after synthesis.
  // unified-verifier is pure verification — it does not own provenance.
  // TODO(Phase 6 Task 6): remove this comment block once synthesizer is wired in.
  return { status, perClaim, replacementText, claimSource: "explicit" };
}

function verifySingleClaim(claim: ClaimSpec, receipts: EffectReceipt[]): ClaimAuditPerClaimResult {
  const exp = claim.expected;
  if (exp.kind === "outbound") return verifyOutboundClaim(claim, exp, receipts);
  if (exp.kind === "field_change") return verifyFieldChangeClaim(claim, exp, receipts);
  if (exp.kind === "batch") return verifyBatchClaim(claim, exp, receipts);
  return {
    claim,
    verdict: "blocked",
    matchedReceiptIds: [],
    missingEvidence: `unknown claim kind '${(exp as ClaimSpec["expected"]).kind}'`,
  };
}

function verifyOutboundClaim(
  claim: ClaimSpec,
  exp: ClaimSpecOutboundExpected,
  receipts: EffectReceipt[],
): ClaimAuditPerClaimResult {
  const matched: string[] = [];
  for (const r of receipts) {
    if (r.effectCategory !== "outbound_message") continue;
    if (!r.target || r.target.channelId !== exp.target.channelId) continue;
    if (exp.target.chatId !== undefined && r.target.chatId !== exp.target.chatId) continue;
    const payload = r.payload;
    if (!payload) continue;
    if (exp.attachmentCount !== undefined && payload.attachmentCount < exp.attachmentCount) continue;
    if (exp.textPresent === true && payload.textChars <= 0) continue;
    matched.push(r.id);
  }
  if (matched.length === 0) {
    const target = exp.target.chatId ? `${exp.target.channelId}/${exp.target.chatId}` : exp.target.channelId;
    const wantsAttach = exp.attachmentCount !== undefined ? `, attachmentCount>=${exp.attachmentCount}` : "";
    const wantsText = exp.textPresent ? ", textPresent" : "";
    return {
      claim,
      verdict: "blocked",
      matchedReceiptIds: [],
      missingEvidence: `outbound to ${target}${wantsAttach}${wantsText}: no matching success receipts`,
    };
  }
  return { claim, verdict: "passed", matchedReceiptIds: matched };
}

function verifyFieldChangeClaim(
  claim: ClaimSpec,
  exp: ClaimSpecFieldChangeExpected,
  receipts: EffectReceipt[],
): ClaimAuditPerClaimResult {
  const matched: string[] = [];
  for (const r of receipts) {
    if (r.effectCategory !== "entity_mutation") continue;
    if (r.entityType !== claim.entityType) continue;
    if (r.entityId !== exp.entityId) continue;
    if (!Array.isArray(r.fieldChanges)) continue;
    const matchingChange = r.fieldChanges.find((fc) => fc.path === exp.fieldPath && fc.op === exp.op);
    if (!matchingChange) continue;
    if (!fieldChangeContentMatches(exp, matchingChange)) continue;
    matched.push(r.id);
  }
  if (matched.length === 0) {
    return {
      claim,
      verdict: "blocked",
      matchedReceiptIds: [],
      missingEvidence: `field_change ${claim.entityType}/${exp.entityId} ${exp.op} ${exp.fieldPath}: no matching success receipts`,
    };
  }
  return { claim, verdict: "passed", matchedReceiptIds: matched };
}

function fieldChangeContentMatches(
  exp: ClaimSpecFieldChangeExpected,
  fc: EffectReceiptFieldChange,
): boolean {
  if (exp.op === "set") {
    return deepEqual(exp.after, fc.after);
  }
  if (exp.op === "list_add") {
    return isSubsetUsingDeepEqual(exp.added ?? [], fc.added ?? []);
  }
  if (exp.op === "list_remove") {
    return isSubsetUsingDeepEqual(exp.removed ?? [], fc.removed ?? []);
  }
  return false;
}

function verifyBatchClaim(
  claim: ClaimSpec,
  exp: ClaimSpecBatchExpected,
  receipts: EffectReceipt[],
): ClaimAuditPerClaimResult {
  const matched: string[] = [];
  for (const r of receipts) {
    if (r.effectCategory !== "entity_mutation") continue;
    if (r.entityType !== exp.entityType) continue;
    // entityIds superset
    if (exp.entityIds && exp.entityIds.length > 0) {
      const receiptIds = r.entityIds ?? (r.entityId ? [r.entityId] : []);
      if (!isSubsetUsingDeepEqual(exp.entityIds, receiptIds)) continue;
      matched.push(r.id);
      continue;
    }
    // scope matched_count
    if (exp.scope) {
      if (!r.scope || typeof r.scope.matchedCount !== "number") continue;
      if (r.scope.matchedCount < exp.scope.expectedCount) continue;
      matched.push(r.id);
      continue;
    }
  }
  if (matched.length === 0) {
    const what = exp.entityIds
      ? `entityIds superset of [${exp.entityIds.length} ids]`
      : `scope.matchedCount>=${exp.scope?.expectedCount ?? "?"}`;
    return {
      claim,
      verdict: "blocked",
      matchedReceiptIds: [],
      missingEvidence: `batch ${exp.entityType} ${what}: no matching success receipts`,
    };
  }
  return { claim, verdict: "passed", matchedReceiptIds: matched };
}

function isSubsetUsingDeepEqual(needles: unknown[], haystack: unknown[]): boolean {
  return needles.every((n) => haystack.some((h) => deepEqual(n, h)));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Render one blocked claim as a user-facing line. Text-derived stubs (completion
 *  language with no backing tool call) get a plain-language line; everything else
 *  shows the verifier's technical missingEvidence. */
function describeBlockedClaim(p: ClaimAuditPerClaimResult): string {
  const stub = p.claim.textDerivedStub;
  if (stub) {
    return `- 声称已完成「${stub.evidenceSpan}」操作，但本轮没有实际调用任何工具，无执行证据`;
  }
  return `- ${p.missingEvidence ?? "no evidence"}`;
}

function buildReplacementText(blockedClaims: ClaimAuditPerClaimResult[]): string {
  const reasons = blockedClaims.map(describeBlockedClaim).join("\n");
  // When every blocked claim is a text-derived stub, the model fabricated completion
  // without calling any tool — say so directly instead of the generic "操作已尝试" header
  // (no operation was actually attempted in that case).
  const allStub = blockedClaims.length > 0 && blockedClaims.every((p) => p.claim.textDerivedStub);
  const header = allStub
    ? "助手声称完成了以下操作，但本轮没有实际调用任何工具、无执行证据（很可能是模型幻觉了完成）："
    : "操作已尝试，但以下声称缺少证据，请在审计日志查看实际情况：";
  return `${header}\n${reasons}`;
}
