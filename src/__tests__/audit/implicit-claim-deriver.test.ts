import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { deriveClaimsFromReceipts } from "../../audit/implicit-claim-deriver.js";
import { writeEffectReceipt } from "../../store/effect-receipts.js";

// Replace the production getDb singleton with the test in-memory DB
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
}));

const ACTOR = (traceId: string) => ({ traceId, toolName: "test-tool" });

describe("deriveClaimsFromReceipts", () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    clearTestDb();
  });

  it("empty trace → empty array", () => {
    const result = deriveClaimsFromReceipts("00000000-0000-0000-0000-000000000099");
    expect(result).toEqual([]);
  });

  it("invalid traceId → empty array, no throw", () => {
    expect(() => deriveClaimsFromReceipts("not-a-uuid")).not.toThrow();
    expect(deriveClaimsFromReceipts("not-a-uuid")).toEqual([]);
    expect(deriveClaimsFromReceipts("")).toEqual([]);
    expect(deriveClaimsFromReceipts("0000000")).toEqual([]);
    expect(deriveClaimsFromReceipts(null as unknown as string)).toEqual([]);
  });

  it("1 outbound_message receipt → 1 ClaimSpec with kind=outbound", () => {
    const traceId = "00000000-0000-0000-0000-000000000002";
    writeEffectReceipt({
      traceId,
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel",
      target: { channelId: "ch-1", chatId: "session-1" },
      payload: { textChars: 50, attachmentCount: 3 },
      actor: ACTOR(traceId),
      outcome: "success",
    });
    const claims = deriveClaimsFromReceipts(traceId);
    expect(claims).toHaveLength(1);
    expect(claims[0].expected).toMatchObject({
      kind: "outbound",
      target: { channelId: "ch-1", chatId: "session-1" },
      attachmentCount: 3,
      textPresent: true,
    });
    expect(claims[0].note).toMatch(/implicit:from-receipt:/);
  });

  it("entity_mutation with entityId + fieldChanges[0] → kind=field_change", () => {
    const traceId = "00000000-0000-0000-0000-000000000004";
    writeEffectReceipt({
      traceId,
      effectCategory: "entity_mutation",
      verb: "update",
      entityType: "role",
      entityId: "role-abc",
      fieldChanges: [{ path: "name", op: "set", after: "New Name" }],
      actor: ACTOR(traceId),
      outcome: "success",
    });
    const claims = deriveClaimsFromReceipts(traceId);
    expect(claims).toHaveLength(1);
    expect(claims[0].expected).toMatchObject({
      kind: "field_change",
      entityId: "role-abc",
      fieldPath: "name",
      op: "set",
      after: "New Name",
    });
  });

  it("entity_mutation with entityIds[] + scope → kind=batch with entityIds", () => {
    const traceId = "00000000-0000-0000-0000-000000000005";
    writeEffectReceipt({
      traceId,
      effectCategory: "entity_mutation",
      verb: "delete",
      entityType: "role",
      entityIds: ["role-x", "role-y"],
      scope: { filter: "Name LIKE 'role-%'", matchedCount: 2 },
      actor: ACTOR(traceId),
      outcome: "success",
    });
    const claims = deriveClaimsFromReceipts(traceId);
    expect(claims).toHaveLength(1);
    expect(claims[0].expected).toMatchObject({
      kind: "batch",
      entityType: "role",
      entityIds: ["role-x", "role-y"],
    });
  });

  it("entity_mutation with entityId + scope → kind=batch with scope", () => {
    const traceId = "00000000-0000-0000-0000-000000000006";
    writeEffectReceipt({
      traceId,
      effectCategory: "entity_mutation",
      verb: "cancel",
      entityType: "task",
      entityId: "task-scope-cancel",
      scope: { filter: "status=running", matchedCount: 7 },
      actor: ACTOR(traceId),
      outcome: "success",
    });
    const claims = deriveClaimsFromReceipts(traceId);
    expect(claims).toHaveLength(1);
    expect(claims[0].expected).toMatchObject({
      kind: "batch",
      entityType: "task",
      scope: { filter: "status=running", expectedCount: 7 },
    });
  });

  it("failure receipt → not included", () => {
    const traceId = "00000000-0000-0000-0000-000000000007";
    writeEffectReceipt({
      traceId,
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel",
      target: { channelId: "ch-fail" },
      payload: { textChars: 10, attachmentCount: 0 },
      actor: ACTOR(traceId),
      outcome: "failure",
    });
    expect(deriveClaimsFromReceipts(traceId)).toHaveLength(0);
  });

  it("mixed trace (1 outbound + 1 mutation success + 1 failure) → 2 ClaimSpecs", () => {
    const traceId = "00000000-0000-0000-0000-000000000008";
    writeEffectReceipt({
      traceId,
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel",
      target: { channelId: "ch-mixed" },
      payload: { textChars: 20, attachmentCount: 1 },
      actor: ACTOR(traceId),
      outcome: "success",
    });
    writeEffectReceipt({
      traceId,
      effectCategory: "entity_mutation",
      verb: "update",
      entityType: "role",
      entityId: "role-mixed",
      fieldChanges: [{ path: "status", op: "set", after: "active" }],
      actor: ACTOR(traceId),
      outcome: "success",
    });
    writeEffectReceipt({
      traceId,
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel",
      target: { channelId: "ch-fail2" },
      payload: { textChars: 5, attachmentCount: 0 },
      actor: ACTOR(traceId),
      outcome: "failure",
    });
    const claims = deriveClaimsFromReceipts(traceId);
    expect(claims).toHaveLength(2);
    const kinds = claims.map(c => c.expected.kind);
    expect(kinds).toContain("outbound");
    expect(kinds).toContain("field_change");
  });
});
