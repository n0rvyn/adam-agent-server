/**
 * Phase 4 verifier E2E: 6 scenarios exercising verifyClaimsAgainstReceipts with real receipts.
 *
 * Scenario 1: positive — outbound + mutation claims pass
 * Scenario 2: negative — outbound attachmentCount mismatch
 * Scenario 3: negative — entity_mutation field_change missing
 * Scenario 4: advisory — _entity round-trip on create
 * Scenario 5: advisory — batch claim with scope (pass + fail)
 * Scenario 6: advisory — failure receipts filtered
 */
import { describe, it, expect } from "vitest";
import { verifyClaimsAgainstReceipts } from "../../audit/unified-verifier.js";
import type { ClaimSpec, EffectReceipt, EffectReceiptFieldChangeOp } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Fixture helpers (matching the patterns in unified-verifier.test.ts)
// ---------------------------------------------------------------------------

function makeOutboundReceipt(overrides: Partial<EffectReceipt> & {
  channelId: string;
  attachmentCount?: number;
  textChars?: number;
  outcome?: "success" | "failure";
}): EffectReceipt {
  return {
    id: `r-outbound-${Math.random()}`,
    traceId: "trace-verifier-e2e",
    effectCategory: "outbound_message",
    verb: "send",
    entityType: "channel_message",
    entityId: `delivery_log:${Math.random()}`,
    target: {
      channelId: overrides.channelId,
      platform: "wechat",
    },
    payload: {
      textChars: overrides.textChars ?? 100,
      attachmentCount: overrides.attachmentCount ?? 3,
      attachmentRefs: [],
    },
    actor: { traceId: "trace-verifier-e2e", toolName: "send_to_channel" },
    outcome: overrides.outcome ?? "success",
    createdAt: Date.now(),
  } as EffectReceipt;
}

