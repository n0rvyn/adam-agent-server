import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { writeEffectReceipt } from "../../store/effect-receipts.js";
import { synthesizeImplicitClaims } from "../../audit/claim-synthesizer.js";
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
// Tests — 7 provenance paths
// ---------------------------------------------------------------------------

describe("synthesizeImplicitClaims", () => {
  // Path 1: vacuous — no receipts, no explicit, no text completion
  it("vacuous: no receipts, no explicit, no completion language → claimSource vacuous, empty claims", () => {
    const result = synthesizeImplicitClaims({ traceId: "550e8400-e29b-41d4-a716-446655440000", text: "你好，今天天气不错。" });
    expect(result.claimSource).toBe("vacuous");
    expect(result.claims).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.unmatchedCompletionLanguage).toBe(false);
  });

  // Path 2: implicit only (Scenario A/B happy path)
  it("implicit only: 1 outbound receipt, text has completion language, no explicit → claimSource implicit, 1 claim", () => {
    writeEffectReceipt(makeOutboundReceipt({
      traceId: "550e8400-e29b-41d4-a716-446655440001",
      channelId: "ch-role-xyz",
      attachmentCount: 0,
      textChars: 10,
      outcome: "success",
    }));
    const result = synthesizeImplicitClaims({
      traceId: "550e8400-e29b-41d4-a716-446655440001",
      text: "✅ Role 已创建",
    });
    expect(result.claimSource).toBe("implicit");
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].expected.kind).toBe("outbound");
    expect((result.claims[0].expected as any).target?.channelId).toBe("ch-role-xyz");
    expect(result.conflicts).toHaveLength(0);
  });

  // Path 3: explicit only
  it("explicit only: no receipts, explicit claim provided → claimSource explicit, 1 claim", () => {
    const result = synthesizeImplicitClaims({
      traceId: "550e8400-e29b-41d4-a716-446655440002",
      text: "Done.",
      explicitClaims: [{
        verb: "update",
        entityType: "role",
        expected: { kind: "field_change", entityId: "role-xyz", fieldPath: "name", op: "set", after: "NewName" },
      }],
    });
    expect(result.claimSource).toBe("explicit");
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].verb).toBe("update");
    expect(result.conflicts).toHaveLength(0);
  });

  // Path 4: hybrid consistent — dedup key includes full target, so two distinct outbound targets are separate claims
  it("hybrid consistent: 1 outbound receipt + 1 matching explicit for same target → claimSource hybrid", () => {
    writeEffectReceipt(makeOutboundReceipt({
      traceId: "550e8400-e29b-41d4-a716-446655440003",
      channelId: "ch-A",
      attachmentCount: 14,
      textChars: 50,
      outcome: "success",
    }));
    const result = synthesizeImplicitClaims({
      traceId: "550e8400-e29b-41d4-a716-446655440003",
      text: "Delivered.",
      explicitClaims: [{
        verb: "send",
        entityType: "channel_message",
        expected: { kind: "outbound", target: { channelId: "ch-A" }, attachmentCount: 14 },
      }],
    });
    expect(result.claimSource).toBe("hybrid");
    // Dedup key includes full expected object — same target channelId + same attachmentCount → 1 claim
    expect(result.claims).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
  });

  // Path 5: conflict outbound
  it("conflict outbound: outbound receipt attachmentCount=0, explicit claims attachmentCount=14 → claimSource conflict, conflicts populated", () => {
    writeEffectReceipt(makeOutboundReceipt({
      traceId: "550e8400-e29b-41d4-a716-446655440004",
      channelId: "ch-A",
      attachmentCount: 0,
      textChars: 0,
      outcome: "success",
    }));
    const result = synthesizeImplicitClaims({
      traceId: "550e8400-e29b-41d4-a716-446655440004",
      text: "✅ 14 attachments sent.",
      explicitClaims: [{
        verb: "send",
        entityType: "channel_message",
        expected: { kind: "outbound", target: { channelId: "ch-A" }, attachmentCount: 14 },
      }],
    });
    expect(result.claimSource).toBe("conflict");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].reason).toContain("14");
    expect(result.conflicts[0].reason).toContain("0");
    // claims returned is explicit (verifier will block on inflated claim)
    expect(result.claims).toHaveLength(1);
  });

  // Path 6: silent failure (Scenario C)
  it("silent failure: no receipts, text says '已补发' → claimSource implicit, unmatchedCompletionLanguage true, 1 stub claim with verb send", () => {
    const result = synthesizeImplicitClaims({
      traceId: "550e8400-e29b-41d4-a716-446655440005",
      text: "✅ 已补发，norvyn@example.org 已收到。",
      explicitClaims: [],
    });
    expect(result.claimSource).toBe("implicit");
    expect(result.unmatchedCompletionLanguage).toBe(true);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].verb).toBe("send");
    expect(result.claims[0].entityType).toBe("_unknown");
    expect(result.claims[0].expected.kind).toBe("outbound");
    expect((result.claims[0].expected as any).target?.channelId).toBe("_unspecified");
    expect(result.claims[0].note).toContain("text-derived-stub");
  });

  // Path 7: negation handling
  it("negation: text contains '没发送' → no completion language detected → claimSource vacuous", () => {
    const result = synthesizeImplicitClaims({
      traceId: "550e8400-e29b-41d4-a716-446655440006",
      text: "我**没**发送邮件。",
      explicitClaims: [],
    });
    expect(result.claimSource).toBe("vacuous");
    expect(result.claims).toHaveLength(0);
    expect(result.unmatchedCompletionLanguage).toBe(false);
  });

  // Additional: mixed trace (3 receipts: 1 outbound + 1 mutation + 1 failure) → 2 implicit claims
  it("mixed trace: 1 outbound + 1 mutation (entityIds) + 1 failure receipt → failure dropped, 2 claims returned", () => {
    const traceId = "550e8400-e29b-41d4-a716-446655440007";
    writeEffectReceipt(makeOutboundReceipt({ traceId, channelId: "ch-A", attachmentCount: 5, outcome: "success" }));
    writeEffectReceipt(makeMutationReceipt({ traceId, entityId: "tpl-1", fieldPath: "tags", op: "list_add", added: ["urgent"], outcome: "success" }));
    writeEffectReceipt(makeOutboundReceipt({ traceId, channelId: "ch-B", attachmentCount: 3, outcome: "failure" })); // failure filtered
    const result = synthesizeImplicitClaims({ traceId, text: "Done." });
    expect(result.claimSource).toBe("implicit");
    expect(result.claims).toHaveLength(2);
  });
});
