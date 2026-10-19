/**
 * Task 1-tests: jsonArray contract gate (PreToolUse Track A) — shape gate at boundary.
 *
 * Pre-impl: tests FAIL because:
 *   - `jsonArray` is not in the trackAFormatSchema enum (TBD-impl step 1)
 *   - `TrackAHookCtx.outputAs` is not in the interface (TBD-impl step 3)
 *   - The hook loop does not key-scope jsonArray rules to outputAs key (TBD-impl step 4)
 *
 * Post-impl (Task 1-impl): all tests pass.
 *
 * Regression shield: "format=json keeps allowing objects" — locks the OLD semantics.
 */

import { describe, it, expect, vi } from "vitest";
import { buildTrackAHook, type TrackAHookCtx } from "../../audit/pre-tool-verifier.js";
import type { ContractRule } from "../../store/contract-rules.js";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

function makeCtx(overrides: Partial<TrackAHookCtx> = {}): TrackAHookCtx {
  return {
    auditWriter: vi.fn(),
    stepLogWriter: vi.fn(),
    taskId: "task-1",
    roleId: "role-1",
    executionId: "exec-1",
    stepId: "step-1",
    ...overrides,
  };
}

function makePreToolInput(toolInput: Record<string, unknown>): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "mcp__execution-tools__write_artifact",
    tool_input: toolInput,
  } as unknown as PreToolUseHookInput;
}

// 3rd arg of the SDK hook signature is `{ signal: AbortSignal }` (per
// @anthropic-ai/claude-agent-sdk PreToolUseHookContextOptions). The verifier
// never reads it; we use a fresh AbortController for each test.
const NOOP_HOOK_CTX = { signal: new AbortController().signal };

// `as ContractRule` cast: in pre-impl, trackAFormatSchema enum is
// ['markdown','json','text'] — `{kind:'format',value:'jsonArray'}` won't typecheck.
// The cast is intentional; the runtime shape is what the hook tests against.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const JSON_ARRAY_RULE = { kind: "format", value: "jsonArray" } as any as ContractRule;
const JSON_RULE: ContractRule = { kind: "format", value: "json" };

// -------------------------------------------------------------------
// 1) Shape gate behavior via the hook (covers checkTrackARule + key-scope)
// -------------------------------------------------------------------

