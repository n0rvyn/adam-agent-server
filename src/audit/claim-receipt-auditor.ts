import { v4 as uuidv4 } from "uuid";
import { getDb } from "../store/db.js";
import { listClaimsByTrace } from "../store/assistant-claims.js";
import { listReceiptsByTrace } from "../store/effect-receipts.js";
import { verifyClaimsAgainstReceipts } from "./unified-verifier.js";
import { synthesizeImplicitClaims } from "./claim-synthesizer.js";
import type {
  AssistantClaimAudit,
  ClaimAuditPerClaimResult,
  ClaimAuditResult,
  ClaimSource,
} from "../shared/types.js";

export interface AuditClaimsForTurnArgs {
  traceId: string;
  sessionId?: string;
  messageId?: string;
  /** Assistant reply text — used for completion-language detection (Phase 6). */
  text?: string;
}

/**
 * Phase 6 audit entry point.
 *
 * Always persists one audit row tagged with `claimSource` from the synthesizer.
 * Conflicts (explicit vs implicit disagreement) force a "blocked" verdict with a
 * structured replacement text explaining the discrepancy.
 *
 * Phase 5 wiring is preserved: throws propagate to the caller's fail-open try/catch
 * so persist errors do not block the message.
 */
export function auditClaimsForTurn(args: AuditClaimsForTurnArgs): ClaimAuditResult {
  const traceId = args.traceId;

  // Skip persistence only when traceId is completely absent — avoids noise from no-trace callers.
  if (!traceId) {
    return { status: "passed", perClaim: [], claimSource: "vacuous" };
  }

  // Load explicit claims (from commit_claim tool calls in this trace).
  const claimRows = listClaimsByTrace(traceId);
  const explicitClaims = claimRows.flatMap((row) => row.claims);

  // Phase 6: synthesize implicit + explicit + text-hint claims.
  let synthResult: ReturnType<typeof synthesizeImplicitClaims>;
  let claimSource: ClaimSource;
  try {
    synthResult = synthesizeImplicitClaims({
      traceId,
      text: args.text ?? "",
      explicitClaims,
    });
    claimSource = synthResult.claimSource;
  } catch (err) {
    // Fail-open: fall back to Phase 5 explicit-only behavior.
    console.warn("[claim-receipt-auditor] synthesizeImplicitClaims threw:", err);
    claimSource = "fallback_legacy";
    if (explicitClaims.length === 0) {
      return { status: "passed", perClaim: [], claimSource };
    }
    const receipts = listReceiptsByTrace(traceId);
    const result = verifyClaimsAgainstReceipts({ traceId, claims: explicitClaims, receipts });
    const merged: ClaimAuditResult = { ...result, claimSource };
    persistClaimAudit({
      traceId, sessionId: args.sessionId, messageId: args.messageId,
      status: merged.status, perClaim: merged.perClaim,
      replacementText: merged.replacementText, claimSource,
    });
    return merged;
  }

  // Conflict override: when explicit claims inflate the implicit evidence, force block.
  if (synthResult.claimSource === "conflict") {
    const result: ClaimAuditResult = {
      status: "blocked",
      perClaim: [],
      claimSource,
      replacementText: `操作已尝试，但 commit_claim 与实际效果不一致：\n${synthResult.conflicts.map((c) => `- ${c.reason}`).join("\n")}`,
    };
    persistClaimAudit({
      traceId, sessionId: args.sessionId, messageId: args.messageId,
      status: result.status, perClaim: result.perClaim,
      replacementText: result.replacementText, claimSource,
    });
    return result;
  }

  // Load receipts for verification.
  const receipts = listReceiptsByTrace(traceId);

  // Silent-failure path: text says something was done but no receipts exist.
  // Verify stub claims so they correctly block when no evidence is available.
  if (synthResult.unmatchedCompletionLanguage) {
    const verifyResult = verifyClaimsAgainstReceipts({ traceId, claims: synthResult.claims, receipts });
    const result: ClaimAuditResult = {
      status: verifyResult.status,
      perClaim: verifyResult.perClaim,
      claimSource,
      replacementText: verifyResult.replacementText,
    };
    persistClaimAudit({
      traceId, sessionId: args.sessionId, messageId: args.messageId,
      status: result.status, perClaim: result.perClaim,
      replacementText: result.replacementText, claimSource,
    });
    return result;
  }

  // Normal path: vacuous, implicit, explicit, or hybrid.
  if (synthResult.claims.length === 0) {
    const result: ClaimAuditResult = { status: "passed", perClaim: [], claimSource };
    persistClaimAudit({
      traceId, sessionId: args.sessionId, messageId: args.messageId,
      status: result.status, perClaim: result.perClaim, claimSource,
    });
    return result;
  }

  const verifyResult = verifyClaimsAgainstReceipts({ traceId, claims: synthResult.claims, receipts });
  const result: ClaimAuditResult = {
    status: verifyResult.status,
    perClaim: verifyResult.perClaim,
    claimSource,
    replacementText: verifyResult.replacementText,
  };
  persistClaimAudit({
    traceId, sessionId: args.sessionId, messageId: args.messageId,
    status: result.status, perClaim: result.perClaim,
    replacementText: result.replacementText, claimSource,
  });
  return result;
}

interface PersistArgs {
  traceId: string;
  sessionId?: string;
  messageId?: string;
  status: "passed" | "blocked";
  perClaim: ClaimAuditPerClaimResult[];
  replacementText?: string;
  claimSource: ClaimSource;
}

function persistClaimAudit(args: PersistArgs): void {
  try {
    getDb().prepare(`
      INSERT INTO assistant_claim_audits (
        id, trace_id, session_id, message_id, status, per_claim_json,
        replacement_text, created_at, claim_source
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      args.traceId,
      args.sessionId ?? null,
      args.messageId ?? null,
      args.status,
      JSON.stringify(args.perClaim),
      args.replacementText ?? null,
      Date.now(),
      args.claimSource,
    );
  } catch (err) {
    // Fail-open: persist errors must not block the message.
    try {
      const { recordAuditDiagnostic } = require("../store/audit-diagnostics.js");
      recordAuditDiagnostic({
        source: "claim_receipt_auditor",
        severity: "warning",
        sourceId: args.sessionId,
        message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    } catch { /* swallow */ }
  }
}

export function listClaimAudits(traceId?: string): AssistantClaimAudit[] {
  const rows = traceId
    ? getDb().prepare("SELECT * FROM assistant_claim_audits WHERE trace_id = ? ORDER BY created_at ASC").all(traceId)
    : getDb().prepare("SELECT * FROM assistant_claim_audits ORDER BY created_at ASC").all();
  return (rows as Array<Record<string, unknown>>).map(rowToAudit);
}

function rowToAudit(row: Record<string, unknown>): AssistantClaimAudit {
  return {
    id: row.id as string,
    traceId: row.trace_id as string,
    sessionId: (row.session_id as string | null) ?? undefined,
    messageId: (row.message_id as string | null) ?? undefined,
    status: row.status as "passed" | "blocked",
    perClaim: JSON.parse(row.per_claim_json as string) as ClaimAuditPerClaimResult[],
    replacementText: (row.replacement_text as string | null) ?? undefined,
    createdAt: row.created_at as number,
    // Phase 6: claim_source column is always present (v65 default 'vacuous')
    claimSource: (row.claim_source as ClaimSource) ?? "vacuous",
  };
}
