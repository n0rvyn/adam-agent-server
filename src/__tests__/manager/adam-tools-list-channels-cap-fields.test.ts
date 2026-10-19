import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({
    defaults: { allowedTools: [], disallowedTools: [], plugins: [], timeout: 300, maxTurns: 50 },
    logging: { level: "info" },
    server: { port: 7100 },
  }),
  updateMutableConfig: vi.fn().mockReturnValue({ success: true, updated: [], errors: [] }),
  setLogLevel: vi.fn(),
  isRestartRequiredPath: vi.fn().mockReturnValue(false),
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

vi.mock("../../sandbox/provider.js", () => ({
  getSandboxProvider: () => ({ platform: "sandbox-exec", isAvailable: async () => true }),
  isSandboxAvailable: vi.fn().mockResolvedValue(true),
}));

const { mockCreateSdkMcpServer, mockTool } = vi.hoisted(() => ({
  mockCreateSdkMcpServer: vi.fn().mockImplementation((config: unknown) => config),
  mockTool: vi.fn().mockImplementation((name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema: schema,
    handler,
  })),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

const { createAdamTools } = await import("../../manager/adam-tools.js");
const { createChannel } = await import("../../store/channels.js");

afterAll(() => cleanup());

describe("list_channels includes cap fields for email channels", () => {
  let listTool: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  let emailChannelId: string;
  let wechatChannelId: string;

  beforeEach(() => {
    clearTestDb();
    vi.clearAllMocks();

    emailChannelId = `email-${Date.now()}-1`;
    createChannel({
      id: emailChannelId,
      name: "Test Email Channel",
      platform: "email",
      enabled: true,
      status: "connected",
      config: { address: "test@example.com" },
      defaultRecipientCapBytes: 36_700_160,
      recipientCapMap: { "qq.com": 26_214_400 },
      createdAt: Date.now(),
      messageCount: 0,
    });

    wechatChannelId = `wechat-${Date.now()}-2`;
    createChannel({
      id: wechatChannelId,
      name: "Test WeChat Channel",
      platform: "wechat",
      enabled: true,
      status: "connected",
      config: {},
      createdAt: Date.now(),
      messageCount: 0,
    });

    const server = createAdamTools() as unknown as {
      tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>;
    };
    const tool = server.tools.find((t) => t.name === "list_channels");
    if (!tool) throw new Error("tool 'list_channels' not found in server.tools");
    listTool = (args) => tool.handler(args) as Promise<{ content: Array<{ text: string }> }>;
  });

  it("email channel row contains defaultRecipientCapBytes and recipientCapMap fields", async () => {
    const raw = await listTool({});
    const payload = JSON.parse(raw.content[0].text);
    const emailCh = payload.channels.find((ch: { id: string }) => ch.id === emailChannelId);
    expect(emailCh).toBeDefined();
    expect(emailCh).toHaveProperty("defaultRecipientCapBytes");
    expect(emailCh).toHaveProperty("recipientCapMap");
  });

  it("email channel row has correct cap values", async () => {
    const raw = await listTool({});
    const payload = JSON.parse(raw.content[0].text);
    const emailCh = payload.channels.find((ch: { id: string }) => ch.id === emailChannelId);
    expect(emailCh.defaultRecipientCapBytes).toBe(36_700_160);
    expect(emailCh.recipientCapMap).toEqual({ "qq.com": 26_214_400 });
  });

  it("existing fields (id, name, platform, status, chatId) are still present on email channel", async () => {
    const raw = await listTool({});
    const payload = JSON.parse(raw.content[0].text);
    const emailCh = payload.channels.find((ch: { id: string }) => ch.id === emailChannelId);
    expect(emailCh).toHaveProperty("id");
    expect(emailCh).toHaveProperty("name");
    expect(emailCh).toHaveProperty("platform");
    expect(emailCh).toHaveProperty("status");
    expect(emailCh).toHaveProperty("chatId");
  });

  it("wechat channel row does not have cap fields (or they are undefined)", async () => {
    const raw = await listTool({});
    const payload = JSON.parse(raw.content[0].text);
    const wechatCh = payload.channels.find((ch: { id: string }) => ch.id === wechatChannelId);
    expect(wechatCh).toBeDefined();
    // Non-email channels should not have cap fields (either absent or undefined)
    expect(wechatCh.defaultRecipientCapBytes).toBeUndefined();
    expect(wechatCh.recipientCapMap).toBeUndefined();
  });
});
