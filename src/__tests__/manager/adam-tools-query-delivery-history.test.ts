/**
 * Unit tests for adam-tools query_delivery_history.
 * Task 5 of Phase C: chatmanager-truth plan.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { setupTestDb, getTestDb, clearTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// Mock DB so stores hit the in-memory test DB
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock the SDK (must use vi.hoisted so the factory can reference the mocks at parse time)
const { mockCreateSdkMcpServer, mockTool } = vi.hoisted(() => {
  const mockCreateSdkMcpServer = vi.fn().mockImplementation((config: unknown) => config);
  const mockTool = vi.fn().mockImplementation((name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema: schema,
    handler,
  }));
  return { mockCreateSdkMcpServer, mockTool };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

// Dynamically import adam-tools AFTER mocks are set up
const { createAdamTools } = await import("../../manager/adam-tools.js");

// Import real store for result verification
const { createDeliveryLog } = await import("../../store/delivery-log.js");
const { createDeliveryRule } = await import("../../store/delivery-rules.js");

function seedDeliveryRule() {
  createDeliveryRule({
    id: "rule-seed",
    eventType: "task_complete",
    matchCriteria: {},
    target: { type: "channel", channelId: "default" },
    maxPerMinute: 60,
    skipOriginChannel: false,
    enabled: true,
    createdAt: Date.now(),
  });
}

function seedDelivery(executionId: string, channelId: string, status: string, createdAt: number) {
  createDeliveryLog({
    id: `dl-${Math.random().toString(36).slice(2, 8)}`,
    ruleId: "rule-seed",
    executionId: executionId || undefined,
    status: status as "pending" | "delivered" | "failed" | "expired",
    target: { type: "channel", channelId },
    content: `test content ${Math.random()}`,
    createdAt,
    attempts: 0,
    expiresAt: createdAt + 86_400_000,
  });
}

function getTool(name: string) {
  createAdamTools();
  const config = mockCreateSdkMcpServer.mock.calls[0][0];
  return config.tools.find((t: { name: string }) => t.name === name);
}

async function callTool(tool: { handler: (args: unknown) => Promise<unknown> }, args: unknown) {
  const result = await tool.handler(args) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text);
}

describe("query_delivery_history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSdkMcpServer.mockClear();
    clearTestDb();
    seedDeliveryRule();
  });

  afterAll(() => cleanup());

  it("empty DB — empty items, counts.total === 0", async () => {
    const tool = getTool("query_delivery_history");
    expect(tool).toBeDefined();
    const result = await callTool(tool, {});
    expect(result.items).toHaveLength(0);
    expect(result.counts.total).toBe(0);
  });

  it("single executionId with 6 deliveries, 1 failed — 6 items, counts.byStatus.delivered=5, counts.byStatus.failed=1", async () => {
    const execId = "exec-six";
    const now = Date.now();
    // 5 delivered
    for (let i = 0; i < 5; i++) {
      createDeliveryLog({
        id: `dl-d-${i}`, ruleId: "rule-seed", executionId: execId,
        status: "delivered", target: { type: "channel", channelId: `ch-${i}` },
        attempts: 0,
        content: "ok", createdAt: now - i * 60_000, expiresAt: now + 86_400_000,
        deliveredAt: now - i * 60_000,
      });
    }
    // 1 failed
    createDeliveryLog({
      id: "dl-f-0", ruleId: "rule-seed", executionId: execId,
      status: "failed", target: { type: "channel", channelId: "ch-fail" },
      attempts: 0,
      content: "err", createdAt: now - 10_000, expiresAt: now + 86_400_000,
      error: "connection refused",
    });

    const tool = getTool("query_delivery_history");
    const result = await callTool(tool, { executionId: execId });
    expect(result.items).toHaveLength(6);
    expect(result.counts.byStatus.delivered).toBe(5);
    expect(result.counts.byStatus.failed).toBe(1);
  });

  it("channelId filter narrows to one channel", async () => {
    const execId = "exec-ch-filter";
    const now = Date.now();
    createDeliveryLog({
      id: "dl-ch-a", ruleId: "rule-seed", executionId: execId,
      status: "delivered", target: { type: "channel", channelId: "wechat-main" },
      attempts: 0,
      content: "a", createdAt: now - 1000, expiresAt: now + 86_400_000,
    });
    createDeliveryLog({
      id: "dl-ch-b", ruleId: "rule-seed", executionId: execId,
      status: "delivered", target: { type: "channel", channelId: "wechat-alt" },
      attempts: 0,
      content: "b", createdAt: now - 2000, expiresAt: now + 86_400_000,
    });

    const tool = getTool("query_delivery_history");
    const result = await callTool(tool, { executionId: execId, channelId: "wechat-main" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].channelId).toBe("wechat-main");
  });

  it("timeRangeStart filter excludes older rows", async () => {
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    const twoHoursAgo = now - 7_200_000;
    createDeliveryLog({
      id: "dl-new", ruleId: "rule-seed", status: "delivered",
      target: { type: "channel", channelId: "ch-new" },
      attempts: 0,
      content: "new", createdAt: oneHourAgo, expiresAt: now + 86_400_000,
    });
    createDeliveryLog({
      id: "dl-old", ruleId: "rule-seed", status: "delivered",
      target: { type: "channel", channelId: "ch-old" },
      attempts: 0,
      content: "old", createdAt: twoHoursAgo, expiresAt: now + 86_400_000,
    });

    const tool = getTool("query_delivery_history");
    const result = await callTool(tool, { timeRangeStart: oneHourAgo });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("dl-new");
  });

  it("hasMore === true when row count equals limit", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      createDeliveryLog({
        id: `dl-limit-${i}`, ruleId: "rule-seed", status: "delivered",
        target: { type: "channel", channelId: `ch-${i}` },
        attempts: 0,
        content: `c${i}`, createdAt: now - i, expiresAt: now + 86_400_000,
      });
    }

    const tool = getTool("query_delivery_history");
    const result = await callTool(tool, { limit: 3 });
    expect(result.items).toHaveLength(3);
    expect(result.hasMore).toBe(true);
  });
});
