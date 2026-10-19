import { describe, it, expect } from "vitest";
import { validateClaim, InvalidClaimError } from "../../audit/claim-spec.js";
import type { ClaimSpec } from "../../shared/types.js";

describe("validateClaim", () => {
  // ---- outbound kind ----

  it("accepts a minimal valid outbound claim", () => {
    const claim: ClaimSpec = {
      verb: "send",
      entityType: "channel_message",
      expected: { kind: "outbound", target: { channelId: "ch-1" } },
    };
    expect(validateClaim(claim)).toEqual({ valid: true, errors: [] });
  });

  it("accepts outbound with attachmentCount and textPresent", () => {
    const claim: ClaimSpec = {
      verb: "send",
      entityType: "channel_message",
      expected: { kind: "outbound", target: { channelId: "ch-1" }, attachmentCount: 5, textPresent: true },
    };
    expect(validateClaim(claim)).toEqual({ valid: true, errors: [] });
  });

  it("accepts outbound with chatId in target", () => {
    const claim: ClaimSpec = {
      verb: "send",
      entityType: "channel_message",
      expected: { kind: "outbound", target: { channelId: "ch-1", chatId: "chat-abc" } },
    };
    expect(validateClaim(claim)).toEqual({ valid: true, errors: [] });
  });

  it("rejects outbound missing target.channelId", () => {
    const claim: ClaimSpec = {
      verb: "send",
      entityType: "channel_message",
      expected: { kind: "outbound", target: {} } as never,
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("expected.target.channelId is required for outbound");
  });

  it("rejects outbound with negative attachmentCount", () => {
    const claim: ClaimSpec = {
      verb: "send",
      entityType: "channel_message",
      expected: { kind: "outbound", target: { channelId: "ch-1" }, attachmentCount: -1 },
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("expected.attachmentCount must be a non-negative number");
  });

  it("rejects outbound with non-numeric attachmentCount", () => {
    const claim: ClaimSpec = {
      verb: "send",
      entityType: "channel_message",
      expected: { kind: "outbound", target: { channelId: "ch-1" }, attachmentCount: "5" as unknown as number },
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("expected.attachmentCount must be a non-negative number");
  });

  // ---- field_change kind ----

  it("accepts valid op=set with after", () => {
    const claim: ClaimSpec = {
      verb: "update",
      entityType: "task_template",
      expected: { kind: "field_change", entityId: "t-1", fieldPath: "name", op: "set", after: "New Name" },
    };
    expect(validateClaim(claim)).toEqual({ valid: true, errors: [] });
  });

  it("rejects op=set without after", () => {
    const claim: ClaimSpec = {
      verb: "update",
      entityType: "task_template",
      expected: { kind: "field_change", entityId: "t-1", fieldPath: "name", op: "set" },
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("expected.after is required when op='set'");
  });

  it("rejects op=set with added present", () => {
    const claim: ClaimSpec = {
      verb: "update",
      entityType: "task_template",
      expected: { kind: "field_change", entityId: "t-1", fieldPath: "name", op: "set", after: "New", added: ["x"] },
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("expected.added/removed must be absent when op='set'");
  });

  it("rejects op=set with removed present", () => {
    const claim: ClaimSpec = {
      verb: "update",
      entityType: "task_template",
      expected: { kind: "field_change", entityId: "t-1", fieldPath: "name", op: "set", after: "New", removed: ["x"] },
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("expected.added/removed must be absent when op='set'");
  });

  it("accepts valid op=list_add with non-empty added array", () => {
    const claim: ClaimSpec = {
      verb: "update",
      entityType: "task_template",
      expected: { kind: "field_change", entityId: "t-1", fieldPath: "deliverTo", op: "list_add", added: ["ch-A"] },
    };
    expect(validateClaim(claim)).toEqual({ valid: true, errors: [] });
  });

  it("accepts op=list_add with multiple items in added", () => {
    const claim: ClaimSpec = {
      verb: "update",
      entityType: "task_template",
      expected: { kind: "field_change", entityId: "t-1", fieldPath: "deliverTo", op: "list_add", added: ["ch-A", "ch-B"] },
    };
    expect(validateClaim(claim)).toEqual({ valid: true, errors: [] });
  });

  it("rejects op=list_add with empty added array", () => {
    const claim: ClaimSpec = {
      verb: "update",
      entityType: "task_template",
      expected: { kind: "field_change", entityId: "t-1", fieldPath: "deliverTo", op: "list_add", added: [] },
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("expected.added (non-empty array) is required when op='list_add'");
  });

  it("rejects op=list_add with removed present", () => {
    const claim: ClaimSpec = {
      verb: "update",
      entityType: "task_template",
      expected: { kind: "field_change", entityId: "t-1", fieldPath: "deliverTo", op: "list_add", added: ["ch-A"], removed: ["ch-B"] },
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("expected.after/removed must be absent when op='list_add'");
  });

  it("rejects op=list_add with after present", () => {
    const claim: ClaimSpec = {
      verb: "update",
      entityType: "task_template",
      expected: { kind: "field_change", entityId: "t-1", fieldPath: "deliverTo", op: "list_add", added: ["ch-A"], after: "something" },
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("expected.after/removed must be absent when op='list_add'");
  });

  it("accepts valid op=list_remove with non-empty removed array", () => {
    const claim: ClaimSpec = {
      verb: "update",
      entityType: "task_template",
      expected: { kind: "field_change", entityId: "t-1", fieldPath: "deliverTo", op: "list_remove", removed: ["ch-A"] },
    };
    expect(validateClaim(claim)).toEqual({ valid: true, errors: [] });
  });

  it("rejects op=list_remove with empty removed array", () => {
    const claim: ClaimSpec = {
      verb: "update",
      entityType: "task_template",
      expected: { kind: "field_change", entityId: "t-1", fieldPath: "deliverTo", op: "list_remove", removed: [] },
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("expected.removed (non-empty array) is required when op='list_remove'");
  });

  it("rejects op=list_remove with after present", () => {
    const claim: ClaimSpec = {
      verb: "update",
      entityType: "task_template",
      expected: { kind: "field_change", entityId: "t-1", fieldPath: "deliverTo", op: "list_remove", removed: ["ch-A"], after: "something" },
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("expected.after/added must be absent when op='list_remove'");
  });

  it("rejects field_change missing entityId", () => {
    const claim: ClaimSpec = {
      verb: "update",
      entityType: "task_template",
      expected: { kind: "field_change", fieldPath: "name", op: "set", after: "New" } as never,
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("expected.entityId is required for field_change");
  });

  it("rejects field_change missing fieldPath", () => {
    const claim: ClaimSpec = {
      verb: "update",
      entityType: "task_template",
      expected: { kind: "field_change", entityId: "t-1", op: "set", after: "New" } as never,
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("expected.fieldPath is required for field_change");
  });

  it("rejects invalid op for field_change", () => {
    const claim: ClaimSpec = {
      verb: "update",
      entityType: "task_template",
      expected: { kind: "field_change", entityId: "t-1", fieldPath: "name", op: "increment" } as never,
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(`expected.op must be 'set', 'list_add', or 'list_remove'`);
  });

  // ---- batch kind ----

  it("accepts batch with entityIds only", () => {
    const claim: ClaimSpec = {
      verb: "cancel",
      entityType: "task",
      expected: { kind: "batch", entityType: "task", entityIds: ["t-1", "t-2"] },
    };
    expect(validateClaim(claim)).toEqual({ valid: true, errors: [] });
  });

  it("accepts batch with scope only", () => {
    const claim: ClaimSpec = {
      verb: "cancel",
      entityType: "task",
      expected: { kind: "batch", entityType: "task", scope: { filter: "completed", expectedCount: 10 } },
    };
    expect(validateClaim(claim)).toEqual({ valid: true, errors: [] });
  });

  it("accepts batch with both entityIds and scope", () => {
    const claim: ClaimSpec = {
      verb: "cancel",
      entityType: "task",
      expected: {
        kind: "batch",
        entityType: "task",
        entityIds: ["t-1"],
        scope: { filter: "completed", expectedCount: 3 },
      },
    };
    expect(validateClaim(claim)).toEqual({ valid: true, errors: [] });
  });

  it("rejects batch with neither entityIds nor scope", () => {
    const claim: ClaimSpec = {
      verb: "cancel",
      entityType: "task",
      expected: { kind: "batch", entityType: "task" },
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("batch claims require entityIds (non-empty) or scope (with filter + non-negative expectedCount)");
  });

  it("rejects batch with empty entityIds and no scope", () => {
    const claim: ClaimSpec = {
      verb: "cancel",
      entityType: "task",
      expected: { kind: "batch", entityType: "task", entityIds: [] },
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("batch claims require entityIds (non-empty) or scope (with filter + non-negative expectedCount)");
  });

  it("rejects batch with scope.expectedCount < 0", () => {
    const claim: ClaimSpec = {
      verb: "cancel",
      entityType: "task",
      expected: { kind: "batch", entityType: "task", scope: { filter: "completed", expectedCount: -1 } },
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("batch claims require entityIds (non-empty) or scope (with filter + non-negative expectedCount)");
  });

  it("rejects batch with scope.expectedCount = 0", () => {
    const claim: ClaimSpec = {
      verb: "cancel",
      entityType: "task",
      expected: { kind: "batch", entityType: "task", scope: { filter: "completed", expectedCount: 0 } },
    };
    // 0 is valid (non-negative)
    expect(validateClaim(claim)).toEqual({ valid: true, errors: [] });
  });

  // ---- top-level ----

  it("rejects missing verb", () => {
    const claim: ClaimSpec = {
      verb: "",
      entityType: "channel_message",
      expected: { kind: "outbound", target: { channelId: "ch-1" } },
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("verb is required");
  });

  it("rejects missing entityType", () => {
    const claim: ClaimSpec = {
      verb: "send",
      entityType: "",
      expected: { kind: "outbound", target: { channelId: "ch-1" } },
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("entityType is required");
  });

  it("rejects missing expected", () => {
    const claim: ClaimSpec = {
      verb: "send",
      entityType: "channel_message",
      expected: undefined as never,
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("expected is required");
  });

  it("rejects unknown expected.kind (exhaustiveness)", () => {
    const claim: ClaimSpec = {
      verb: "send",
      entityType: "channel_message",
      expected: { kind: "unknown_kind" } as never,
    };
    const result = validateClaim(claim);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("got 'unknown_kind'"))).toBe(true);
  });

  // ---- InvalidClaimError ----

  it("InvalidClaimError wraps errors correctly", () => {
    const claim: ClaimSpec = {
      verb: "",
      entityType: "",
      expected: { kind: "outbound", target: {} } as never,
    };
    const err = new InvalidClaimError(["verb is required", "entityType is required"]);
    expect(err.message).toBe("Invalid claim spec: verb is required; entityType is required");
    expect(err.errors).toEqual(["verb is required", "entityType is required"]);
    expect(err.name).toBe("InvalidClaimError");
  });
});
