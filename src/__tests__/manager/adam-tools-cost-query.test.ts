/**
 * Task 2-tests: read_cost_summary adam-tool contract tests.
 * Tests FAIL before Task 2-impl (tool not yet registered).
 * Tests PASS after Task 2-impl adds the tool.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { setupTestDb, getTestDb, clearTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// Mock DB so stores hit the in-memory test DB
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Threshold value that can be mutated per test
let mockThreshold = 0;

// Mock runtime config — must include cost.dailyThresholdUsd or handler throws
vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({
    defaults: {
      allowedTools: [],
      disallowedTools: [],
      plugins: [],
      timeout: 300,
      maxTurns: 50,
    },
    logging: { level: "info" },
    server: { port: 7100 },
    cost: { dailyThresholdUsd: mockThreshold },
  }),
  updateMutableConfig: vi.fn().mockReturnValue({ success: true, updated: [], errors: [] }),
  setLogLevel: vi.fn(),
  isRestartRequiredPath: vi.fn().mockReturnValue(false),
  isMutablePath: vi.fn().mockReturnValue(true),
  getNestedValue: vi.fn(),
  buildSdkAuthEnv: vi.fn().mockReturnValue({}),
  buildSdkEnv: vi.fn().mockReturnValue({}),
}));

// Mock getConfigValue from store/config — used in the handler as primary threshold source
vi.mock("../../store/config.js", () => ({
  getConfigValue: vi.fn((key: string) => {
    if (key === "cost.dailyThresholdUsd") return mockThreshold;
    return undefined;
  }),
  setConfigValue: vi.fn(),
  getAllConfig: vi.fn().mockReturnValue({}),
  deleteConfigValue: vi.fn(),
}));

vi.mock("../../agent/memory-service.js", () => ({
  queryMemory: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../lib/embedding.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(384)),
}));
vi.mock("../../strategy/evaluator/reward.js", () => ({
  calculateReward: vi.fn().mockReturnValue({ reward: 0.8, breakdown: {}, source: "mock", confidence: 0.9 }),
}));
vi.mock("../../strategy/engine.js", () => ({
  StrategyEngine: { selectStrategy: vi.fn().mockReturnValue(null), recordTrial: vi.fn(), getStrategies: vi.fn().mockReturnValue([]) },
}));
vi.mock("../../strategy/generator.js", () => ({
  StrategyGenerator: { generateVariants: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
}));

// Mock SDK so tool() just records the registration (mirrors adam-tools.test.ts pattern)
const { mockCreateSdkMcpServer, mockTool } = vi.hoisted(() => {
  const mockCreateSdkMcpServer = vi.fn().mockImplementation((config: unknown) => config);
  const mockTool = vi.fn().mockImplementation(
    (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, inputSchema: schema, handler }),
  );
  return { mockCreateSdkMcpServer, mockTool };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

const { createAdamTools } = await import("../../manager/adam-tools.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

function NOW() { return Date.now(); }

/** Seed a priced llm_costs row for the given epoch ms timestamp */
function seedRow(opts: {
  id: string;
  costUsd: number;
  createdAt: number;
  priced?: number;
}) {
  const db = getTestDb();
  db.prepare(`
    INSERT OR IGNORE INTO llm_costs
      (id, call_id, source, model, cost_usd, priced, estimated,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 100, 50, 0, 0, ?)
  `).run(
    opts.id, `call-${opts.id}`, "task", "claude-sonnet-4-6",
    opts.costUsd, opts.priced ?? 1, opts.createdAt,
  );
}

function getTool(name: string) {
  vi.clearAllMocks();
  mockCreateSdkMcpServer.mockClear();
  createAdamTools();
  const config = mockCreateSdkMcpServer.mock.calls[0][0] as { tools: Array<{ name: string; handler: (a: unknown) => Promise<unknown> }> };
  return config.tools.find((t) => t.name === name);
}

