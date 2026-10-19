/**
 * Unit tests for the send_to_channel Phase 2 post-hook:
 * After a successful gateway.send(), a chat_sent artifact row is registered
 * asynchronously via setImmediate.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Channel } from "../../shared/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Set ADAM_TEST_DIR so isPathInAdamRuntime resolves test files as in-runtime.
// Must be set before module imports.
// ─────────────────────────────────────────────────────────────────────────────
const TEST_DIR = join(tmpdir(), `adam-send-hook-test-${process.pid}`);
process.env.ADAM_TEST_DIR = TEST_DIR;
mkdirSync(TEST_DIR, { recursive: true });

const sendMock = vi.fn<(...args: unknown[]) => Promise<{ success: boolean; error?: string }>>(
  async () => ({ success: true }),
);
let channels: Channel[] = [];
let activeChatOrigin: { chatSessionId: string; source: Record<string, unknown> } | undefined = {
  chatSessionId: "sess-1",
  source: { type: "tui" },
};

vi.mock("../../store/channels.js", () => ({
  listChannels: () => channels,
}));

vi.mock("../../chat/session-manager.js", () => ({
  listSessions: () => [],
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ send: sendMock, redeliverExecutionTo: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({ defaults: {}, server: { port: 7100 } }),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (config: unknown) => config,
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Test DB — needed by createArtifact / listArtifactsByChatSession
// ─────────────────────────────────────────────────────────────────────────────
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// ─────────────────────────────────────────────────────────────────────────────
// Module imports (after mocks are registered)
// ─────────────────────────────────────────────────────────────────────────────
const { createAdamTools } = await import("../../manager/adam-tools.js");
const { listArtifactsByChatSession } = await import("../../store/artifacts.js");
const { createRole } = await import("../../store/roles.js");

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────
function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "ch-wechat",
    name: "WeChat on iPad",
    platform: "wechat",
    enabled: true,
    status: "connected",
    config: { userId: "user-123", chatId: "chat-abc" },
    createdAt: Date.now(),
    messageCount: 0,
    ...overrides,
  };
}

function getSendTool(runtimeContext: Record<string, unknown> = {}) {
  const server = createAdamTools(runtimeContext) as unknown as {
    tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }>;
  };
  const t = server.tools.find((x) => x.name === "send_to_channel");
  if (!t) throw new Error("send_to_channel tool not found");
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────
describe("send_to_channel post-hook (Phase 2)", () => {
  let testFile: string;

  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ success: true });
    channels = [makeChannel()];
    activeChatOrigin = { chatSessionId: "sess-1", source: { type: "tui" } };

    // Clear all data between tests so artifact counts start from 0
    clearTestDb();

    // Seed required FK rows: role + chat session (raw INSERT to satisfy NOT NULL constraints)
    const db = getTestDb();
    db.prepare(
      "INSERT OR IGNORE INTO roles (id, name, cag_prompt, memory_stream_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("role-chat-manager", "chat-manager", "", "msid-chat-mgr", "active", Date.now());
    db.prepare(
      "INSERT OR IGNORE INTO chat_sessions (id, source_type, status, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)",
    ).run("sess-1", "tui", "active", Date.now(), Date.now());

    // Write a test media file inside ADAM_TEST_DIR (isPathInAdamRuntime → true)
    testFile = join(TEST_DIR, `test-${Date.now()}.png`);
    writeFileSync(testFile, "fake-png-content");
  });

  afterAll(() => cleanup());

  // ── Test A: happy path ────────────────────────────────────────────────────
  it("A: registers chat_sent artifact after successful send", async () => {
    const tool = getSendTool({ getActiveChatOrigin: () => activeChatOrigin });

    const result = await tool.handler({
      channelName: "WeChat on iPad",
      message: "here is the file",
      mediaUrl: testFile,
      mediaType: "image",
    });

    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.success).toBe(true);

    // Sync return — post-hook not yet fired
    expect(listArtifactsByChatSession("sess-1").length).toBe(0);

    // Let setImmediate run
    await new Promise<void>((r) => setImmediate(r));

    const artifacts = listArtifactsByChatSession("sess-1");
    expect(artifacts.length).toBe(1);
    expect(artifacts[0].sourceKind).toBe("chat_sent");
    expect(artifacts[0].originalFilename).toBe(testFile.split("/").at(-1));
    expect(artifacts[0].roleId).toBe("role-chat-manager");
  });

  // ── Test B: remote URL rejected synchronously, no post-hook ──────────────
  it("B: rejects remote URL synchronously, no artifact registered", async () => {
    const tool = getSendTool({ getActiveChatOrigin: () => activeChatOrigin });

    const result = await tool.handler({
      channelName: "WeChat on iPad",
      message: "remote",
      mediaUrl: "https://example.com/photo.png",
      mediaType: "image",
    });

    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.error).toContain("local file path");

    await new Promise<void>((r) => setImmediate(r));
    expect(listArtifactsByChatSession("sess-1").length).toBe(0);
  });

  // ── Test C: getActiveChatOrigin returns undefined → publisher skips ───────
  it("C: skips artifact when getActiveChatOrigin returns undefined", async () => {
    const tool = getSendTool({ getActiveChatOrigin: () => undefined });

    await tool.handler({
      channelName: "WeChat on iPad",
      message: "msg",
      mediaUrl: testFile,
      mediaType: "image",
    });

    await new Promise<void>((r) => setImmediate(r));
    // chatSessionId is undefined → publisher logs warn and skips INSERT
    expect(listArtifactsByChatSession("sess-1").length).toBe(0);
  });

  // ── Test D: gateway.send returns failure → no post-hook ──────────────────
  it("D: does not register artifact when gateway.send fails", async () => {
    sendMock.mockResolvedValue({ success: false, error: "channel error" });
    const tool = getSendTool({ getActiveChatOrigin: () => activeChatOrigin });

    await tool.handler({
      channelName: "WeChat on iPad",
      message: "msg",
      mediaUrl: testFile,
      mediaType: "image",
    });

    await new Promise<void>((r) => setImmediate(r));
    expect(listArtifactsByChatSession("sess-1").length).toBe(0);
  });

  // ── Test E: no mediaUrl → no post-hook ───────────────────────────────────
  it("E: does not register artifact when no mediaUrl (text-only message)", async () => {
    const tool = getSendTool({ getActiveChatOrigin: () => activeChatOrigin });

    await tool.handler({
      channelName: "WeChat on iPad",
      message: "plain text",
    });

    await new Promise<void>((r) => setImmediate(r));
    expect(listArtifactsByChatSession("sess-1").length).toBe(0);
  });

  // ── Test F: fire-and-forget timing ───────────────────────────────────────
  it("F: tool returns synchronously before post-hook writes to DB", async () => {
    const tool = getSendTool({ getActiveChatOrigin: () => activeChatOrigin });

    // Trigger handler
    const resultPromise = tool.handler({
      channelName: "WeChat on iPad",
      message: "file msg",
      mediaUrl: testFile,
      mediaType: "image",
    });

    // Await the handler result (async handler, but setImmediate fires after await returns)
    await resultPromise;

    // At this point setImmediate callback has not yet run
    expect(listArtifactsByChatSession("sess-1").length).toBe(0);

    // Allow the event loop to process the setImmediate
    await new Promise<void>((r) => setImmediate(r));

    // Now the post-hook has run
    expect(listArtifactsByChatSession("sess-1").length).toBe(1);
  });
});
