import type { EffectReceiptInput } from "../shared/types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates an EffectReceiptInput before persistence. Returns structured errors
 * for the caller (writeEffectReceipt rejects invalid receipts).
 *
 * Rules enforced:
 * - traceId required at top level (every receipt belongs to a trace; verifier joins on this)
 * - actor.traceId, actor.toolName required (always)
 * - actor.traceId must equal top-level traceId (consistency: receipt's claimed actor must match the trace it lives in)
 * - effectCategory in {outbound_message, entity_mutation}
 * - verb non-empty
 * - entityType non-empty
 * - entityId XOR entityIds (mutually exclusive; never both)
 * - entity_mutation receipts must have entityId OR entityIds (Phase 3 verifier joins on entity to match field_change claims)
 * - outbound_message requires both target.channelId AND payload.textChars/attachmentCount
 * - entity_mutation requires either fieldChanges (non-empty array) OR scope (with filter+matchedCount)
 * - batch (entityIds) on entity_mutation must come with scope (helps verifier reason about coverage)
 */
export function validateReceipt(input: EffectReceiptInput): ValidationResult {
  const errors: string[] = [];

  // Top-level traceId required (every receipt belongs to a trace)
  if (!input.traceId) {
    errors.push("traceId is required");
  }

  // Actor required fields
  if (!input.actor) {
    errors.push("actor is required");
  } else {
    if (!input.actor.traceId) errors.push("actor.traceId is required");
    if (!input.actor.toolName) errors.push("actor.toolName is required");
    // Consistency: actor.traceId must match top-level traceId (when both present)
    if (input.traceId && input.actor.traceId && input.actor.traceId !== input.traceId) {
      errors.push(`actor.traceId ('${input.actor.traceId}') must equal top-level traceId ('${input.traceId}')`);
    }
  }

  // effectCategory
  if (input.effectCategory !== "outbound_message" && input.effectCategory !== "entity_mutation") {
    errors.push(`effectCategory must be 'outbound_message' or 'entity_mutation', got '${input.effectCategory}'`);
  }

  // verb / entityType non-empty
  if (!input.verb) errors.push("verb is required");
  if (!input.entityType) errors.push("entityType is required");

  // entityId XOR entityIds
  const hasEntityId = input.entityId !== undefined && input.entityId !== null;
  const hasEntityIds = Array.isArray(input.entityIds) && input.entityIds.length > 0;
  if (hasEntityId && hasEntityIds) {
    errors.push("entityId and entityIds are mutually exclusive — provide one only");
  }

  // Per-category required fields
  if (input.effectCategory === "outbound_message") {
    if (!input.target?.channelId) {
      errors.push("outbound_message receipts require target.channelId");
    }
    if (!input.payload || typeof input.payload.textChars !== "number" || typeof input.payload.attachmentCount !== "number") {
      errors.push("outbound_message receipts require payload with textChars and attachmentCount (numbers)");
    }
  }

  // Phase 2 DP-002: outcome must be 'success' or 'failure' if provided
  if (input.outcome !== undefined && input.outcome !== "success" && input.outcome !== "failure") {
    errors.push(`outcome must be 'success' or 'failure', got '${String(input.outcome)}'`);
  }

  if (input.effectCategory === "entity_mutation") {
    // Entity identity required (single or batch) — Phase 3 verifier joins on entity to match field_change claims.
    if (!hasEntityId && !hasEntityIds) {
      errors.push("entity_mutation receipts require entityId or entityIds (verifier needs an entity to anchor the change)");
    }
    const hasFieldChanges = Array.isArray(input.fieldChanges) && input.fieldChanges.length > 0;
    const hasScope = !!input.scope && typeof input.scope.matchedCount === "number" && !!input.scope.filter;
    if (!hasFieldChanges && !hasScope) {
      errors.push("entity_mutation receipts require either fieldChanges (non-empty) or scope (with filter+matchedCount)");
    }
    // Batch entity_mutation should declare scope
    if (hasEntityIds && !hasScope) {
      errors.push("batch entity_mutation receipts (entityIds set) require scope to describe the matched set");
    }
  }

  return { valid: errors.length === 0, errors };
}
