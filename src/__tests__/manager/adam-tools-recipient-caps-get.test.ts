import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { DEFAULT_EMAIL_CAP_BYTES } from "../../lib/recipient-cap-bounds.js";

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

// Import createAdamTools after all mocks are set up
const { createAdamTools } = await import("../../manager/adam-tools.js");
// Import createChannel after db mock is set up
const { createChannel } = await import("../../store/channels.js");

afterAll(() => cleanup());

describe("get_channel_recipient_caps MCP tool", () => {
  let getTool: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  let channelAId: string;
  let channelBId: string;
  let channelCId: string;
  let channelDId: string;

  beforeEach(() => {
    clearTestDb();
    vi.clearAllMocks();

    // email channel A: no cap config (should fall back to DEFAULT_EMAIL_CAP_BYTES = 20 MB)
    channelAId = `a-${Date.now()}-1`;
    createChannel({
      id: channelAId,
      name: "Email Channel A",
      platform: "email",
      enabled: true,
      status: "connected",
      config: { address: "a@example.com" },
      createdAt: Date.now(),
      messageCount: 0,
    });

    // email channel B: defaultRecipientCapBytes = 36_700_160 (35 MB), no map
    channelBId = `b-${Date.now()}-2`;
    createChannel({
      id: channelBId,
      name: "Email Channel B",
      platform: "email",
      enabled: true,
      status: "connected",
      config: { address: "b@example.com" },
      defaultRecipientCapBytes: 36_700_160,
      createdAt: Date.now(),
      messageCount: 0,
    });

    // wechat channel C: platform != email — must NOT appear in response
    channelCId = `c-${Date.now()}-3`;
    createChannel({
      id: channelCId,
      name: "WeChat Channel C",
      platform: "wechat",
      enabled: true,
      status: "connected",
      config: {},
      createdAt: Date.now(),
      messageCount: 0,
    });

    // email channel D: default 52_428_800 (50 MB) + map {"qq.com": 26_214_400 (25 MB)}
    channelDId = `d-${Date.now()}-4`;
    createChannel({
      id: channelDId,
      name: "Email Channel D",
      platform: "email",
      enabled: true,
      status: "connected",
      config: { address: "d@example.com" },
      defaultRecipientCapBytes: 52_428_800,
      recipientCapMap: { "qq.com": 26_214_400 },
      createdAt: Date.now(),
      messageCount: 0,
    });

    // Get the tool handler from a fresh createAdamTools call
    const server = createAdamTools() as unknown as {
      tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>;
    };
    const tool = server.tools.find((t) => t.name === "get_channel_recipient_caps");
    if (!tool) throw new Error("tool 'get_channel_recipient_caps' not found in server.tools");
    getTool = (args) => tool.handler(args) as Promise<{ content: Array<{ text: string }> }>;
  });

  it("returns all email channels (A, B, D) but not wechat channel C when no channelId given", async () => {
    const raw = await getTool({});
    const payload = JSON.parse(raw.content[0].text);
    expect(payload.channels).toHaveLength(3);
    const ids = payload.channels.map((ch: { id: string }) => ch.id);
    expect(ids).toContain(channelAId);
    expect(ids).toContain(channelBId);
    expect(ids).toContain(channelDId);
    expect(ids).not.toContain(channelCId);
  });

  it("each result row contains id, name, defaultRecipientCapBytes, defaultRecipientCapMB, recipientCapMap", async () => {
    const raw = await getTool({});
    const payload = JSON.parse(raw.content[0].text);
    for (const ch of payload.channels) {
      expect(ch).toHaveProperty("id");
      expect(ch).toHaveProperty("name");
      expect(ch).toHaveProperty("defaultRecipientCapBytes");
      expect(ch).toHaveProperty("defaultRecipientCapMB");
      expect(ch).toHaveProperty("recipientCapMap");
    }
  });

  it("channel A falls back to DEFAULT_EMAIL_CAP_BYTES (20971520) with empty recipientCapMap", async () => {
    const raw = await getTool({});
    const payload = JSON.parse(raw.content[0].text);
    const chA = payload.channels.find((ch: { id: string }) => ch.id === channelAId);
    expect(chA).toBeDefined();
    expect(chA.defaultRecipientCapBytes).toBe(DEFAULT_EMAIL_CAP_BYTES);
    expect(chA.recipientCapMap).toEqual({});
  });

  it("channel B has defaultRecipientCapBytes=36700160 and defaultRecipientCapMB=35", async () => {
    const raw = await getTool({});
    const payload = JSON.parse(raw.content[0].text);
    const chB = payload.channels.find((ch: { id: string }) => ch.id === channelBId);
    expect(chB).toBeDefined();
    expect(chB.defaultRecipientCapBytes).toBe(36_700_160);
    expect(chB.defaultRecipientCapMB).toBe(35);
  });

  it("channel D has correct recipientCapMap with qq.com override", async () => {
    const raw = await getTool({});
    const payload = JSON.parse(raw.content[0].text);
    const chD = payload.channels.find((ch: { id: string }) => ch.id === channelDId);
    expect(chD).toBeDefined();
    expect(chD.defaultRecipientCapBytes).toBe(52_428_800);
    expect(chD.recipientCapMap).toEqual({ "qq.com": 26_214_400 });
  });

  it("returns only the specified channel when channelId is provided", async () => {
    const raw = await getTool({ channelId: channelBId });
    const payload = JSON.parse(raw.content[0].text);
    expect(payload.channels).toHaveLength(1);
    expect(payload.channels[0].id).toBe(channelBId);
  });

  it("returns error when channelId does not exist", async () => {
    const raw = await getTool({ channelId: "00000000-0000-0000-0000-000000000000" });
    const payload = JSON.parse(raw.content[0].text);
    expect(payload).toHaveProperty("error");
  });

  it("returns error when channelId points to a non-email (wechat) channel", async () => {
    // Explicit non-email lookup must hit the same not-found branch as a missing id,
    // because the tool filters to platform==="email" before the id check.
    const raw = await getTool({ channelId: channelCId });
    const payload = JSON.parse(raw.content[0].text);
    expect(payload).toHaveProperty("error");
    expect(payload.error).toMatch(/not found|email channel/i);
  });
});
