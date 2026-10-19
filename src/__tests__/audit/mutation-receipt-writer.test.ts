import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { writeMutationReceipt } from "../../audit/mutation-receipt-writer.js";
import { listReceiptsByTrace } from "../../store/effect-receipts.js";
import { withTrace } from "../../lib/trace-context.js";
import { getLogger } from "../../lib/logger.js";

const { cleanup } = setupTestDb();

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

describe("writeMutationReceipt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a receipt when trace context is active", () => {
    withTrace("trace-T", "manual", () => {
      writeMutationReceipt({
        toolName: "create_role",
        entityType: "role",
        verb: "create",
        entityId: "role-1",
        fieldChanges: [
          { path: "_entity", op: "set", before: null, after: { id: "role-1", name: "TestRole" } },
        ],
      });

      const receipts = listReceiptsByTrace("trace-T");
      expect(receipts).toHaveLength(1);
      expect(receipts[0].verb).toBe("create");
      expect(receipts[0].entityType).toBe("role");
      expect(receipts[0].entityId).toBe("role-1");
      expect(receipts[0].actor.toolName).toBe("create_role");
      expect(receipts[0].outcome).toBe("success");
    });
  });

  it("skips writing when no trace context is active", () => {
    writeMutationReceipt({
      toolName: "create_role",
      entityType: "role",
      verb: "create",
      entityId: "role-1",
      fieldChanges: [
        { path: "_entity", op: "set", before: null, after: { id: "role-1" } },
      ],
    });

    // No receipts under any trace
    const receipts = listReceiptsByTrace("trace-T");
    expect(receipts).toHaveLength(0);
  });

  it("does not throw when fieldChanges and scope are both missing (InvalidReceiptError caught)", () => {
    const warnSpy = vi.spyOn(getLogger("adam"), "warn");
    withTrace("trace-Warn", "manual", () => {
      // entity_mutation requires at least fieldChanges OR scope; this should not throw
      expect(() =>
        writeMutationReceipt({
          toolName: "update_config",
          entityType: "config_field",
          verb: "update",
          entityId: "defaults.timeout",
          // no fieldChanges, no scope
        }),
      ).not.toThrow();

      // No row written (invalid receipt caught and swallowed)
      const receipts = listReceiptsByTrace("trace-Warn");
      expect(receipts).toHaveLength(0);

      // log.warn called with validation error
      expect(warnSpy).toHaveBeenCalled();
      const warnCall = warnSpy.mock.calls.find(
        (call) => typeof call[0] === "object" && call[0] !== null && "errors" in call[0],
      );
      expect(warnCall).toBeDefined();
    });
  });

  it("traceIdOverride takes precedence over ambient trace context", () => {
    withTrace("trace-ambient", "manual", () => {
      writeMutationReceipt({
        toolName: "update_role",
        entityType: "role",
        verb: "update",
        entityId: "role-explicit",
        traceIdOverride: "trace-explicit",
        fieldChanges: [{ path: "name", op: "set", before: "Old", after: "New" }],
      });

      const ambientReceipts = listReceiptsByTrace("trace-ambient");
      expect(ambientReceipts).toHaveLength(0); // not written under ambient trace

      const explicitReceipts = listReceiptsByTrace("trace-explicit");
      expect(explicitReceipts).toHaveLength(1);
      expect(explicitReceipts[0].actor.traceId).toBe("trace-explicit");
    });
  });

  it("logs without throwing when writeEffectReceipt throws a non-validation error", async () => {
    const effectReceipts = await import("../../store/effect-receipts.js");
    const warnSpy = vi.spyOn(getLogger("adam"), "warn");
    vi.spyOn(effectReceipts, "writeEffectReceipt").mockImplementationOnce(() => {
      throw new Error("synthetic db failure");
    });
    withTrace("trace-fail", "manual", () => {
      expect(() =>
        writeMutationReceipt({
          toolName: "test_tool",
          entityType: "task",
          verb: "update",
          entityId: "task-1",
          fieldChanges: [{ path: "status", op: "set", before: "running", after: "completed" }],
        }),
      ).not.toThrow();
    });
    const failureWarn = warnSpy.mock.calls.find(
      (call) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        "error" in (call[0] as Record<string, unknown>) &&
        (call[0] as { error: unknown }).error === "synthetic db failure",
    );
    expect(failureWarn).toBeDefined();
  });
});