async function callTool(tool: { handler: (args: unknown) => Promise<unknown> }, args: unknown) {
  const result = await tool.handler(args) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("read_cost_summary adam-tool", () => {
  beforeEach(() => {
    clearTestDb();
    mockThreshold = 0;
  });

  afterAll(() => cleanup());

  it("tool is registered in buildTools", () => {
    const t = getTool("read_cost_summary");
    expect(t).toBeDefined();
  });

  it("today window: includes today rows, excludes old rows", async () => {
    const t = getTool("read_cost_summary");
    expect(t).toBeDefined();

    // Today rows summing to $2.50
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const ts = midnight.getTime() + 60_000; // 1 min after midnight
    seedRow({ id: "r1", costUsd: 1.50, createdAt: ts });
    seedRow({ id: "r2", costUsd: 1.00, createdAt: ts + 1000 });
    // 3-days-ago row — must be excluded from today window
    const threeDaysAgo = midnight.getTime() - 3 * 24 * 60 * 60 * 1000;
    seedRow({ id: "r-old", costUsd: 99.0, createdAt: threeDaysAgo });

    const now = Date.now();
    const result = await callTool(t!, { from: midnight.getTime(), to: now });
    expect(result.totalCostUsd).toBeCloseTo(2.5, 4);
  });

  it("overThreshold = true when spend > threshold (today window)", async () => {
    mockThreshold = 1.0;
    const t = getTool("read_cost_summary");
    expect(t).toBeDefined();

    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const ts = midnight.getTime() + 60_000;
    seedRow({ id: "t1", costUsd: 1.50, createdAt: ts });
    seedRow({ id: "t2", costUsd: 1.00, createdAt: ts + 1000 });

    const now = Date.now();
    const result = await callTool(t!, { from: midnight.getTime(), to: now });
    expect(result.totalCostUsd).toBeCloseTo(2.5, 4);
    expect(result.thresholdUsd).toBe(1.0);
    expect(result.overThreshold).toBe(true);
  });

  it("overThreshold = false when spend < threshold", async () => {
    mockThreshold = 5.0;
    const t = getTool("read_cost_summary");
    expect(t).toBeDefined();

    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const ts = midnight.getTime() + 60_000;
    seedRow({ id: "u1", costUsd: 1.50, createdAt: ts });
    seedRow({ id: "u2", costUsd: 1.00, createdAt: ts + 1000 });

    const now = Date.now();
    const result = await callTool(t!, { from: midnight.getTime(), to: now });
    expect(result.overThreshold).toBe(false);
    expect(result.thresholdUsd).toBe(5.0);
  });

  it("overThreshold = false when threshold = 0 (disabled)", async () => {
    mockThreshold = 0;
    const t = getTool("read_cost_summary");
    expect(t).toBeDefined();

    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const ts = midnight.getTime() + 60_000;
    seedRow({ id: "d1", costUsd: 100.0, createdAt: ts });

    const now = Date.now();
    const result = await callTool(t!, { from: midnight.getTime(), to: now });
    expect(result.overThreshold).toBe(false);
    expect(result.thresholdUsd).toBe(0);
  });

  it("unpricedCallCount surfaces unpriced rows", async () => {
    const t = getTool("read_cost_summary");
    expect(t).toBeDefined();

    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const ts = midnight.getTime() + 60_000;
    seedRow({ id: "p1", costUsd: 1.0, createdAt: ts, priced: 1 });
    seedRow({ id: "np1", costUsd: 0, createdAt: ts + 1000, priced: 0 });

    const now = Date.now();
    const result = await callTool(t!, { from: midnight.getTime(), to: now });
    expect(result.unpricedCallCount).toBe(1);
  });

  it("result is JSON-parseable with expected shape", async () => {
    const t = getTool("read_cost_summary");
    expect(t).toBeDefined();

    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const ts = midnight.getTime() + 60_000;
    seedRow({ id: "s1", costUsd: 0.5, createdAt: ts });

    const now = Date.now();
    const result = await callTool(t!, { from: midnight.getTime(), to: now });
    expect(result).toHaveProperty("window");
    expect(result).toHaveProperty("totalCostUsd");
    expect(result).toHaveProperty("thresholdUsd");
    expect(result).toHaveProperty("overThreshold");
    expect(result).toHaveProperty("callCount");
    expect(result).toHaveProperty("unpricedCallCount");
    expect(typeof result.window.from).toBe("number");
    expect(typeof result.window.to).toBe("number");
  });
});
