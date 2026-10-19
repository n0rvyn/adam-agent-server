import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseVerdict } from "../../agent/conflict-resolver.js";
import type { Belief } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Mock setup — must be set up before importing conflict-resolver
// ---------------------------------------------------------------------------

const haikuMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/llm-eval.js", () => ({
  callClaudeForEvaluation: haikuMock,
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({
    anthropic: { defaultHaikuModel: "claude-haiku-4-5" },
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBelief(id: string, content = "default content"): Belief {
  return {
    id,
    roleId: "r1",
    content,
    isAnti: false,
    evidenceObsIds: [],
    supersededBy: undefined,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    lastValidatedAt: Date.now(),
    status: "active",
    injectCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("conflict-resolver parseVerdict", () => {
  beforeEach(() => { haikuMock.mockClear(); });

  it("empty neighbors → coexist without calling Haiku", async () => {
    const { resolveBeliefConflict } = await import("../../agent/conflict-resolver.js");
    const verdict = await resolveBeliefConflict({ content: "test" }, []);
    expect(verdict).toEqual({ action: "coexist" });
    expect(haikuMock).not.toHaveBeenCalled();
  });

  it("merge verdict round-trip", async () => {
    haikuMock.mockResolvedValue('{"action":"merge","intoBeliefId":"b1","mergedContent":"Merged: prefer base64 over raw."}');

    const { resolveBeliefConflict } = await import("../../agent/conflict-resolver.js");
    const neighbors = [makeBelief("b1", "Use base64 encoding")];
    const verdict = await resolveBeliefConflict({ content: "Prefer base64 over raw audio" }, neighbors);

    expect(verdict).toEqual({
      action: "merge",
      intoBeliefId: "b1",
      mergedContent: "Merged: prefer base64 over raw.",
    });
  });

  it("supersede verdict round-trip", async () => {
    haikuMock.mockResolvedValue('{"action":"supersede","oldBeliefId":"b2"}');

    const { resolveBeliefConflict } = await import("../../agent/conflict-resolver.js");
    const neighbors = [makeBelief("b2", "Never use base64")];
    const verdict = await resolveBeliefConflict({ content: "base64 is always fine" }, neighbors);

    expect(verdict).toEqual({ action: "supersede", oldBeliefId: "b2" });
  });

  it("coexist verdict round-trip", async () => {
    haikuMock.mockResolvedValue('{"action":"coexist"}');

    const { resolveBeliefConflict } = await import("../../agent/conflict-resolver.js");
    const verdict = await resolveBeliefConflict({ content: "test belief" }, [makeBelief("b1")]);
    expect(verdict).toEqual({ action: "coexist" });
  });

  it("malformed JSON → coexist fallback", () => {
    const verdict = parseVerdict("not json at all {{{{", []);
    expect(verdict).toEqual({ action: "coexist" });
  });

  it("Haiku throws → coexist fallback", async () => {
    haikuMock.mockRejectedValue(new Error("network error"));

    const { resolveBeliefConflict } = await import("../../agent/conflict-resolver.js");
    const verdict = await resolveBeliefConflict({ content: "test" }, [makeBelief("b1")]);
    expect(verdict).toEqual({ action: "coexist" });
  });

  it("verdict referencing unknown belief id → coexist fallback (defensive)", async () => {
    haikuMock.mockResolvedValue('{"action":"merge","intoBeliefId":"unknown-id","mergedContent":"Merged text."}');

    const { resolveBeliefConflict } = await import("../../agent/conflict-resolver.js");
    const verdict = await resolveBeliefConflict({ content: "test" }, [makeBelief("b1")]);
    // unknown-id is not in neighbors → defensive coexist
    expect(verdict).toEqual({ action: "coexist" });
  });

  it("strips code fences before parsing", async () => {
    haikuMock.mockResolvedValue('```json\n{"action":"supersede","oldBeliefId":"b3"}\n```');

    const { resolveBeliefConflict } = await import("../../agent/conflict-resolver.js");
    const verdict = await resolveBeliefConflict({ content: "test" }, [makeBelief("b3")]);
    expect(verdict).toEqual({ action: "supersede", oldBeliefId: "b3" });
  });

  it("prompt does not contain deprecated confidence/useCount fields (v3 cleanup)", async () => {
    haikuMock.mockResolvedValue('{"action":"coexist"}');

    const { resolveBeliefConflict } = await import("../../agent/conflict-resolver.js");
    const neighbors = [makeBelief("b-v3", "Use success_ema for ranking")];
    await resolveBeliefConflict({ content: "test belief" }, neighbors);

    expect(haikuMock).toHaveBeenCalledOnce();
    const promptArg: string = haikuMock.mock.calls[0][0] as string;
    // v3: prompt must NOT embed confidence (conf=) or useCount (used=) — deprecated fields
    expect(promptArg).not.toContain("conf=");
    expect(promptArg).not.toContain("used=");
  });
});
