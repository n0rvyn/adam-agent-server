import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { writeEffectReceipt } from "../../store/effect-receipts.js";
import { writeClaims } from "../../store/assistant-claims.js";
import { auditClaimsForTurn, listClaimAudits } from "../../audit/claim-receipt-auditor.js";
import type { EffectReceiptInput } from "../../shared/types.js";

const { cleanup } = setupTestDb();

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOutboundReceipt(overrides: {
  traceId?: string;
  channelId: string;
  chatId?: string;
  attachmentCount?: number;
  textChars?: number;
  outcome?: "success" | "failure";
}): EffectReceiptInput {
  const traceId = overrides.traceId ?? "t-shared";
  return {
    traceId,
    effectCategory: "outbound_message",
    verb: "send",
    entityType: "channel_message",
    entityId: `delivery_log:r${Math.random().toString(36).slice(2, 6)}`,
    target: {
      channelId: overrides.channelId,
      chatId: overrides.chatId,
      platform: "wechat",
    },
    payload: {
      textChars: overrides.textChars ?? 100,
      attachmentCount: overrides.attachmentCount ?? 0,
      attachmentRefs: [],
    },
    actor: { traceId, toolName: "test" },
    outcome: overrides.outcome,
  };
}

function makeMutationReceipt(overrides: {
  traceId?: string;
  entityId: string;
  fieldPath: string;
  op: "set" | "list_add" | "list_remove";
  after?: unknown;
  added?: unknown[];
  removed?: unknown[];
  outcome?: "success" | "failure";
}): EffectReceiptInput {
  const traceId = overrides.traceId ?? "t-shared";
  return {
    traceId,
    effectCategory: "entity_mutation",
    verb: "update",
    entityType: "task_template",
    entityId: overrides.entityId,
    fieldChanges: [{
      path: overrides.fieldPath,
      op: overrides.op,
      after: overrides.after,
      added: overrides.added,
      removed: overrides.removed,
    }],
    actor: { traceId, toolName: "test" },
    outcome: overrides.outcome,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auditClaimsForTurn", () => {
  it("returns passed and persists vacuous row when there are no claims in the trace (Phase 6 always persists)", () => {
    const result = auditClaimsForTurn({ traceId: "t-empty" });
    expect(result.status).toBe("passed");
    expect(result.perClaim).toEqual([]);
    // Phase 6: always persists a vacuous row for valid traceId
    const audits = listClaimAudits("t-empty");
    expect(audits).toHaveLength(1);
    expect(audits[0].claimSource).toBe("vacuous");
    expect(audits[0].status).toBe("passed");
  });

  it("passes a trace with outbound + field_change claims when receipts support both", () => {
    // 1. write a successful outbound receipt with attachmentCount=14 to ch-A
    writeEffectReceipt(makeOutboundReceipt({
      traceId: "t-1",
      channelId: "ch-A",
      attachmentCount: 14,
      textChars: 200,
    }));
    // 2. write a successful entity_mutation receipt: template tpl-1 list_add deliverTo [ch-A]
    writeEffectReceipt(makeMutationReceipt({
      traceId: "t-1",
      entityId: "tpl-1",
      fieldPath: "deliverTo",
      op: "list_add",
      added: ["ch-A"],
    }));
    // 3. declare matching claims
    writeClaims({ traceId: "t-1", claims: [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" }, attachmentCount: 14 } },
      { verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "tpl-1", fieldPath: "deliverTo", op: "list_add", added: ["ch-A"] } },
    ]});
    const result = auditClaimsForTurn({ traceId: "t-1", sessionId: "s-1", messageId: "m-1" });
    expect(result.status).toBe("passed");
    expect(result.perClaim).toHaveLength(2);
    expect(result.perClaim.every((p) => p.verdict === "passed")).toBe(true);
    // Audit row was persisted
    const audits = listClaimAudits("t-1");
    expect(audits).toHaveLength(1);
    expect(audits[0].status).toBe("passed");
    expect(audits[0].sessionId).toBe("s-1");
    expect(audits[0].messageId).toBe("m-1");
  });

  it("blocks when outbound claim's attachmentCount exceeds receipt's", () => {
    writeEffectReceipt(makeOutboundReceipt({ traceId: "t-2", channelId: "ch-A", attachmentCount: 0 }));
    writeClaims({ traceId: "t-2", claims: [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" }, attachmentCount: 14 } },
    ]});
    const result = auditClaimsForTurn({ traceId: "t-2" });
    expect(result.status).toBe("blocked");
    expect(result.perClaim[0].verdict).toBe("blocked");
    expect(result.replacementText).toContain("ch-A");
    // Audit row persisted with replacement_text
    const audits = listClaimAudits("t-2");
    expect(audits).toHaveLength(1);
    expect(audits[0].replacementText).toBeTruthy();
    expect(audits[0].status).toBe("blocked");
  });

  it("filters failure receipts — failure receipt does NOT support a claim", () => {
    writeEffectReceipt(makeOutboundReceipt({ traceId: "t-3", channelId: "ch-A", attachmentCount: 14, outcome: "failure" }));
    writeClaims({ traceId: "t-3", claims: [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" }, attachmentCount: 14 } },
    ]});
    const result = auditClaimsForTurn({ traceId: "t-3" });
    expect(result.status).toBe("blocked");
    expect(result.perClaim[0].verdict).toBe("blocked");
  });

  it("flattens claims across multiple commit_claim calls in the same trace", () => {
    writeEffectReceipt(makeOutboundReceipt({ traceId: "t-4", channelId: "ch-A", attachmentCount: 14 }));
    writeEffectReceipt(makeOutboundReceipt({ traceId: "t-4", channelId: "ch-B", attachmentCount: 14 }));
    writeClaims({ traceId: "t-4", claims: [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" }, attachmentCount: 14 } },
    ]});
    writeClaims({ traceId: "t-4", claims: [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-B" }, attachmentCount: 14 } },
    ]});
    const result = auditClaimsForTurn({ traceId: "t-4" });
    expect(result.status).toBe("passed");
    expect(result.perClaim).toHaveLength(2);
    expect(result.perClaim[0].verdict).toBe("passed");
    expect(result.perClaim[1].verdict).toBe("passed");
  });

  it("audit row's per_claim_json round-trips through listClaimAudits", () => {
    writeEffectReceipt(makeOutboundReceipt({ traceId: "t-5", channelId: "ch-A", attachmentCount: 14 }));
    writeClaims({ traceId: "t-5", claims: [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" }, attachmentCount: 14 }, note: "human note" },
    ]});
    auditClaimsForTurn({ traceId: "t-5" });
    const audits = listClaimAudits("t-5");
    expect(audits).toHaveLength(1);
    expect(audits[0].perClaim[0].claim.note).toBe("human note");
    expect(audits[0].perClaim[0].matchedReceiptIds).toHaveLength(1);
  });

  it("persists vacuous row when no claims exist in trace (Phase 6 always persists)", () => {
    writeEffectReceipt(makeOutboundReceipt({ traceId: "t-no-claims", channelId: "ch-A" }));
    auditClaimsForTurn({ traceId: "t-no-claims" });
    const audits = listClaimAudits("t-no-claims");
    expect(audits).toHaveLength(1);
    expect(audits[0].claimSource).toBe("vacuous");
    expect(audits[0].status).toBe("passed");
    expect(audits[0].perClaim).toEqual([]);
  });

  it("returns passed when traceId is empty string", () => {
    const result = auditClaimsForTurn({ traceId: "" });
    expect(result.status).toBe("passed");
    expect(result.perClaim).toEqual([]);
  });

  it("matchedReceiptIds contain actual effect_receipts.id values", () => {
    const receipt = writeEffectReceipt(makeOutboundReceipt({ traceId: "t-match-ids", channelId: "ch-A", attachmentCount: 5 }));
    writeClaims({ traceId: "t-match-ids", claims: [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" }, attachmentCount: 5 } },
    ]});
    const result = auditClaimsForTurn({ traceId: "t-match-ids" });
    expect(result.perClaim[0].matchedReceiptIds).toContain(receipt.id);
  });
});
