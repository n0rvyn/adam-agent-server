import { listReceiptsByTrace } from "../store/effect-receipts.js";
import type { ClaimSpec } from "../shared/types.js";

/** Validates traceId is UUID-shaped. Returns false for empty/null/invalid. */
function isValidTraceId(traceId: string): boolean {
  if (!traceId || typeof traceId !== "string") return false;
  return /^[a-f0-9-]{32,36}$/i.test(traceId);
}

/**
 * Reverse-maps a trace's success effect receipts into ClaimSpec[].
 *
 * Each receipt becomes one implicit claim:
 * - outbound_message  → kind=outbound, propagates target + payload counts
 * - entity_mutation   → kind=batch (entityIds[] or scope.matchedCount)
 *                      OR kind=field_change (entityId + fieldChanges[0])
 *
 * Failure receipts (outcome != 'success') are excluded — they are debugging
 * substrate per Phase 2 DP-002, not evidence.
 *
 * @returns empty array on invalid/empty traceId (no throw)
 */
export function deriveClaimsFromReceipts(traceId: string): ClaimSpec[] {
  if (!isValidTraceId(traceId)) return [];

  const receipts = listReceiptsByTrace(traceId);
  const successReceipts = receipts.filter((r) => r.outcome === "success");

  const claims: Array<ClaimSpec | null> = successReceipts.map((r) => {
    if (r.effectCategory === "outbound_message") {
      // outbound_message → kind=outbound
      if (!r.target || !r.payload) return null;
      return {
        verb: r.verb,
        entityType: r.entityType,
        expected: {
          kind: "outbound",
          target: {
            channelId: r.target.channelId,
            chatId: r.target.chatId,
          },
          attachmentCount: r.payload.attachmentCount,
          textPresent: r.payload.textChars > 0,
        },
        note: `implicit:from-receipt:${r.id}`,
      };
    }

    if (r.effectCategory === "entity_mutation") {
      // entity_mutation with entityIds[] → kind=batch (entityIds superset)
      if (r.entityIds && r.entityIds.length > 0) {
        return {
          verb: r.verb,
          entityType: r.entityType,
          expected: {
            kind: "batch",
            entityType: r.entityType,
            entityIds: r.entityIds,
          },
          note: `implicit:from-receipt:${r.id}`,
        };
      }

      // entity_mutation with scope.matchedCount → kind=batch (scope count)
      if (r.scope && typeof r.scope.matchedCount === "number") {
        return {
          verb: r.verb,
          entityType: r.entityType,
          expected: {
            kind: "batch",
            entityType: r.entityType,
            scope: {
              filter: r.scope.filter,
              expectedCount: r.scope.matchedCount,
            },
          },
          note: `implicit:from-receipt:${r.id}`,
        };
      }

      // entity_mutation with entityId + fieldChanges[0] → kind=field_change
      if (r.entityId && Array.isArray(r.fieldChanges) && r.fieldChanges.length > 0) {
        const fc = r.fieldChanges[0];
        return {
          verb: r.verb,
          entityType: r.entityType,
          expected: {
            kind: "field_change",
            entityId: r.entityId,
            fieldPath: fc.path,
            op: fc.op,
            added: fc.added,
            removed: fc.removed,
            after: fc.after,
          },
          note: `implicit:from-receipt:${r.id}`,
        };
      }

      // Insufficient shape data — skip
      return null;
    }

    return null;
  });

  return claims.filter((c): c is ClaimSpec => c !== null);
}
