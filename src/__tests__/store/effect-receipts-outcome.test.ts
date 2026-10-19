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
} from "../../store/effect-receipts.js";
import type { EffectReceiptInput } from "../../shared/types.js";

const makeActor = (traceId: string) => ({ traceId, toolName: "test-tool" });

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

describe("effect_receipts.outcome — Phase 2 DP-002", () => {

  it("defaults outcome to 'success' when not provided", () => {
    const traceId = "trace-outcome-default";
    const actor = makeActor(traceId);
    const input: EffectReceiptInput = {
      traceId,
      taskId: "task-default",
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      target: { channelId: "ch-1" },
      payload: { textChars: 100, attachmentCount: 0 },
      actor,
    };
    // No outcome field — validator should accept it, DB should default to 'success'
    const written = writeEffectReceipt(input);
    expect(written.outcome).toBe("success");

    const list = listReceiptsByTrace(traceId);
    expect(list[0].outcome).toBe("success");
  });

  it("writes outcome='failure' and reads it back", () => {
    const traceId = "trace-failure";
    const actor = makeActor(traceId);
    const input: EffectReceiptInput = {
      traceId,
      taskId: "task-failure",
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      target: { channelId: "ch-1" },
      payload: { textChars: 50, attachmentCount: 0 },
      actor,
      outcome: "failure",
    };
    const written = writeEffectReceipt(input);
    expect(written.outcome).toBe("failure");

    const list = listReceiptsByTrace(traceId);
    expect(list[0].outcome).toBe("failure");
  });

  it("writes outcome='success' explicitly and reads it back", () => {
    const traceId = "trace-explicit-success";
    const actor = makeActor(traceId);
    const input: EffectReceiptInput = {
      traceId,
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      target: { channelId: "ch-1" },
      payload: { textChars: 10, attachmentCount: 0 },
      actor,
      outcome: "success",
    };
    const written = writeEffectReceipt(input);
    expect(written.outcome).toBe("success");
    expect(listReceiptsByTrace(traceId)[0].outcome).toBe("success");
  });

  it("listReceiptsByTrace returns rows with the correct outcome per receipt", () => {
    const traceId = "trace-multi";
    const base: Omit<EffectReceiptInput, "traceId" | "actor"> = {
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      target: { channelId: "ch-1" },
      payload: { textChars: 1, attachmentCount: 0 },
    };
    writeEffectReceipt({ ...base, traceId, actor: makeActor(traceId), outcome: "success" });
    writeEffectReceipt({ ...base, traceId, actor: makeActor(traceId), outcome: "failure" });
    writeEffectReceipt({ ...base, traceId, actor: makeActor(traceId), outcome: "success" });

    const list = listReceiptsByTrace(traceId);
    expect(list).toHaveLength(3);
    expect(list[0].outcome).toBe("success");
    expect(list[1].outcome).toBe("failure");
    expect(list[2].outcome).toBe("success");
  });

  it("listReceiptsByTask returns rows with the right outcome", () => {
    const traceId = "trace-task";
    const taskId = "task-task-outcome";
    const input: EffectReceiptInput = {
      traceId,
      taskId,
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      target: { channelId: "ch-task" },
      payload: { textChars: 1, attachmentCount: 0 },
      actor: makeActor(traceId),
      outcome: "failure",
    };
    writeEffectReceipt(input);
    const list = listReceiptsByTask(taskId);
    expect(list).toHaveLength(1);
    expect(list[0].outcome).toBe("failure");
  });

  it("entity_mutation receipt with outcome='success' works", () => {
    const traceId = "trace-entity";
    const input: EffectReceiptInput = {
      traceId,
      effectCategory: "entity_mutation",
      verb: "update",
      entityType: "task_template",
      entityId: "tpl-outcome",
      fieldChanges: [{ path: "name", op: "set", before: "x", after: "y" }],
      actor: makeActor(traceId),
      outcome: "success",
    };
    const written = writeEffectReceipt(input);
    expect(written.outcome).toBe("success");
    expect(listReceiptsByTrace(traceId)[0].outcome).toBe("success");
  });
});
