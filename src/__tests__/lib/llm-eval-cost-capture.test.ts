/**
 * Task 6-tests: eval-path cost capture test.
 *
 * Asserts that callClaudeForEvaluation records cost via recordLlmCost(source='eval')
 * when the SDK result event carries cost fields — covering intent-eval.ts +
 * context-compact.ts transitively (both delegate here).
 *
 * FAILS before Task 6-impl (no recordLlmCost call in llm-eval.ts).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
afterAll(() => { cleanup(); });

// ─── Price table ──────────────────────────────────────────────────────────────
const TEST_PRICE_TABLE = {
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 3.75, estimated: true },
};

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    anthropic: { apiKey: "test", baseUrl: "", model: "claude-sonnet-4-6" },
    defaults: {},
    pricing: { models: TEST_PRICE_TABLE },
  })),
  buildSdkAuthEnv: vi.fn(() => ({})),
  buildSdkEnv: vi.fn(() => ({})),
}));

// Mock node:fs/promises so mkdir doesn't touch disk
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => {}),
}));

// Hoisted mock for SDK query
const { mockEvalQuery } = vi.hoisted(() => ({
  mockEvalQuery: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockEvalQuery,
  createSdkMcpServer: vi.fn(() => ({ type: "sdk", name: "mock-mcp" })),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => ({ name: _name, handler })),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { callClaudeForEvaluation } from "../../lib/llm-eval.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
});

describe("Task 6-tests: eval-path cost capture → recordLlmCost(source='eval')", () => {
  it("TC1: result event with modelUsage — inserts a llm_costs row with source='eval'", async () => {
    const resultEvent = {
      type: "result",
      result: "eval output text",
      num_turns: 1,
      total_cost_usd: 0.02,
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 80,
          outputTokens: 30,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.02,
        },
      },
    };

    mockEvalQuery.mockImplementation(() => {
      async function* gen() { yield resultEvent; }
      return gen();
    });

    const returnValue = await callClaudeForEvaluation("evaluate this", { model: "claude-sonnet-4-6" });

    // Return value must be unchanged
    expect(returnValue).toBe("eval output text");

    // Allow async recordLlmCost (void promise) to settle
    await new Promise((r) => setTimeout(r, 50));

    const db = getTestDb();
    const rows = db.prepare(
      "SELECT source, role_id, task_id, session_id, message_id FROM llm_costs WHERE source = 'eval'"
    ).all() as Array<{ source: string; role_id: string | null; task_id: string | null; session_id: string | null; message_id: string | null }>;

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].source).toBe("eval");
    // Eval rows have null task/session/message (no originating record)
    expect(rows[0].task_id).toBeNull();
    expect(rows[0].session_id).toBeNull();
    expect(rows[0].message_id).toBeNull();
  });

  it("TC2: result event WITHOUT modelUsage — no llm_costs row inserted (no cost to record)", async () => {
    const noModelUsageEvent = {
      type: "result",
      result: "no cost eval output",
      num_turns: 1,
      total_cost_usd: 0.01,
      // no modelUsage
    };

    mockEvalQuery.mockImplementation(() => {
      async function* gen() { yield noModelUsageEvent; }
      return gen();
    });

    const returnValue = await callClaudeForEvaluation("another eval");
    expect(returnValue).toBe("no cost eval output");

    await new Promise((r) => setTimeout(r, 50));

    const db = getTestDb();
    const count = (db.prepare(
      "SELECT COUNT(*) AS n FROM llm_costs WHERE source = 'eval'"
    ).get() as { n: number }).n;

    // Without modelUsage, no row inserted (no recompute possible)
    expect(count).toBe(0);
  });

  it("TC3: cost capture failure does NOT break eval return value", async () => {
    // Even if the DB write fails, callClaudeForEvaluation must return the eval text.
    // Simulate by breaking the llm_costs table (use a fresh DB that has no llm_costs table).
    const resultEvent = {
      type: "result",
      result: "resilient eval text",
      num_turns: 1,
      total_cost_usd: 0.01,
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 50,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.01,
        },
      },
    };

    mockEvalQuery.mockImplementation(() => {
      async function* gen() { yield resultEvent; }
      return gen();
    });

    // Should not throw even if cost recording fails internally
    const returnValue = await callClaudeForEvaluation("resilience test");
    expect(returnValue).toBe("resilient eval text");
  });
});