function makeMutationReceipt(overrides: {
  entityId?: string;
  entityType: string;
  verb: string;
  fieldChanges?: Array<{ path: string; op: EffectReceiptFieldChangeOp; before: unknown; after: unknown }>;
  entityIds?: string[];
  scope?: { filter: string; matchedCount: number };
  outcome?: "success" | "failure";
}): EffectReceipt {
  return {
    id: `r-mutation-${Math.random()}`,
    traceId: "trace-verifier-e2e",
    effectCategory: "entity_mutation",
    verb: overrides.verb,
    entityType: overrides.entityType,
    entityId: overrides.entityId,
    entityIds: overrides.entityIds,
    scope: overrides.scope,
    fieldChanges: overrides.fieldChanges,
    actor: { traceId: "trace-verifier-e2e", toolName: "test" },
    outcome: overrides.outcome ?? "success",
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("phase-4 verifier E2E", () => {
  describe("Scenario 1: positive — outbound + mutation claims both pass", () => {
    it("status=passed, both claims have matched receipts", () => {
      const receipts: EffectReceipt[] = [
        makeOutboundReceipt({ channelId: "ch-1", attachmentCount: 3 }),
        makeMutationReceipt({
          entityId: "tmpl-A",
          entityType: "task_template",
          verb: "update",
          fieldChanges: [
            { path: "name", op: "set", before: "old", after: "new" },
          ],
        }),
      ];

      const claims: ClaimSpec[] = [
        {
          verb: "send",
          entityType: "channel_message",
          expected: { kind: "outbound", target: { channelId: "ch-1" }, attachmentCount: 3 },
        },
        {
          verb: "update",
          entityType: "task_template",
          expected: {
            kind: "field_change",
            entityId: "tmpl-A",
            fieldPath: "name",
            op: "set",
            after: "new",
          },
        },
      ];

      const result = verifyClaimsAgainstReceipts({ traceId: "trace-verifier-e2e", claims, receipts });
      expect(result.status).toBe("passed");
      expect(result.perClaim).toHaveLength(2);
      expect(result.perClaim[0].verdict).toBe("passed");
      expect(result.perClaim[0].matchedReceiptIds.length).toBeGreaterThan(0);
      expect(result.perClaim[1].verdict).toBe("passed");
      expect(result.perClaim[1].matchedReceiptIds.length).toBeGreaterThan(0);
    });
  });

  describe("Scenario 2: negative — outbound attachmentCount mismatch", () => {
    it("status=blocked, replacement_text mentions attachment", () => {
      const receipts: EffectReceipt[] = [
        makeOutboundReceipt({ channelId: "ch-1", attachmentCount: 3 }),
      ];

      const claims: ClaimSpec[] = [
        {
          verb: "send",
          entityType: "channel_message",
          expected: { kind: "outbound", target: { channelId: "ch-1" }, attachmentCount: 10 },
        },
      ];

      const result = verifyClaimsAgainstReceipts({ traceId: "trace-verifier-e2e", claims, receipts });
      expect(result.status).toBe("blocked");
      expect(result.perClaim[0].verdict).toBe("blocked");
      expect(result.perClaim[0].matchedReceiptIds).toHaveLength(0);
      expect(result.replacementText).toBeDefined();
      expect(result.replacementText!.toLowerCase()).toContain("attachment");
    });
  });

  describe("Scenario 3: negative — entity_mutation field_change missing", () => {
    it("status=blocked, replacement_text mentions the missing field", () => {
      const receipts: EffectReceipt[] = [
        makeMutationReceipt({
          entityId: "tmpl-B",
          entityType: "task_template",
          verb: "update",
          fieldChanges: [
            { path: "name", op: "set", before: "old", after: "new" },
          ],
        }),
      ];

      const claims: ClaimSpec[] = [
        {
          verb: "update",
          entityType: "task_template",
          expected: {
            kind: "field_change",
            entityId: "tmpl-B",
            fieldPath: "enabled",
            op: "set",
            after: false,
          },
        },
      ];

      const result = verifyClaimsAgainstReceipts({ traceId: "trace-verifier-e2e", claims, receipts });
      expect(result.status).toBe("blocked");
      expect(result.perClaim[0].verdict).toBe("blocked");
      expect(result.perClaim[0].matchedReceiptIds).toHaveLength(0);
      // missingEvidence should mention the field_path mismatch
      expect(result.perClaim[0].missingEvidence).toBeDefined();
    });
  });

  describe("Scenario 4: advisory — _entity round-trip on create", () => {
    it("create receipt with _entity fieldChange satisfies a field_change claim on the same entityId", () => {
      const goalSnapshot = {
        id: "goal-X",
        name: "Test Goal",
        status: "active",
        currentValue: 0,
        targetValue: 100,
      };

      const receipts: EffectReceipt[] = [
        makeMutationReceipt({
          entityId: "goal-X",
          entityType: "goal",
          verb: "create",
          fieldChanges: [
            { path: "_entity", op: "set", before: null, after: goalSnapshot },
          ],
        }),
      ];

      const claims: ClaimSpec[] = [
        {
          verb: "create",
          entityType: "goal",
          expected: {
            kind: "field_change",
            entityId: "goal-X",
            fieldPath: "_entity",
            op: "set",
            after: goalSnapshot,
          },
        },
      ];

      const result = verifyClaimsAgainstReceipts({ traceId: "trace-verifier-e2e", claims, receipts });
      expect(result.status).toBe("passed");
      expect(result.perClaim[0].verdict).toBe("passed");
    });
  });

  describe("Scenario 5: advisory — batch claim with scope (pass + fail)", () => {
    it("scope.matchedCount >= expectedCount: passed", () => {
      const receipts: EffectReceipt[] = [
        makeMutationReceipt({
          entityType: "task",
          verb: "cancel",
          entityIds: ["task-a", "task-b", "task-c"],
          scope: { filter: "status=running", matchedCount: 3 },
        }),
      ];

      const claims: ClaimSpec[] = [
        {
          verb: "cancel",
          entityType: "task",
          expected: {
            kind: "batch",
            entityType: "task",
            scope: { filter: "status=running", expectedCount: 3 },
          },
        },
      ];

      const result = verifyClaimsAgainstReceipts({ traceId: "trace-verifier-e2e", claims, receipts });
      expect(result.status).toBe("passed");
      expect(result.perClaim[0].verdict).toBe("passed");
    });

    it("scope.matchedCount < expectedCount: blocked", () => {
      const receipts: EffectReceipt[] = [
        makeMutationReceipt({
          entityType: "task",
          verb: "cancel",
          entityIds: ["task-a", "task-b", "task-c"],
          scope: { filter: "status=running", matchedCount: 3 },
        }),
      ];

      const claims: ClaimSpec[] = [
        {
          verb: "cancel",
          entityType: "task",
          expected: {
            kind: "batch",
            entityType: "task",
            scope: { filter: "status=running", expectedCount: 5 },
          },
        },
      ];

      const result = verifyClaimsAgainstReceipts({ traceId: "trace-verifier-e2e", claims, receipts });
      expect(result.status).toBe("blocked");
      expect(result.perClaim[0].verdict).toBe("blocked");
    });
  });

  describe("Scenario 6: advisory — failure receipts filtered (not evidence)", () => {
    it("outbound_message receipt with outcome=failure does NOT satisfy outbound claim", () => {
      const receipts: EffectReceipt[] = [
        makeOutboundReceipt({ channelId: "ch-1", outcome: "failure" }),
      ];

      const claims: ClaimSpec[] = [
        {
          verb: "send",
          entityType: "channel_message",
          expected: { kind: "outbound", target: { channelId: "ch-1" } },
        },
      ];

      const result = verifyClaimsAgainstReceipts({ traceId: "trace-verifier-e2e", claims, receipts });
      expect(result.status).toBe("blocked");
      expect(result.perClaim[0].verdict).toBe("blocked");
      // The missing evidence should indicate no success receipt matched
      expect(result.perClaim[0].matchedReceiptIds).toHaveLength(0);
    });
  });
});
