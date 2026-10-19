import { describe, it, expect } from "vitest";
import { validateReceipt } from "../../store/effect-receipt-validators.js";
import type { EffectReceiptInput } from "../../shared/types.js";

const baseActor = { traceId: "trace-1", toolName: "test-tool" };

describe("validateReceipt — outbound_message", () => {
  it("accepts a complete outbound_message receipt", () => {
    const r: EffectReceiptInput = {
      traceId: "trace-1",
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      entityId: "delivery_log:abc",
      target: { channelId: "ch-1", chatId: "user@x.com", platform: "email" },
      payload: { textChars: 100, attachmentCount: 3, attachmentRefs: ["a", "b", "c"] },
      actor: baseActor,
    };
    expect(validateReceipt(r)).toEqual({ valid: true, errors: [] });
  });

  it("rejects outbound_message missing target.channelId", () => {
    const r: EffectReceiptInput = {
      traceId: "trace-1",
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      payload: { textChars: 100, attachmentCount: 0 },
      actor: baseActor,
    } as EffectReceiptInput;
    const result = validateReceipt(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("target.channelId"))).toBe(true);
  });

  it("rejects outbound_message missing payload counts", () => {
    const r: EffectReceiptInput = {
      traceId: "trace-1",
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      target: { channelId: "ch-1" },
      actor: baseActor,
    } as EffectReceiptInput;
    const result = validateReceipt(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("payload"))).toBe(true);
  });
});

describe("validateReceipt — entity_mutation", () => {
  it("accepts single-entity update with fieldChanges", () => {
    const r: EffectReceiptInput = {
      traceId: "trace-1",
      effectCategory: "entity_mutation",
      verb: "update",
      entityType: "task_template",
      entityId: "tpl-1",
      fieldChanges: [
        { path: "name", op: "set", before: "old", after: "new" },
      ],
      actor: baseActor,
    };
    expect(validateReceipt(r)).toEqual({ valid: true, errors: [] });
  });

  it("accepts batch with entityIds + scope", () => {
    const r: EffectReceiptInput = {
      traceId: "trace-1",
      effectCategory: "entity_mutation",
      verb: "cancel",
      entityType: "task",
      entityIds: ["t-A", "t-B", "t-C"],
      scope: { filter: "status=running AND role_id=role-x", matchedCount: 3 },
      actor: baseActor,
    };
    expect(validateReceipt(r)).toEqual({ valid: true, errors: [] });
  });

  it("rejects entity_mutation with neither fieldChanges nor scope", () => {
    const r: EffectReceiptInput = {
      traceId: "trace-1",
      effectCategory: "entity_mutation",
      verb: "update",
      entityType: "task_template",
      entityId: "tpl-1",
      actor: baseActor,
    };
    const result = validateReceipt(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("fieldChanges") && e.includes("scope"))).toBe(true);
  });

  it("rejects batch entityIds without scope", () => {
    const r: EffectReceiptInput = {
      traceId: "trace-1",
      effectCategory: "entity_mutation",
      verb: "cancel",
      entityType: "task",
      entityIds: ["t-A", "t-B"],
      fieldChanges: [{ path: "status", op: "set", after: "cancelled" }],
      actor: baseActor,
    };
    const result = validateReceipt(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("batch") && e.includes("scope"))).toBe(true);
  });

  it("rejects entity_mutation with both entityId and entityIds", () => {
    const r: EffectReceiptInput = {
      traceId: "trace-1",
      effectCategory: "entity_mutation",
      verb: "delete",
      entityType: "goal",
      entityId: "g-1",
      entityIds: ["g-2", "g-3"],
      scope: { filter: "name LIKE x%", matchedCount: 2 },
      actor: baseActor,
    };
    const result = validateReceipt(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("mutually exclusive"))).toBe(true);
  });
});

describe("validateReceipt — actor + common fields", () => {
  it("rejects missing actor.traceId", () => {
    const r: EffectReceiptInput = {
      traceId: "trace-1",
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      target: { channelId: "ch-1" },
      payload: { textChars: 1, attachmentCount: 0 },
      actor: { traceId: "", toolName: "test-tool" },
    };
    const result = validateReceipt(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("traceId"))).toBe(true);
  });

  it("rejects missing top-level traceId", () => {
    const r = {
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      target: { channelId: "ch-1" },
      payload: { textChars: 1, attachmentCount: 0 },
      actor: baseActor,
    } as unknown as EffectReceiptInput;
    const result = validateReceipt(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e === "traceId is required")).toBe(true);
  });

  it("rejects mismatched traceId vs actor.traceId", () => {
    const r: EffectReceiptInput = {
      traceId: "trace-A",
      effectCategory: "outbound_message",
      verb: "send",
      entityType: "channel_message",
      target: { channelId: "ch-1" },
      payload: { textChars: 1, attachmentCount: 0 },
      actor: { traceId: "trace-B", toolName: "test-tool" },
    };
    const result = validateReceipt(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("must equal top-level traceId"))).toBe(true);
  });

  it("rejects entity_mutation without entityId or entityIds", () => {
    const r: EffectReceiptInput = {
      traceId: "trace-1",
      effectCategory: "entity_mutation",
      verb: "update",
      entityType: "task_template",
      // No entityId, no entityIds
      fieldChanges: [{ path: "name", op: "set", after: "x" }],
      actor: baseActor,
    };
    const result = validateReceipt(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("entity_mutation") && e.includes("entityId"))).toBe(true);
  });

  it("rejects unknown effectCategory", () => {
    const r = {
      traceId: "trace-1",
      effectCategory: "weird_category",
      verb: "send",
      entityType: "x",
      actor: baseActor,
    } as unknown as EffectReceiptInput;
    const result = validateReceipt(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("effectCategory"))).toBe(true);
  });
});
