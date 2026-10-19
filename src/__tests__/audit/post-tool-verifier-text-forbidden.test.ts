/**
 * Track B `textContentForbidden` rule (post-tool-verifier).
 *
 * Purpose: keep machine-form handles out of listener-facing broadcast scripts.
 * The 口播稿 (broadcast) artifact must never voice a raw `预测ID` handle or a
 * numeric `置信度 0.NN` — both are internal ledger plumbing injected by
 * belief-ledger.ts (buildSettlementSection / buildOpenQuestionsSection).
 * Qualitative self-falsification ("我看走眼了/押对了") carries no number/handle
 * and must pass.
 *
 * These tests drive the REAL buildTrackBHook with a mocked ctx and assert the
 * reject path (unlink + audit + step_log) fires on a leaking script and stays
 * silent on a clean one.
 */

import { describe, it, expect, vi } from "vitest";
import { buildTrackBHook, type TrackBHookCtx } from "../../audit/post-tool-verifier.js";
import { ContractRuleItemSchema, type ContractRule } from "../../store/contract-rules.js";

const PUBLISH_ARTIFACT_TOOL = "mcp__execution-tools__publish_artifact_file";

// The production patterns the 口播稿 step declares: literal `预测ID` (no reason
// to voice it) + a confidence value (`置信度` immediately followed by a number).
const KOUBO_PATTERNS = ["预测ID", "置信度\\s*\\d+(\\.\\d+)?%?"];

function makeRule(overrides: Partial<Extract<ContractRule, { kind: "textContentForbidden" }>> = {}): ContractRule {
  return {
    kind: "textContentForbidden",
    patterns: KOUBO_PATTERNS,
    label: "口播稿不得出现内部句柄",
    ...overrides,
  } as ContractRule;
}

function makeCtx(text: string, overrides: Partial<TrackBHookCtx> = {}): TrackBHookCtx {
  return {
    auditWriter: vi.fn(),
    stepLogWriter: vi.fn(),
    audioAnalyzer: vi.fn(async () => ({ zcRatePerS: 0, durationMs: 0 })),
    statFn: vi.fn(async () => ({ size: text.length })),
    unlinkFn: vi.fn(async () => undefined),
    readTextFn: vi.fn(async () => text),
    getSubagentSessionId: () => undefined,
    onFailure: vi.fn(),
    taskId: "task-koubo",
    roleId: "role-koubo",
    executionId: "exec-koubo",
    stepId: "口播稿",
    ...overrides,
  };
}

function makePublishInput(toolInput: Record<string, unknown>) {
  return {
    hook_event_name: "PostToolUse",
    tool_name: PUBLISH_ARTIFACT_TOOL,
    tool_input: toolInput,
    agent_id: "agent-1",
    agent_type: "subagent",
  } as unknown as Parameters<ReturnType<typeof buildTrackBHook>>[0];
}

const NOOP_HOOK_CTX = { signal: new AbortController().signal } as unknown as Parameters<ReturnType<typeof buildTrackBHook>>[2];

// Today's actual leaked morning opener (verbatim shape).
const LEAKING_SCRIPT =
  "好，先说几句开场。昨天的预测我看了下证据走向。预测ID 53173569，关于「替我感知」的那个——置信度 0.75，算是我比较有信心的一条。";

// What the qualitative self-falsification should sound like instead.
const CLEAN_SCRIPT =
  "好，先说几句开场。昨天那条判断我看走眼了，方向反了；另一条我押对了，比我当时想的更确定。";

describe("contract-rules schema: textContentForbidden", () => {
  it("accepts a well-formed rule", () => {
    const parsed = ContractRuleItemSchema.safeParse(makeRule());
    expect(parsed.success).toBe(true);
  });

  it("rejects empty patterns array", () => {
    const parsed = ContractRuleItemSchema.safeParse({ kind: "textContentForbidden", patterns: [] });
    expect(parsed.success).toBe(false);
  });
});

describe("buildTrackBHook — textContentForbidden", () => {
  it("REJECTS a script leaking raw 预测ID + 置信度 number (unlink + audit + step_log + onFailure)", async () => {
    const ctx = makeCtx(LEAKING_SCRIPT);
    const hook = buildTrackBHook([makeRule()], ctx);

    await hook(makePublishInput({ sourcePath: "/tmp/koubo.txt", mimeType: "text/plain" }), "tu-1", NOOP_HOOK_CTX);

    expect(ctx.readTextFn).toHaveBeenCalledWith("/tmp/koubo.txt");
    expect(ctx.unlinkFn).toHaveBeenCalledWith("/tmp/koubo.txt");
    expect(ctx.auditWriter).toHaveBeenCalledTimes(1);
    expect(ctx.stepLogWriter).toHaveBeenCalledTimes(1);
    const logArg = (ctx.stepLogWriter as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(logArg.type).toBe("validator_error");
    expect(logArg.content).toMatch(/textContentForbidden/);
    expect(ctx.onFailure).toHaveBeenCalled();
  });

  it("PASSES qualitative self-falsification with no number/handle", async () => {
    const ctx = makeCtx(CLEAN_SCRIPT);
    const hook = buildTrackBHook([makeRule()], ctx);

    await hook(makePublishInput({ sourcePath: "/tmp/koubo.txt", mimeType: "text/plain" }), "tu-1", NOOP_HOOK_CTX);

    expect(ctx.readTextFn).toHaveBeenCalled();
    expect(ctx.unlinkFn).not.toHaveBeenCalled();
    expect(ctx.auditWriter).not.toHaveBeenCalled();
    expect(ctx.stepLogWriter).not.toHaveBeenCalled();
  });

  it("PASSES a topical mention of 置信度 with no adjacent number (the concept, not a value)", async () => {
    const ctx = makeCtx("我们聊聊模型校准的置信度问题，它一直是个老大难。");
    const hook = buildTrackBHook([makeRule()], ctx);

    await hook(makePublishInput({ sourcePath: "/tmp/koubo.txt", mimeType: "text/plain" }), "tu-1", NOOP_HOOK_CTX);

    expect(ctx.unlinkFn).not.toHaveBeenCalled();
    expect(ctx.auditWriter).not.toHaveBeenCalled();
  });

  it("does NOT read non-text artifacts (audio/mpeg) — rule skipped, no unlink", async () => {
    const ctx = makeCtx(LEAKING_SCRIPT);
    const hook = buildTrackBHook([makeRule()], ctx);

    await hook(makePublishInput({ sourcePath: "/tmp/koubo.mp3", mimeType: "audio/mpeg" }), "tu-1", NOOP_HOOK_CTX);

    expect(ctx.readTextFn).not.toHaveBeenCalled();
    expect(ctx.unlinkFn).not.toHaveBeenCalled();
    expect(ctx.auditWriter).not.toHaveBeenCalled();
  });

  it("ignores non-publish tool events", async () => {
    const ctx = makeCtx(LEAKING_SCRIPT);
    const hook = buildTrackBHook([makeRule()], ctx);

    const out = await hook(
      {
        hook_event_name: "PostToolUse",
        tool_name: "mcp__execution-tools__write_artifact",
        tool_input: { sourcePath: "/tmp/koubo.txt", mimeType: "text/plain" },
      } as unknown as Parameters<typeof hook>[0],
      "tu-1",
      NOOP_HOOK_CTX,
    );

    expect(out).toEqual({});
    expect(ctx.readTextFn).not.toHaveBeenCalled();
    expect(ctx.unlinkFn).not.toHaveBeenCalled();
  });
});
