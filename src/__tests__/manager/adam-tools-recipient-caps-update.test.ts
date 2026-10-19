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

const { createAdamTools } = await import("../../manager/adam-tools.js");
const { createChannel, getRecipientCap } = await import("../../store/channels.js");
const { withTrace } = await import("../../lib/trace-context.js");

afterAll(() => cleanup());

describe("update_channel_recipient_caps MCP tool", () => {
  let updateTool: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  let emailChannelId: string;
  let wechatChannelId: string;

  beforeEach(() => {
    clearTestDb();
    vi.clearAllMocks();

    emailChannelId = `email-${Date.now()}`;
    wechatChannelId = `wechat-${Date.now()}`;

    createChannel({
      id: emailChannelId,
      name: "Test Email Channel",
      platform: "email",
      enabled: true,
      status: "connected",
      config: { address: "test@example.com" },
      createdAt: Date.now(),
      messageCount: 0,
    });

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
    const tool = server.tools.find((t) => t.name === "update_channel_recipient_caps");
    if (!tool) throw new Error("tool 'update_channel_recipient_caps' not found in server.tools");
    updateTool = (args) => tool.handler(args) as Promise<{ content: Array<{ text: string }> }>;
  });

  it("updates defaultBytes as integer and is immediately readable via getRecipientCap", async () => {
    const raw = await updateTool({ channelId: emailChannelId, defaultBytes: 36_700_160 });
    const payload = JSON.parse(raw.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.channelId).toBe(emailChannelId);
    expect(payload.defaultRecipientCapBytes).toBe(36_700_160);
    // Verify DB write took effect immediately (no cache)
    expect(getRecipientCap(emailChannelId, "example.com")).toBe(36_700_160);
  });

  it('updates defaultBytes from string "35MB" and is immediately readable', async () => {
    const raw = await updateTool({ channelId: emailChannelId, defaultBytes: "35MB" });
    const payload = JSON.parse(raw.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.defaultRecipientCapBytes).toBe(36_700_160);
    expect(getRecipientCap(emailChannelId, "example.com")).toBe(36_700_160);
  });

  it('updates defaultBytes from string "35M" and is immediately readable', async () => {
    const raw = await updateTool({ channelId: emailChannelId, defaultBytes: "35M" });
    const payload = JSON.parse(raw.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.defaultRecipientCapBytes).toBe(36_700_160);
    expect(getRecipientCap(emailChannelId, "example.com")).toBe(36_700_160);
  });

  it("updates recipientCapMap and per-domain override is immediately readable", async () => {
    // First set a default
    await updateTool({ channelId: emailChannelId, defaultBytes: 36_700_160 });
    // Then set per-domain override
    const raw = await updateTool({ channelId: emailChannelId, recipientCapMap: { "qq.com": 26_214_400 } });
    const payload = JSON.parse(raw.content[0].text);
    expect(payload.success).toBe(true);
    expect(getRecipientCap(emailChannelId, "qq.com")).toBe(26_214_400);
    // Non-qq domain falls back to default
    expect(getRecipientCap(emailChannelId, "other.com")).toBe(36_700_160);
  });

  it("empty recipientCapMap clears all overrides so all domains fall back to default", async () => {
    // Set default + map
    await updateTool({ channelId: emailChannelId, defaultBytes: 36_700_160 });
    await updateTool({ channelId: emailChannelId, recipientCapMap: { "qq.com": 26_214_400 } });
    // Clear the map
    const raw = await updateTool({ channelId: emailChannelId, recipientCapMap: {} });
    const payload = JSON.parse(raw.content[0].text);
    expect(payload.success).toBe(true);
    // qq.com should now fall back to default
    expect(getRecipientCap(emailChannelId, "qq.com")).toBe(36_700_160);
  });

  it("returns error with 'not found' when channelId does not exist", async () => {
    const raw = await updateTool({ channelId: "00000000-0000-0000-0000-000000000000" });
    const payload = JSON.parse(raw.content[0].text);
    expect(payload).toHaveProperty("error");
    expect(payload.error).toMatch(/not found/i);
  });

  it("returns error with 'not an email channel' for wechat channel", async () => {
    const raw = await updateTool({ channelId: wechatChannelId });
    const payload = JSON.parse(raw.content[0].text);
    expect(payload).toHaveProperty("error");
    expect(payload.error).toMatch(/not an email channel/i);
  });

  it("returns error with 'below minimum' for defaultBytes=500000 (below 1 MB)", async () => {
    const raw = await updateTool({ channelId: emailChannelId, defaultBytes: 500_000 });
    const payload = JSON.parse(raw.content[0].text);
    expect(payload).toHaveProperty("error");
    expect(payload.error).toMatch(/below minimum/i);
  });

  it('returns error with "exceeds maximum" for defaultBytes="300MB" (above 200 MB)', async () => {
    const raw = await updateTool({ channelId: emailChannelId, defaultBytes: "300MB" });
    const payload = JSON.parse(raw.content[0].text);
    expect(payload).toHaveProperty("error");
    expect(payload.error).toMatch(/exceeds maximum/i);
  });

  it("returns error for recipientCapMap with uppercase domain key (rejected by RECIPIENT_DOMAIN_REGEX)", async () => {
    const raw = await updateTool({ channelId: emailChannelId, recipientCapMap: { "NotALowerDomain": 10_485_760 } });
    const payload = JSON.parse(raw.content[0].text);
    expect(payload).toHaveProperty("error");
  });

  it("returns error when neither defaultBytes nor recipientCapMap is provided", async () => {
    const raw = await updateTool({ channelId: emailChannelId });
    const payload = JSON.parse(raw.content[0].text);
    expect(payload).toHaveProperty("error");
    expect(payload.error).toMatch(/at least one/i);
    // Confirm DB unchanged — channel still on default (no prior update in this test case)
    expect(getRecipientCap(emailChannelId, "anywhere.com")).toBe(DEFAULT_EMAIL_CAP_BYTES);
  });

  it("writes a mutation receipt on successful update (audit trail required)", async () => {
    const { getDb } = await import("../../store/db.js");
    const db = getDb();
    // Run inside a trace context so writeMutationReceipt actually fires (it no-ops outside any trace).
    await withTrace("test-trace-cap-update", "manual", async () => {
      // Clean any prior receipts for this channel to make the assertion unambiguous
      db.prepare("DELETE FROM effect_receipts WHERE entity_id = ?").run(emailChannelId);
      await updateTool({ channelId: emailChannelId, defaultBytes: 36_700_160 });
    });
    const rows = db
      .prepare(
        "SELECT verb, entity_type, entity_id, field_changes_json, actor_json FROM effect_receipts WHERE entity_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .all(emailChannelId) as Array<{ verb: string; entity_type: string; entity_id: string; field_changes_json: string; actor_json: string }>;
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.verb).toBe("update");
    expect(r.entity_type).toBe("channel");
    expect(r.entity_id).toBe(emailChannelId);
    // toolName is recorded inside actor_json (per audit/mutation-receipt-writer.ts shape)
    const actor = JSON.parse(r.actor_json) as { toolName?: string };
    expect(actor.toolName).toBe("update_channel_recipient_caps");
    const fieldChanges = JSON.parse(r.field_changes_json) as Array<{ path: string; op: string; after: unknown }>;
    expect(fieldChanges.some((c) => c.path === "defaultRecipientCapBytes" && c.after === 36_700_160)).toBe(true);
  });
});
