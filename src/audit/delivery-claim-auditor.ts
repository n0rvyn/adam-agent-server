import { detectTerminalDeliveryClaims, type CommitmentDetection } from "../chat/commitment-detector.js";
import { resolveEvidenceForDeliveryClaim, resolveDeliveryDiagnosticContext } from "./delivery-evidence-resolver.js";
import { buildEnrichedReplacementText, getUnsupportedFailureText, getUnsupportedSuccessText } from "../chat/commitment-replacement-text.js";
import type { AssistantCommitmentAuditResult } from "../shared/types.js";

export interface AuditDeliveryClaimsArgs {
  text: string;
  traceId?: string;
  sessionId?: string;
  taskId?: string;
}

export function auditDeliveryClaims(args: AuditDeliveryClaimsArgs): AssistantCommitmentAuditResult {
  const claims = detectTerminalDeliveryClaims(args.text);
  if (claims.length === 0) return { status: "passed" };

  const missing: CommitmentDetection[] = [];
  for (const claim of claims) {
    if (!hasEvidenceForClaim(claim, args)) missing.push(claim);
  }

  if (missing.length === 0) {
    return {
      status: "passed",
      claimType: claims.map((claim) => claim.type).join(","),
      claimText: claims.map((claim) => claim.text).join("\n"),
    };
  }

  const firstMissing = missing[0];
  const hasQueryContext = Boolean(args.taskId || args.traceId);
  let replacementText: string;

  if (hasQueryContext) {
    try {
      const diagnosticCtx = resolveDeliveryDiagnosticContext(firstMissing, {
        traceId: args.traceId,
        sessionId: args.sessionId,
        taskId: args.taskId,
      });
      replacementText = buildEnrichedReplacementText(firstMissing, diagnosticCtx);
    } catch {
      // Fall back to stock template if enriched build throws (safe default per threat model)
      replacementText = firstMissing.type === "delivery_failure_claim"
        ? getUnsupportedFailureText(firstMissing.locale)
        : getUnsupportedSuccessText(firstMissing.locale);
    }
  } else {
    // No taskId and no traceId — we didn't query delivery_log. Don't claim "no record"
    // when we didn't actually look. Use the stock template (existing behavior).
    replacementText = firstMissing.type === "delivery_failure_claim"
      ? getUnsupportedFailureText(firstMissing.locale)
      : getUnsupportedSuccessText(firstMissing.locale);
  }

  return {
    status: "blocked",
    claimType: missing.map((claim) => claim.type).join(","),
    claimText: missing.map((claim) => claim.text).join("\n"),
    reason: "Missing delivery evidence for terminal delivery claim",
    replacementText,
  };
}

function hasEvidenceForClaim(claim: CommitmentDetection, args: AuditDeliveryClaimsArgs): boolean {
  return resolveEvidenceForDeliveryClaim(claim, args).length > 0;
}
