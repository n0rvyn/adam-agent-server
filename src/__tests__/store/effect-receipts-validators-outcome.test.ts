import { describe, it, expect } from "vitest";
import { validateReceipt } from "../../store/effect-receipt-validators.js";
import type { EffectReceiptInput } from "../../shared/types.js";

// All tests use the same traceId for top-level and actor.traceId
const TRACE = "trace-outcome";
const baseActor = { traceId: TRACE, toolName: "test-tool" };

const baseOutbound = {
  traceId: TRACE,
  effectCategory: "outbound_message" as const,
  verb: "send" as const,
  entityType: "channel_message" as const,
  target: { channelId: "ch-1" as const },
  payload: { textChars: 100, attachmentCount: 0 } as const,
  actor: baseActor,
};

describe("validateReceipt — outcome field (DP-002)", () => {

  it("accepts outcome undefined", () => {
    const r: EffectReceiptInput = { ...baseOutbound, outcome: undefined };
    const result = validateReceipt(r);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts outcome: 'success'", () => {
    const r: EffectReceiptInput = { ...baseOutbound, outcome: "success" };
    const result = validateReceipt(r);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts outcome: 'failure'", () => {
    const r: EffectReceiptInput = { ...baseOutbound, outcome: "failure" };
    const result = validateReceipt(r);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects outcome: 'unknown'", () => {
    const r = { ...baseOutbound, outcome: "unknown" } as unknown as EffectReceiptInput;
    const result = validateReceipt(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("outcome"))).toBe(true);
  });

  it("rejects outcome: 123 (wrong type)", () => {
    const r = { ...baseOutbound, outcome: 123 } as unknown as EffectReceiptInput;
    const result = validateReceipt(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("outcome"))).toBe(true);
  });

  it("failed outbound_message still requires target.channelId", () => {
    // DP-002 rationale: failure does not relax other validation constraints
    const r = {
      ...baseOutbound,
      outcome: "failure" as const,
      target: { channelId: "" },
    } as unknown as EffectReceiptInput;
    const result = validateReceipt(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("channelId"))).toBe(true);
  });

  it("failed entity_mutation with outcome='failure' still requires entityId or fieldChanges", () => {
    const r: EffectReceiptInput = {
      traceId: TRACE,
      effectCategory: "entity_mutation",
      verb: "delete",
      entityType: "role",
      actor: baseActor,
      outcome: "failure",
      // intentionally missing entityId + fieldChanges
    };
    const result = validateReceipt(r);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("entity_mutation") && e.includes("entityId"))).toBe(true);
  });
});
