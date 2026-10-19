import type { ClaimSpec, ClaimSpecExpected } from "../shared/types.js";

export interface ClaimValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a ClaimSpec before persistence. Rules:
 * - verb non-empty
 * - entityType non-empty
 * - expected.kind ∈ {outbound, field_change, batch}
 * - outbound: requires target.channelId; if attachmentCount provided must be >= 0
 * - field_change: requires entityId + fieldPath + op; op-specific shape:
 *     op=set → after required; added/removed must be absent
 *     op=list_add → added (non-empty array) required; after/removed must be absent
 *     op=list_remove → removed (non-empty array) required; after/added must be absent
 * - batch: requires entityType; at least one of entityIds (non-empty) or scope (with filter+expectedCount>=0)
 */
export function validateClaim(claim: ClaimSpec): ClaimValidationResult {
  const errors: string[] = [];

  if (!claim.verb) errors.push("verb is required");
  if (!claim.entityType) errors.push("entityType is required");
  if (!claim.expected) {
    errors.push("expected is required");
    return { valid: false, errors };
  }

  const exp = claim.expected;
  if (exp.kind === "outbound") {
    if (!exp.target?.channelId) errors.push("expected.target.channelId is required for outbound");
    if (exp.attachmentCount !== undefined && (typeof exp.attachmentCount !== "number" || exp.attachmentCount < 0)) {
      errors.push("expected.attachmentCount must be a non-negative number");
    }
  } else if (exp.kind === "field_change") {
    if (!exp.entityId) errors.push("expected.entityId is required for field_change");
    if (!exp.fieldPath) errors.push("expected.fieldPath is required for field_change");
    if (exp.op !== "set" && exp.op !== "list_add" && exp.op !== "list_remove") {
      errors.push(`expected.op must be 'set', 'list_add', or 'list_remove'`);
    }
    if (exp.op === "set") {
      if (exp.after === undefined) errors.push("expected.after is required when op='set'");
      if (exp.added !== undefined || exp.removed !== undefined) errors.push("expected.added/removed must be absent when op='set'");
    }
    if (exp.op === "list_add") {
      if (!Array.isArray(exp.added) || exp.added.length === 0) errors.push("expected.added (non-empty array) is required when op='list_add'");
      if (exp.after !== undefined || exp.removed !== undefined) errors.push("expected.after/removed must be absent when op='list_add'");
    }
    if (exp.op === "list_remove") {
      if (!Array.isArray(exp.removed) || exp.removed.length === 0) errors.push("expected.removed (non-empty array) is required when op='list_remove'");
      if (exp.after !== undefined || exp.added !== undefined) errors.push("expected.after/added must be absent when op='list_remove'");
    }
  } else if (exp.kind === "batch") {
    if (!exp.entityType) errors.push("expected.entityType is required for batch");
    const hasIds = Array.isArray(exp.entityIds) && exp.entityIds.length > 0;
    const hasScope = !!exp.scope && typeof exp.scope.expectedCount === "number" && exp.scope.expectedCount >= 0 && !!exp.scope.filter;
    if (!hasIds && !hasScope) errors.push("batch claims require entityIds (non-empty) or scope (with filter + non-negative expectedCount)");
  } else {
    // exhaustiveness — _never narrows expected to never; runtime catch for tampered input
    errors.push(`expected.kind must be 'outbound', 'field_change', or 'batch'; got '${(exp as ClaimSpecExpected).kind}'`);
  }

  return { valid: errors.length === 0, errors };
}

export class InvalidClaimError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid claim spec: ${errors.join("; ")}`);
    this.name = "InvalidClaimError";
  }
}
