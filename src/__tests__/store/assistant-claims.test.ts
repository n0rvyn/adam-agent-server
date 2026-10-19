import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { InvalidClaimError } from "../../audit/claim-spec.js";
import type { ClaimSpec } from "../../shared/types.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { writeClaims, listClaimsByTrace, listClaimsBySession } from "../../store/assistant-claims.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

describe("assistant_claims store", () => {
  // ---- schema check ----

  it("assistant_claims table exists after setupTestDb", () => {
    const db = getTestDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_claims'").get();
    expect(tables).toBeTruthy();
  });

  it("assistant_claim_audits table exists after setupTestDb", () => {
    const db = getTestDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_claim_audits'").get();
    expect(tables).toBeTruthy();
  });

  it("assistant_claims has expected columns", () => {
    const db = getTestDb();
    const cols = db.prepare("PRAGMA table_info(assistant_claims)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("trace_id");
    expect(colNames).toContain("session_id");
    expect(colNames).toContain("task_id");
    expect(colNames).toContain("source_message_id");
    expect(colNames).toContain("claims_json");
    expect(colNames).toContain("declared_at");
  });

  it("assistant_claims has expected indexes", () => {
    const db = getTestDb();
    const indexes = db.prepare("PRAGMA index_list('assistant_claims')").all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames.some((n) => n.includes("trace"))).toBe(true);
    expect(indexNames.some((n) => n.includes("session"))).toBe(true);
  });

  // ---- writeClaims: single claim round-trip ----

  it("writeClaims persists a single outbound claim and listClaimsByTrace returns it", () => {
    const outbound: ClaimSpec = {
      verb: "send",
      entityType: "channel_message",
      expected: { kind: "outbound", target: { channelId: "ch-A" }, attachmentCount: 5 },
    };
    const row = writeClaims({ traceId: "t-1", claims: [outbound] });
    expect(row.id).toBeTruthy();
    expect(row.traceId).toBe("t-1");
    expect(row.claims).toHaveLength(1);
    expect(row.claims[0]).toEqual(outbound);
  });

  it("writeClaims persists multi-claim batch (outbound + field_change + batch) and all three preserved", () => {
    const claims: ClaimSpec[] = [
      { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } },
      { verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "t-1", fieldPath: "name", op: "set", after: "Updated" } },
      { verb: "cancel", entityType: "task", expected: { kind: "batch", entityType: "task", entityIds: ["t-1", "t-2"] } },
    ];
    writeClaims({ traceId: "t-multi", claims });
    const found = listClaimsByTrace("t-multi");
    expect(found).toHaveLength(1);
    expect(found[0].claims).toHaveLength(3);
    expect(found[0].claims[1].expected.kind).toBe("field_change");
    expect(found[0].claims[2].expected.kind).toBe("batch");
  });

  // ---- writeClaims: validation failures ----

  it("writeClaims throws InvalidClaimError when claims[0] is invalid (missing target.channelId)", () => {
    const invalidClaim: ClaimSpec = {
      verb: "send",
      entityType: "channel_message",
      expected: { kind: "outbound", target: {} } as never,
    };
    expect(() => writeClaims({ traceId: "t-bad", claims: [invalidClaim] })).toThrow(InvalidClaimError);
  });

  it("writeClaims throws when claims array is empty", () => {
    expect(() => writeClaims({ traceId: "t-empty", claims: [] })).toThrow(InvalidClaimError);
  });

  it("writeClaims throws when traceId is empty", () => {
    const claim: ClaimSpec = {
      verb: "send",
      entityType: "channel_message",
      expected: { kind: "outbound", target: { channelId: "ch-A" } },
    };
    expect(() => writeClaims({ traceId: "", claims: [claim] })).toThrow(InvalidClaimError);
  });

  it("writeClaims throws InvalidClaimError on second invalid claim with correct index in error", () => {
    const validClaim: ClaimSpec = {
      verb: "send",
      entityType: "channel_message",
      expected: { kind: "outbound", target: { channelId: "ch-A" } },
    };
    const invalidClaim: ClaimSpec = {
      verb: "",
      entityType: "channel_message",
      expected: { kind: "outbound", target: { channelId: "ch-B" } },
    };
    try {
      writeClaims({ traceId: "t-2", claims: [validClaim, invalidClaim] });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidClaimError);
      expect((err as InvalidClaimError).errors[0]).toContain("claims[1]:");
    }
  });

  // ---- ordering ----

  it("listClaimsByTrace returns claims sorted by declaredAt ASC", () => {
    const claim1: ClaimSpec = { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } };
    const claim2: ClaimSpec = { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-B" } } };
    writeClaims({ traceId: "t-order", claims: [claim1], declaredAt: 1000 });
    writeClaims({ traceId: "t-order", claims: [claim2], declaredAt: 2000 });
    const rows = listClaimsByTrace("t-order");
    expect(rows).toHaveLength(2);
    expect(rows[0].declaredAt).toBe(1000);
    expect(rows[1].declaredAt).toBe(2000);
  });

  // ---- listClaimsBySession ----

  it("listClaimsBySession filters correctly (only matching session returned)", () => {
    const claim: ClaimSpec = { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } };
    writeClaims({ traceId: "t-s1", sessionId: "s-A", claims: [claim] });
    writeClaims({ traceId: "t-s2", sessionId: "s-B", claims: [claim] });
    const rowsA = listClaimsBySession("s-A");
    const rowsB = listClaimsBySession("s-B");
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].sessionId).toBe("s-A");
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].sessionId).toBe("s-B");
  });

  // ---- optional fields ----

  it("optional fields round-trip as undefined when omitted", () => {
    const claim: ClaimSpec = { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } };
    const row = writeClaims({ traceId: "t-opts", claims: [claim] });
    expect(row.sessionId).toBeUndefined();
    expect(row.taskId).toBeUndefined();
    expect(row.sourceMessageId).toBeUndefined();
    const found = listClaimsByTrace("t-opts");
    expect(found[0].sessionId).toBeUndefined();
    expect(found[0].taskId).toBeUndefined();
    expect(found[0].sourceMessageId).toBeUndefined();
  });

  it("optional fields round-trip with provided values", () => {
    const claim: ClaimSpec = { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } };
    const row = writeClaims({ traceId: "t-opts2", sessionId: "s-1", taskId: "task-99", sourceMessageId: "msg-x", claims: [claim] });
    expect(row.sessionId).toBe("s-1");
    expect(row.taskId).toBe("task-99");
    expect(row.sourceMessageId).toBe("msg-x");
    const found = listClaimsByTrace("t-opts2");
    expect(found[0].sessionId).toBe("s-1");
    expect(found[0].taskId).toBe("task-99");
    expect(found[0].sourceMessageId).toBe("msg-x");
  });

  // ---- id provided ----

  it("writeClaims uses provided id if given", () => {
    const claim: ClaimSpec = { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-A" } } };
    const row = writeClaims({ id: "pre-known-id", traceId: "t-id", claims: [claim] });
    expect(row.id).toBe("pre-known-id");
  });

  // ---- note field round-trips ----

  it("note field round-trips through write/read", () => {
    const claim: ClaimSpec = {
      verb: "send",
      entityType: "channel_message",
      expected: { kind: "outbound", target: { channelId: "ch-A" } },
      note: "human-readable audit note",
    };
    writeClaims({ traceId: "t-note", claims: [claim] });
    const found = listClaimsByTrace("t-note");
    expect(found[0].claims[0].note).toBe("human-readable audit note");
  });
});
