import { describe, it, expect, beforeEach, vi } from "vitest";

async function* defaultMockIterator() {
  yield { type: "result" as const, result: "ok" };
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => defaultMockIterator()),
}));

// Stable reference to the mocked query — same pattern as execution-manager.test.ts:147-149
const { query: mockQuery } = vi.mocked(
  await import("@anthropic-ai/claude-agent-sdk"),
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("llm-eval persistSession", () => {
  it("passes persistSession: false to SDK query() options", async () => {
    const { callClaudeForEvaluation } = await import("../../lib/llm-eval.js");
    await callClaudeForEvaluation("test prompt");

    const queryArgs = mockQuery.mock.calls[0]?.[0] as { options?: { persistSession?: boolean } } | undefined;
    expect(queryArgs?.options?.persistSession).toBe(false);
  });
});
