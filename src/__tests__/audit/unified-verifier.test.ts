import { describe, it, expect } from "vitest";
import { verifyClaimsAgainstReceipts } from "../../audit/unified-verifier.js";
import type { ClaimSpec, EffectReceipt } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeOutboundReceipt(overrides: Partial<EffectReceipt> & {
  channelId: string;
  attachmentCount?: number;
  textChars?: number;
  outcome?: "success" | "failure";
  chatId?: string;
}): EffectReceipt {
  return {
    id: "r-outbound",
    traceId: "trace-x",
    effectCategory: "outbound_message",
    verb: "send",
    entityType: "channel_message",
    entityId: `delivery_log:${Math.random()}`,
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
    actor: { traceId: "trace-x", toolName: "test" },
    outcome: overrides.outcome ?? "success",
    createdAt: Date.now(),
    ...overrides,
  } as EffectReceipt;
}

function makeMutationReceipt(overrides: Omit<EffectReceipt, "id" | "traceId" | "effectCategory" | "verb" | "entityId" | "entityType" | "actor" | "outcome" | "createdAt"> & {
  entityId: string;
  entityType?: string;
  fieldChanges?: EffectReceipt["fieldChanges"];
  outcome?: "success" | "failure";
}): EffectReceipt {
  return {
    id: "r-mutation",
    traceId: "trace-x",
    effectCategory: "entity_mutation",
    verb: "update",
    entityType: "task_template",
    entityId: overrides.entityId,
    fieldChanges: overrides.fieldChanges ?? [],
    actor: { traceId: "trace-x", toolName: "test" },
    outcome: overrides.outcome ?? "success",
    createdAt: Date.now(),
  };
}

