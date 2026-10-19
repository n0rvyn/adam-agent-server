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

// Real store/channels.ts — NOT mocked. The value of Task 5 is verifying that
// "update_channel_recipient_caps writes to DB and getRecipientCap reads the new value immediately".
const { createAdamTools } = await import("../../manager/adam-tools.js");
const { createChannel, getRecipientCap } = await import("../../store/channels.js");

afterAll(() => cleanup());

describe("recipient cap roundtrip: update → list → getRecipientCap", () => {
  type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

  let updateTool: ToolHandler;
  let getTool: ToolHandler;
  let listTool: ToolHandler;
  let channelId: string;

  beforeEach(() => {
    clearTestDb();
    vi.clearAllMocks();

    channelId = `email-roundtrip-${Date.now()}`;
    createChannel({
      id: channelId,
      name: "Roundtrip Email Channel",
      platform: "email",
      enabled: true,
      status: "connected",
      config: { address: "roundtrip@example.com" },
      createdAt: Date.now(),
      messageCount: 0,
    });

    const server = createAdamTools() as unknown as {
      tools: Array<{ name: string; handler: ToolHandler }>;
    };

    const findTool = (name: string) => {
      const t = server.tools.find((t) => t.name === name);
      if (!t) throw new Error(`tool '${name}' not found in server.tools`);
      return (args: Record<string, unknown>) => t.handler(args);
    };

    updateTool = findTool("update_channel_recipient_caps");
    getTool = findTool("get_channel_recipient_caps");
    listTool = findTool("list_channels");
  });

  it("Step 1: fresh channel has default cap in list and getRecipientCap", async () => {
    const raw = await listTool({});
    const payload = JSON.parse(raw.content[0].text);
    const ch = payload.channels.find((c: { id: string }) => c.id === channelId);
    expect(ch).toBeDefined();
    expect(ch.defaultRecipientCapBytes).toBe(DEFAULT_EMAIL_CAP_BYTES);
    expect(getRecipientCap(channelId, "any.com")).toBe(DEFAULT_EMAIL_CAP_BYTES);
  });

  it("Step 2-5: update defaultBytes to '35MB', list and getRecipientCap immediately return new value", async () => {
    // Step 2: update
    const updateRaw = await updateTool({ channelId, defaultBytes: "35MB" });
    const updatePayload = JSON.parse(updateRaw.content[0].text);
    expect(updatePayload.success).toBe(true);

    // Step 3: list_channels sees new value immediately (no cache)
    const listRaw = await listTool({});
    const listPayload = JSON.parse(listRaw.content[0].text);
    const listCh = listPayload.channels.find((c: { id: string }) => c.id === channelId);
    expect(listCh.defaultRecipientCapBytes).toBe(36_700_160);

    // Step 4: get_channel_recipient_caps also sees new value
    const getRaw = await getTool({ channelId });
    const getPayload = JSON.parse(getRaw.content[0].text);
    expect(getPayload.channels[0].defaultRecipientCapBytes).toBe(36_700_160);

    // Step 5: real downstream consumer (getRecipientCap) sees new value immediately
    expect(getRecipientCap(channelId, "any.com")).toBe(36_700_160);
  });

  it("Step 6: set recipientCapMap, per-domain override takes effect immediately", async () => {
    // First set a default
    await updateTool({ channelId, defaultBytes: "35MB" });

    // Set per-domain override
    const updateRaw = await updateTool({ channelId, recipientCapMap: { "qq.com": 26_214_400 } });
    const updatePayload = JSON.parse(updateRaw.content[0].text);
    expect(updatePayload.success).toBe(true);

    // qq.com gets the override
    expect(getRecipientCap(channelId, "qq.com")).toBe(26_214_400);
    // other domains fall back to the channel default
    expect(getRecipientCap(channelId, "other.com")).toBe(36_700_160);
  });
});