describe("checkTrackARule (jsonArray)", () => {
  it("(a) hook with jsonArray rule accepts [] (empty array) — returns {} (no deny)", async () => {
    const hook = buildTrackAHook([JSON_ARRAY_RULE], makeCtx({ outputAs: "verdicts" }));
    const out = await hook(
      makePreToolInput({ key: "verdicts", value: [] }) as unknown as Parameters<typeof hook>[0],
      "tu-1",
      NOOP_HOOK_CTX,
    );
    expect(out).toEqual({});
  });

  it("(b) hook with jsonArray rule accepts a non-empty array of verdicts", async () => {
    const hook = buildTrackAHook([JSON_ARRAY_RULE], makeCtx({ outputAs: "verdicts" }));
    const value = [{ predictionId: "x", status: "confirmed", outcome: "ok" }];
    const out = await hook(
      makePreToolInput({ key: "verdicts", value }) as unknown as Parameters<typeof hook>[0],
      "tu-1",
      NOOP_HOOK_CTX,
    );
    expect(out).toEqual({});
  });

  it("(c) hook with jsonArray rule DENIES an object (morning's actual malformed output)", async () => {
    const hook = buildTrackAHook([JSON_ARRAY_RULE], makeCtx({ outputAs: "verdicts" }));
    const value = { status: "completed", title: "早间" }; // object, not array
    const out = await hook(
      makePreToolInput({ key: "verdicts", value }) as unknown as Parameters<typeof hook>[0],
      "tu-1",
      NOOP_HOOK_CTX,
    );
    const decision = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
    expect(decision?.permissionDecision).toBe("deny");
    expect(decision?.permissionDecisionReason ?? "").toMatch(/数组/);
    expect(decision?.permissionDecisionReason ?? "").toMatch(/\[\]/);
  });

  it("(d) hook with jsonArray rule DENIES a scalar number (non-JSON)", async () => {
    const hook = buildTrackAHook([JSON_ARRAY_RULE], makeCtx({ outputAs: "verdicts" }));
    const out = await hook(
      makePreToolInput({ key: "verdicts", value: 42 }) as unknown as Parameters<typeof hook>[0],
      "tu-1",
      NOOP_HOOK_CTX,
    );
    const decision = (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput;
    expect(decision?.permissionDecision).toBe("deny");
  });

  it("(e) hook with jsonArray rule DENIES a non-JSON string (e.g. 'hello')", async () => {
    const hook = buildTrackAHook([JSON_ARRAY_RULE], makeCtx({ outputAs: "verdicts" }));
    const out = await hook(
      makePreToolInput({ key: "verdicts", value: "hello" }) as unknown as Parameters<typeof hook>[0],
      "tu-1",
      NOOP_HOOK_CTX,
    );
    const decision = (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput;
    expect(decision?.permissionDecision).toBe("deny");
  });

  it("(f) hook with jsonArray rule accepts a JSON string '[]'", async () => {
    const hook = buildTrackAHook([JSON_ARRAY_RULE], makeCtx({ outputAs: "verdicts" }));
    const out = await hook(
      makePreToolInput({ key: "verdicts", value: "[]" }) as unknown as Parameters<typeof hook>[0],
      "tu-1",
      NOOP_HOOK_CTX,
    );
    expect(out).toEqual({});
  });

  it("(g) hook with jsonArray rule DENIES a JSON string of an object '{\"a\":1}'", async () => {
    const hook = buildTrackAHook([JSON_ARRAY_RULE], makeCtx({ outputAs: "verdicts" }));
    const out = await hook(
      makePreToolInput({ key: "verdicts", value: '{"a":1}' }) as unknown as Parameters<typeof hook>[0],
      "tu-1",
      NOOP_HOOK_CTX,
    );
    const decision = (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput;
    expect(decision?.permissionDecision).toBe("deny");
  });

  // ----- Regression shield: format=json still allows objects -----

  it("(h) REGRESSION: format=json still ALLOWS object values (existing semantics preserved)", async () => {
    const hook = buildTrackAHook([JSON_RULE], makeCtx({ outputAs: "verdicts" }));
    const value = { status: "completed", title: "anything" };
    const out = await hook(
      makePreToolInput({ key: "verdicts", value }) as unknown as Parameters<typeof hook>[0],
      "tu-1",
      NOOP_HOOK_CTX,
    );
    expect(out).toEqual({});
  });
});

// -------------------------------------------------------------------
// 2) Key-scoping: jsonArray rule is gated on tool_input.key === ctx.outputAs
// -------------------------------------------------------------------

describe("buildTrackAHook jsonArray key-scoping (outputAs)", () => {
  it("(a) DENIES when tool_input.key === ctx.outputAs and value is an object", async () => {
    const hook = buildTrackAHook([JSON_ARRAY_RULE], makeCtx({ outputAs: "verdicts" }));
    const out = await hook(
      makePreToolInput({ key: "verdicts", value: { foo: 1 } }) as unknown as Parameters<typeof hook>[0],
      "tu-1",
      NOOP_HOOK_CTX,
    );
    const decision = (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput;
    expect(decision?.permissionDecision).toBe("deny");
  });

  it("(b) ALLOWS when tool_input.key !== ctx.outputAs (e.g. 'scratch') even with object value", async () => {
    const hook = buildTrackAHook([JSON_ARRAY_RULE], makeCtx({ outputAs: "verdicts" }));
    // scratch key is NOT the outputAs key, so the jsonArray rule should NOT fire
    const out = await hook(
      makePreToolInput({ key: "scratch", value: { foo: 1 } }) as unknown as Parameters<typeof hook>[0],
      "tu-1",
      NOOP_HOOK_CTX,
    );
    expect(out).toEqual({});
  });

  it("(c) ALLOWS when ctx.outputAs is undefined and value is anything (no key-scoping → no constraint)", async () => {
    const hook = buildTrackAHook([JSON_ARRAY_RULE], makeCtx({ outputAs: undefined }));
    // Without outputAs ctx, the jsonArray rule is skipped (no way to key-scope)
    const out = await hook(
      makePreToolInput({ key: "verdicts", value: { foo: 1 } }) as unknown as Parameters<typeof hook>[0],
      "tu-1",
      NOOP_HOOK_CTX,
    );
    expect(out).toEqual({});
  });
});