function makeBatchReceipt(overrides: Omit<EffectReceipt, "id" | "traceId" | "effectCategory" | "verb" | "entityType" | "actor" | "outcome" | "createdAt"> & {
  entityType: string;
  entityIds?: string[];
  scope?: EffectReceipt["scope"];
  outcome?: "success" | "failure";
}): EffectReceipt {
  return {
    id: "r-batch",
    traceId: "trace-x",
    effectCategory: "entity_mutation",
    verb: "cancel",
    entityType: overrides.entityType,
    entityIds: overrides.entityIds,
    scope: overrides.scope,
    actor: { traceId: "trace-x", toolName: "test" },
    outcome: overrides.outcome ?? "success",
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verifyClaimsAgainstReceipts", () => {
  // ---- outbound kind ----

  it("passes: outbound target+attachmentCount match", () => {
    const receipts = [makeOutboundReceipt({ channelId: "ch-A", attachmentCount: 14 })];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" }, attachmentCount: 14 } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("passed");
    expect(result.perClaim[0].verdict).toBe("passed");
    expect(result.perClaim[0].matchedReceiptIds).toContain("r-outbound");
  });

  it("passes: outbound target match with no attachmentCount in claim", () => {
    const receipts = [makeOutboundReceipt({ channelId: "ch-A" })];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("passed");
  });

  it("passes: outbound chatId match when claim provides chatId", () => {
    const receipts = [makeOutboundReceipt({ channelId: "ch-A", chatId: "chat-123" })];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A", chatId: "chat-123" } } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("passed");
  });

  it("passes: outbound when claim omits chatId (any chatId on receipt matches)", () => {
    const receipts = [makeOutboundReceipt({ channelId: "ch-A", chatId: "chat-123" })];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("passed");
  });

  it("blocks: outbound target.channelId mismatch", () => {
    const receipts = [makeOutboundReceipt({ channelId: "ch-A" })];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-B" } } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
    expect(result.perClaim[0].verdict).toBe("blocked");
    expect(result.perClaim[0].missingEvidence).toContain("ch-B");
  });

  it("blocks: outbound target.chatId mismatch when claim provides one", () => {
    const receipts = [makeOutboundReceipt({ channelId: "ch-A", chatId: "chat-123" })];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A", chatId: "chat-456" } } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
  });

  it("blocks: outbound attachmentCount < claimed", () => {
    const receipts = [makeOutboundReceipt({ channelId: "ch-A", attachmentCount: 3 })];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" }, attachmentCount: 14 } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
    expect(result.perClaim[0].missingEvidence).toContain("attachmentCount");
  });

  it("blocks: outbound textPresent=true but receipt.textChars=0", () => {
    const receipts = [makeOutboundReceipt({ channelId: "ch-A", textChars: 0 })];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" }, textPresent: true } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
    expect(result.perClaim[0].missingEvidence).toContain("textPresent");
  });

  it("blocks: outbound receipt is outcome=failure (filtered out)", () => {
    const receipts = [makeOutboundReceipt({ channelId: "ch-A", outcome: "failure" })];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
    expect(result.perClaim[0].matchedReceiptIds).toHaveLength(0);
  });

  it("blocks: outbound no receipts at all", () => {
    const receipts: EffectReceipt[] = [];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
  });

  it("missingEvidence text mentions target + attachmentCount when blocked", () => {
    const receipts = [makeOutboundReceipt({ channelId: "ch-A", attachmentCount: 5 })];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" }, attachmentCount: 14 } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.perClaim[0].missingEvidence).toContain("ch-A");
    expect(result.perClaim[0].missingEvidence).toContain("attachmentCount>=14");
  });

  it("replacementText for text-derived stub claims is plain-language, not outbound/_unspecified jargon", () => {
    // Silent-failure path: reply text claimed completion (e.g. "已禁用" / "已触发") but
    // no tool was called, so the synthesizer emits stub outbound claims with a typed marker.
    const receipts: EffectReceipt[] = [];
    const claims: ClaimSpec[] = [
      {
        verb: "disable",
        entityType: "_unknown",
        expected: { kind: "outbound", target: { channelId: "_unspecified" } },
        note: "text-derived-stub:disable:已禁用",
        textDerivedStub: { verbFamily: "disable", evidenceSpan: "已禁用" },
      },
      {
        verb: "start",
        entityType: "_unknown",
        expected: { kind: "outbound", target: { channelId: "_unspecified" } },
        note: "text-derived-stub:start:已触发",
        textDerivedStub: { verbFamily: "start", evidenceSpan: "已触发" },
      },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
    // Per-claim missingEvidence stays technical (audit substrate); the user-facing
    // replacementText is the one that must be readable.
    expect(result.replacementText).toBeTruthy();
    expect(result.replacementText!).not.toContain("_unspecified");
    expect(result.replacementText!).not.toContain("outbound to");
    expect(result.replacementText!).toContain("没有实际调用任何工具");
    expect(result.replacementText!).toContain("已禁用");
    expect(result.replacementText!).toContain("已触发");
  });

  it("replacementText keeps technical wording when blocked claims are real (non-stub)", () => {
    const receipts: EffectReceipt[] = [];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
    expect(result.replacementText!).toContain("操作已尝试");
    expect(result.replacementText!).toContain("ch-A");
  });

  // ---- field_change kind ----

  it("passes: op=set with matching after value", () => {
    const receipts = [makeMutationReceipt({
      entityId: "t-1",
      fieldChanges: [{ path: "name", op: "set", after: "New Name" }],
    })];
    const claims: ClaimSpec[] = [
      { verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "t-1", fieldPath: "name", op: "set", after: "New Name" } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("passed");
  });

  it("blocks: op=set with after value differing", () => {
    const receipts = [makeMutationReceipt({
      entityId: "t-1",
      fieldChanges: [{ path: "name", op: "set", after: "Actual Name" }],
    })];
    const claims: ClaimSpec[] = [
      { verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "t-1", fieldPath: "name", op: "set", after: "Wrong Name" } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
  });

  it("passes: op=list_add with single element subset of receipt.added", () => {
    const receipts = [makeMutationReceipt({
      entityId: "t-1",
      fieldChanges: [{ path: "deliverTo", op: "list_add", added: ["ch-A", "ch-B"] }],
    })];
    const claims: ClaimSpec[] = [
      { verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "t-1", fieldPath: "deliverTo", op: "list_add", added: ["ch-A"] } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("passed");
  });

  it("passes: op=list_add with full equal arrays", () => {
    const receipts = [makeMutationReceipt({
      entityId: "t-1",
      fieldChanges: [{ path: "deliverTo", op: "list_add", added: ["ch-A", "ch-B"] }],
    })];
    const claims: ClaimSpec[] = [
      { verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "t-1", fieldPath: "deliverTo", op: "list_add", added: ["ch-A", "ch-B"] } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("passed");
  });

  it("blocks: op=list_add with element NOT in receipt.added", () => {
    const receipts = [makeMutationReceipt({
      entityId: "t-1",
      fieldChanges: [{ path: "deliverTo", op: "list_add", added: ["ch-A"] }],
    })];
    const claims: ClaimSpec[] = [
      { verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "t-1", fieldPath: "deliverTo", op: "list_add", added: ["ch-A", "ch-B"] } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
  });

  it("passes: op=list_remove with single element subset of receipt.removed", () => {
    const receipts = [makeMutationReceipt({
      entityId: "t-1",
      fieldChanges: [{ path: "deliverTo", op: "list_remove", removed: ["ch-A", "ch-B"] }],
    })];
    const claims: ClaimSpec[] = [
      { verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "t-1", fieldPath: "deliverTo", op: "list_remove", removed: ["ch-A"] } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("passed");
  });

  it("blocks: op=list_remove with element NOT in receipt.removed", () => {
    const receipts = [makeMutationReceipt({
      entityId: "t-1",
      fieldChanges: [{ path: "deliverTo", op: "list_remove", removed: ["ch-A"] }],
    })];
    const claims: ClaimSpec[] = [
      { verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "t-1", fieldPath: "deliverTo", op: "list_remove", removed: ["ch-A", "ch-B"] } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
  });

  it("blocks: field_change op mismatch (claim says set, receipt says list_add)", () => {
    const receipts = [makeMutationReceipt({
      entityId: "t-1",
      fieldChanges: [{ path: "deliverTo", op: "list_add", added: ["ch-A"] }],
    })];
    const claims: ClaimSpec[] = [
      { verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "t-1", fieldPath: "deliverTo", op: "set", after: ["ch-A"] } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
  });

  it("blocks: field_change path mismatch", () => {
    const receipts = [makeMutationReceipt({
      entityId: "t-1",
      fieldChanges: [{ path: "name", op: "set", after: "New" }],
    })];
    const claims: ClaimSpec[] = [
      { verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "t-1", fieldPath: "deliverTo", op: "set", after: "New" } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
  });

  it("blocks: field_change entityId mismatch", () => {
    const receipts = [makeMutationReceipt({
      entityId: "t-1",
      fieldChanges: [{ path: "name", op: "set", after: "New" }],
    })];
    const claims: ClaimSpec[] = [
      { verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "t-99", fieldPath: "name", op: "set", after: "New" } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
  });

  it("blocks: field_change entityType mismatch", () => {
    const receipts = [makeMutationReceipt({
      entityId: "t-1",
      entityType: "task_template",
      fieldChanges: [{ path: "name", op: "set", after: "New" }],
    })];
    const claims: ClaimSpec[] = [
      { verb: "update", entityType: "role", expected: { kind: "field_change", entityId: "t-1", fieldPath: "name", op: "set", after: "New" } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
  });

  it("handles list_add superset deep-equal (object items)", () => {
    const receipts = [makeMutationReceipt({
      entityId: "t-1",
      fieldChanges: [{
        path: "config",
        op: "list_add",
        added: [{ key: "timeout", value: 30 }, { key: "retries", value: 3 }],
      }],
    })];
    const claims: ClaimSpec[] = [
      { verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "t-1", fieldPath: "config", op: "list_add", added: [{ key: "timeout", value: 30 }] } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("passed");
  });

  // ---- batch kind ----

  it("passes: batch entityIds subset of receipt.entityIds", () => {
    const receipts = [makeBatchReceipt({ entityType: "task", entityIds: ["t-1", "t-2", "t-3"] })];
    const claims: ClaimSpec[] = [
      { verb: "cancel", entityType: "task", expected: { kind: "batch", entityType: "task", entityIds: ["t-1", "t-2"] } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("passed");
  });

  it("passes: batch with single-entity receipt that has entityId (one-element haystack)", () => {
    const receipts = [makeBatchReceipt({ entityType: "task", entityIds: ["t-1"] })];
    const claims: ClaimSpec[] = [
      { verb: "cancel", entityType: "task", expected: { kind: "batch", entityType: "task", entityIds: ["t-1"] } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("passed");
  });

  it("blocks: batch entityIds NOT subset", () => {
    const receipts = [makeBatchReceipt({ entityType: "task", entityIds: ["t-1"] })];
    const claims: ClaimSpec[] = [
      { verb: "cancel", entityType: "task", expected: { kind: "batch", entityType: "task", entityIds: ["t-1", "t-99"] } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
  });

  it("passes: batch scope.expectedCount <= receipt.scope.matchedCount", () => {
    const receipts = [makeBatchReceipt({
      entityType: "task",
      scope: { matchedCount: 10, filter: "completed" },
    })];
    const claims: ClaimSpec[] = [
      { verb: "cancel", entityType: "task", expected: { kind: "batch", entityType: "task", scope: { filter: "completed", expectedCount: 5 } } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("passed");
  });

  it("blocks: batch scope.expectedCount > receipt.scope.matchedCount", () => {
    const receipts = [makeBatchReceipt({
      entityType: "task",
      scope: { matchedCount: 3, filter: "completed" },
    })];
    const claims: ClaimSpec[] = [
      { verb: "cancel", entityType: "task", expected: { kind: "batch", entityType: "task", scope: { filter: "completed", expectedCount: 10 } } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
  });

  it("blocks: batch with scope but receipt has no scope", () => {
    const receipts = [makeBatchReceipt({ entityType: "task", entityIds: ["t-1"] })];
    const claims: ClaimSpec[] = [
      { verb: "cancel", entityType: "task", expected: { kind: "batch", entityType: "task", scope: { filter: "completed", expectedCount: 5 } } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
  });

  it("blocks: batch entityType mismatch", () => {
    const receipts = [makeBatchReceipt({ entityType: "task", entityIds: ["t-1"] })];
    const claims: ClaimSpec[] = [
      { verb: "cancel", entityType: "role", expected: { kind: "batch", entityType: "role", entityIds: ["t-1"] } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
  });

  // ---- multi-claim & overall status ----

  it("overall passed when all claims pass", () => {
    const receipts = [
      makeOutboundReceipt({ channelId: "ch-A", attachmentCount: 5 }),
      makeMutationReceipt({ entityId: "t-1", fieldChanges: [{ path: "name", op: "set", after: "New" }] }),
    ];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" }, attachmentCount: 5 } },
      { verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "t-1", fieldPath: "name", op: "set", after: "New" } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("passed");
    expect(result.perClaim).toHaveLength(2);
    expect(result.perClaim.every((p) => p.verdict === "passed")).toBe(true);
    expect(result.replacementText).toBeUndefined();
  });

  it("overall blocked when one of three claims fails (other two pass)", () => {
    const receipts = [
      makeOutboundReceipt({ channelId: "ch-A", attachmentCount: 5 }),
      makeMutationReceipt({ entityId: "t-1", fieldChanges: [{ path: "name", op: "set", after: "New" }] }),
    ];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" }, attachmentCount: 5 } },
      { verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "t-1", fieldPath: "name", op: "set", after: "New" } },
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-B" } } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
    expect(result.perClaim.filter((p) => p.verdict === "passed")).toHaveLength(2);
    expect(result.perClaim.filter((p) => p.verdict === "blocked")).toHaveLength(1);
  });

  it("perClaim verdicts are per-claim granular (DP-002)", () => {
    const receipts: EffectReceipt[] = [];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } },
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-B" } } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.perClaim[0].verdict).toBe("blocked");
    expect(result.perClaim[1].verdict).toBe("blocked");
  });

  it("replacementText present and lists only the blocked claim's missingEvidence", () => {
    const receipts = [makeOutboundReceipt({ channelId: "ch-A" })];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" }, attachmentCount: 5 } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.replacementText).toBeTruthy();
    expect(result.replacementText).toContain("ch-A");
    expect(result.replacementText).toContain("attachmentCount");
  });

  it("replacementText absent when overall status = passed", () => {
    const receipts = [makeOutboundReceipt({ channelId: "ch-A" })];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.replacementText).toBeUndefined();
  });

  // ---- failure receipts filter (DP-002 from Phase 2) ----

  it("ignores receipts with outcome=failure even when otherwise matching", () => {
    const receipts = [
      makeOutboundReceipt({ channelId: "ch-A", outcome: "failure" }),
      makeMutationReceipt({ entityId: "t-1", outcome: "failure", fieldChanges: [{ path: "name", op: "set", after: "New" }] }),
    ];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } },
      { verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "t-1", fieldPath: "name", op: "set", after: "New" } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
    expect(result.perClaim.every((p) => p.verdict === "blocked")).toBe(true);
  });

  // ---- defensive ----

  it("empty claims array returns passed with empty perClaim", () => {
    const receipts = [makeOutboundReceipt({ channelId: "ch-A" })];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims: [], receipts });
    expect(result.status).toBe("passed");
    expect(result.perClaim).toHaveLength(0);
  });

  it("empty receipts array blocks any claim that requires evidence", () => {
    const receipts: EffectReceipt[] = [];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } },
    ];
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims, receipts });
    expect(result.status).toBe("blocked");
  });

  it("unknown expected.kind returns blocked with structured reason", () => {
    const receipts = [makeOutboundReceipt({ channelId: "ch-A" })];
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } as never },
    ];
    // Force the unknown kind by passing a mismatched claim
    const claimsWithUnknownKind = claims as unknown as ClaimSpec[];
    // Replace with a claim that has an unrecognized kind by mutating the object
    const unknownClaim: ClaimSpec = {
      verb: "send",
      entityType: "channel_message",
      expected: { kind: "unknown_kind" } as never,
    };
    const result = verifyClaimsAgainstReceipts({ traceId: "trace-x", claims: [unknownClaim], receipts });
    expect(result.status).toBe("blocked");
    expect(result.perClaim[0].missingEvidence).toContain("unknown claim kind");
  });
});
