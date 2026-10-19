import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  writeEffectReceipt,
  listReceiptsByTrace,
  listReceiptsByTask,
  listReceiptsByEntity,
  InvalidReceiptError,
} from "../../store/effect-receipts.js";
import type { EffectReceiptInput } from "../../shared/types.js";

const actor = { traceId: "trace-x", toolName: "test-tool" };

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

describe("effect-receipts store", () => {

  it("writes and reads back an outbound_message receipt", () => {
    const input: EffectReceiptInput = {
      traceId: "trace-x",
      taskId: "task-1",
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      entityId: "delivery_log:abc",
      target: { channelId: "ch-1", chatId: "user@x.com", platform: "email" },
      payload: { textChars: 4882, attachmentCount: 14, attachmentRefs: ["a-1", "a-2"] },
      actor,
    };
    const written = writeEffectReceipt(input);
    expect(written.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(written.createdAt).toBeGreaterThan(0);

    const list = listReceiptsByTrace("trace-x");
    expect(list).toHaveLength(1);
    expect(list[0].effectCategory).toBe("outbound_message");
    expect(list[0].target).toEqual({ channelId: "ch-1", chatId: "user@x.com", platform: "email" });
    expect(list[0].payload).toEqual({ textChars: 4882, attachmentCount: 14, attachmentRefs: ["a-1", "a-2"] });
  });

  it("writes and reads back a single-entity entity_mutation receipt", () => {
    const input: EffectReceiptInput = {
      traceId: "trace-x",
      effectCategory: "entity_mutation",
      verb: "update",
      entityType: "task_template",
      entityId: "tpl-95a97f8c",
      fieldChanges: [
        { path: "deliverTo", op: "list_add", added: [{ channelId: "22af8702" }, { channelId: "c38f0b17" }], removed: [], beforeCount: 4, afterCount: 6 },
      ],
      actor,
    };
    writeEffectReceipt(input);
    const list = listReceiptsByEntity({ entityType: "task_template", entityId: "tpl-95a97f8c" });
    expect(list).toHaveLength(1);
    expect(list[0].fieldChanges).toBeDefined();
    expect(list[0].fieldChanges![0].op).toBe("list_add");
    expect(list[0].fieldChanges![0].added).toHaveLength(2);
  });

  it("writes and reads back a batch entity_mutation receipt", () => {
    const input: EffectReceiptInput = {
      traceId: "trace-x",
      effectCategory: "entity_mutation",
      verb: "cancel",
      entityType: "task",
      entityIds: ["t-A", "t-B", "t-C"],
      scope: { filter: "status=running", matchedCount: 3 },
      actor,
    };
    writeEffectReceipt(input);
    const list = listReceiptsByTrace("trace-x");
    expect(list).toHaveLength(1);
    expect(list[0].entityIds).toEqual(["t-A", "t-B", "t-C"]);
    expect(list[0].entityId).toBeUndefined();
    expect(list[0].scope).toEqual({ filter: "status=running", matchedCount: 3 });
  });

  it("listReceiptsByTask returns receipts in created_at order", () => {
    const base: EffectReceiptInput = {
      traceId: "trace-x",
      taskId: "task-shared",
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      target: { channelId: "ch-1" },
      payload: { textChars: 1, attachmentCount: 0 },
      actor,
    };
    writeEffectReceipt({ ...base, createdAt: 1000 });
    writeEffectReceipt({ ...base, createdAt: 3000 });
    writeEffectReceipt({ ...base, createdAt: 2000 });
    const list = listReceiptsByTask("task-shared");
    expect(list.map((r) => r.createdAt)).toEqual([1000, 2000, 3000]);
  });

  it("throws InvalidReceiptError on malformed input (no DB write)", () => {
    const bad: EffectReceiptInput = {
      traceId: "trace-x",
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      // Missing target + payload
      actor,
    } as EffectReceiptInput;
    expect(() => writeEffectReceipt(bad)).toThrow(InvalidReceiptError);
    expect(listReceiptsByTrace("trace-x")).toHaveLength(0);
  });

  it("preserves attachmentRefs through JSON round-trip", () => {
    const input: EffectReceiptInput = {
      traceId: "trace-rt",
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      target: { channelId: "ch-1" },
      payload: { textChars: 100, attachmentCount: 14, attachmentRefs: ["artifact-1", "artifact-2", "artifact-3"] },
      actor: { traceId: "trace-rt", toolName: "test-tool" },
    };
    writeEffectReceipt(input);
    const list = listReceiptsByTrace("trace-rt");
    expect(list[0].payload?.attachmentRefs).toEqual(["artifact-1", "artifact-2", "artifact-3"]);
    expect(list[0].payload?.attachmentCount).toBe(14);
  });

  it("isolates receipts by trace_id", () => {
    writeEffectReceipt({
      traceId: "trace-A",
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      target: { channelId: "ch-1" },
      payload: { textChars: 1, attachmentCount: 0 },
      actor: { ...actor, traceId: "trace-A" },
    });
    writeEffectReceipt({
      traceId: "trace-B",
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      target: { channelId: "ch-2" },
      payload: { textChars: 1, attachmentCount: 0 },
      actor: { ...actor, traceId: "trace-B" },
    });
    expect(listReceiptsByTrace("trace-A")).toHaveLength(1);
    expect(listReceiptsByTrace("trace-B")).toHaveLength(1);
    expect(listReceiptsByTrace("trace-C")).toHaveLength(0);
  });
});
