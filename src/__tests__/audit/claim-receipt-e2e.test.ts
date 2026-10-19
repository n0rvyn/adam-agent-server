/**
 * Phase 3 claim-receipt engine — E2E smoke test.
 *
 * Proves the whole Phase 3 engine works together via the public API only
 * (no internal-module imports beyond the public store/audit modules).
 * Reproduces the canonical podcast-redelivery scenario from the dev-guide context.
 *
 * This is the "Phase 3 acceptance criterion #4" integration test mentioned
 * in dev-guide line 256.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { writeEffectReceipt } from "../../store/effect-receipts.js";
import { writeClaims } from "../../store/assistant-claims.js";
import { auditClaimsForTurn, listClaimAudits } from "../../audit/claim-receipt-auditor.js";

const { cleanup } = setupTestDb();

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
});

describe("Phase 3 claim-receipt engine — E2E smoke", () => {
  it("podcast redelivery scenario passes: 2 outbound receipts × 14 attachments + 2 matching claims", () => {
    const traceId = "e2e-redelivery-ok";
    // Simulate Phase 2's dispatch_outbound_batch writing two outbound_message receipts
    // Use distinct channel IDs so each claim matches exactly one receipt
    writeEffectReceipt({
      traceId,
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      target: { channelId: "ch-redel-a", chatId: "chat-A", platform: "email" },
      payload: { textChars: 1234, attachmentCount: 14, attachmentRefs: ["a1", "a2", "...14"] },
      actor: { traceId, toolName: "dispatch_outbound_batch" },
    });
    writeEffectReceipt({
      traceId,
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      target: { channelId: "ch-redel-b", chatId: "chat-B", platform: "email" },
      payload: { textChars: 1234, attachmentCount: 14, attachmentRefs: ["b1", "b2", "...14"] },
      actor: { traceId, toolName: "dispatch_outbound_batch" },
    });
    // Simulate ChatManager declaring claims via commit_claim
    // Each claim targets a specific channelId so cross-matching is avoided
    writeClaims({
      traceId,
      sessionId: "s-1",
      claims: [
        { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-redel-a" }, attachmentCount: 14 } },
        { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-redel-b" }, attachmentCount: 14 } },
      ],
    });

    const result = auditClaimsForTurn({ traceId, sessionId: "s-1", messageId: "m-final" });
    expect(result.status).toBe("passed");
    expect(result.replacementText).toBeUndefined();
    // Multiple perClaim entries possible (verifier deduplicates receipt matches per claim)
    expect(result.perClaim.length).toBeGreaterThanOrEqual(2);
    expect(result.perClaim.every((p) => p.verdict === "passed")).toBe(true);
    expect(result.perClaim.every((p) => p.matchedReceiptIds.length > 0)).toBe(true);

    // Audit row recorded
    const audits = listClaimAudits(traceId);
    expect(audits).toHaveLength(1);
    expect(audits[0].status).toBe("passed");
  });

  it("podcast redelivery scenario BLOCKS when attachments=0 but claim says 14 (the 2026-05-13 actual failure)", () => {
    const traceId = "e2e-redelivery-fail";
    writeEffectReceipt({
      traceId,
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      target: { channelId: "ch-fail-1", chatId: "chat-A", platform: "email" },
      payload: { textChars: 1234, attachmentCount: 0 },
      actor: { traceId, toolName: "send_to_channel" },
    });
    writeClaims({
      traceId,
      claims: [
        { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-fail-1" }, attachmentCount: 14 } },
      ],
    });

    const result = auditClaimsForTurn({ traceId });
    expect(result.status).toBe("blocked");
    expect(result.replacementText).toBeTruthy();
    expect(result.replacementText).toContain("ch-fail-1");
    expect(result.replacementText).toContain("14");

    // Audit row recorded with blocked status
    const audits = listClaimAudits(traceId);
    expect(audits[0].status).toBe("blocked");
    expect(audits[0].replacementText).toContain("ch-fail-1");
  });

  it("mixed mutation + outbound trace: passes when both supported, blocks when one is not", () => {
    const traceId = "e2e-mixed";
    // Receipt: template t-1 list_add deliverTo += [ch-X]
    writeEffectReceipt({
      traceId,
      effectCategory: "entity_mutation",
      verb: "update",
      entityType: "task_template",
      entityId: "tpl-1",
      fieldChanges: [{ path: "deliverTo", op: "list_add", added: ["ch-X"], beforeCount: 1, afterCount: 2 }],
      actor: { traceId, toolName: "update_template" },
    });
    // Claim: tpl-1 list_add deliverTo includes ch-X — supported
    // Claim: outbound ch-Y attachmentCount=2 — NOT supported (no receipt)
    writeClaims({
      traceId,
      claims: [
        { verb: "update", entityType: "task_template", expected: { kind: "field_change", entityId: "tpl-1", fieldPath: "deliverTo", op: "list_add", added: ["ch-X"] } },
        { verb: "send", entityType: "channel_message", expected: { kind: "outbound", target: { channelId: "ch-Y" }, attachmentCount: 2 } },
      ],
    });

    const result = auditClaimsForTurn({ traceId });
    expect(result.status).toBe("blocked");
    // Two claims: first passes, second blocks
    expect(result.perClaim.some((p) => p.verdict === "passed")).toBe(true);
    expect(result.perClaim.some((p) => p.verdict === "blocked")).toBe(true);
  });
});
