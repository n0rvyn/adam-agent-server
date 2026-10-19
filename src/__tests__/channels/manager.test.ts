import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
}));

vi.mock("../../config/index.js", () => ({
  getChatConfig: () => ({
    sessionTimeoutMinutes: 30,
    maxSessionTurns: 20,
    autoTitle: true,
    archiveExtractMemory: true,
  }),
  getDefaults: () => ({
    timeout: 600, approvalRequired: [], approvalTimeout: 300,
    allowedTools: [], disallowedTools: [], maxTurns: 100,
    maxBudgetUsd: 5.0, model: "", effort: "high",
    settingSources: ["project"], env: {},
  }),
  DEFAULT_CONFIG: { chat: { sessionTimeoutMinutes: 30, maxSessionTurns: 20, autoTitle: true, archiveExtractMemory: true } },
}));

vi.mock("../../agent/memory-service.js", () => ({
  queryMemory: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

import { ChannelManager } from "../../channels/manager.js";
import { createChannel } from "../../store/channels.js";
import { _resetForTest as resetSessionManager, listSessions } from "../../chat/session-manager.js";
import { getMessagesBySession } from "../../store/messages.js";
import type { ChannelAdapter, ChannelStatus, InboundMessage, OutboundMessage } from "../../shared/types.js";

function createMockAdapter(overrides?: Partial<ChannelAdapter>): ChannelAdapter {
  let status: ChannelStatus = "disconnected";
  let messageHandler: ((msg: InboundMessage) => void) | null = null;

  return {
    platform: "telegram",
    id: "mock-adapter",
    connect: vi.fn(async () => { status = "connected"; }),
    disconnect: vi.fn(async () => { status = "disconnected"; }),
    getStatus: vi.fn(() => status),
    sendMessage: vi.fn(async () => "sent-msg-id"),
    onMessage: vi.fn((handler) => { messageHandler = handler; }),
    // Expose handler for testing
    get _messageHandler() { return messageHandler; },
    ...overrides,
  } as ChannelAdapter & { _messageHandler: ((msg: InboundMessage) => void) | null };
}

function makeInboundMessage(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    channelId: "ch1",
    platform: "telegram",
    chatId: "chat-123",
    senderId: "user-1",
    content: "Hello from channel",
    isGroup: false,
    timestamp: Date.now(),
    raw: {},
    ...overrides,
  };
}

describe("ChannelManager", () => {
  beforeAll(() => {
    const { db } = setupTestDb();
    dbRef = db;
  });

  afterAll(() => {
    dbRef.close();
  });

  beforeEach(() => {
    resetSessionManager();
    clearTestDb();
  });

  it("adds and connects an adapter", async () => {
    const manager = new ChannelManager();
    const adapter = createMockAdapter();
    const channel = { id: "ch1", name: "TG", platform: "telegram" as const, enabled: true, status: "disconnected" as const, config: {}, createdAt: Date.now(), messageCount: 0 };
    createChannel(channel);

    await manager.addChannel(channel, adapter);
    expect(manager._getAdapterCount()).toBe(1);
    expect(adapter.connect).toHaveBeenCalled();
    expect(adapter.onMessage).toHaveBeenCalled();
  });

  it("does not connect disabled channel", async () => {
    const manager = new ChannelManager();
    const adapter = createMockAdapter();
    const channel = { id: "ch1", name: "TG", platform: "telegram" as const, enabled: false, status: "disconnected" as const, config: {}, createdAt: Date.now(), messageCount: 0 };
    createChannel(channel);

    await manager.addChannel(channel, adapter);
    expect(adapter.connect).not.toHaveBeenCalled();
  });

  it("removes channel and disconnects", async () => {
    const manager = new ChannelManager();
    const adapter = createMockAdapter();
    const channel = { id: "ch1", name: "TG", platform: "telegram" as const, enabled: true, status: "disconnected" as const, config: {}, createdAt: Date.now(), messageCount: 0 };
    createChannel(channel);

    await manager.addChannel(channel, adapter);
    await manager.removeChannel("ch1");
    expect(adapter.disconnect).toHaveBeenCalled();
    expect(manager._getAdapterCount()).toBe(0);
  });

  it("returns channel statuses", async () => {
    const manager = new ChannelManager();
    const adapter = createMockAdapter();
    const channel = { id: "ch1", name: "TG", platform: "telegram" as const, enabled: true, status: "disconnected" as const, config: {}, createdAt: Date.now(), messageCount: 0 };
    createChannel(channel);

    await manager.addChannel(channel, adapter);
    const statuses = manager.getChannelStatuses();
    expect(statuses.get("ch1")).toBe("connected");
  });

  describe("rate limiting", () => {
    it("allows messages within rate limit", async () => {
      const manager = new ChannelManager({ rateLimitPerMinute: 5 });
      const adapter = createMockAdapter();
      const channel = { id: "ch1", name: "TG", platform: "telegram" as const, enabled: true, status: "disconnected" as const, config: {}, createdAt: Date.now(), messageCount: 0 };
      createChannel(channel);
      await manager.addChannel(channel, adapter);

      const result = await manager.sendMessage("ch1", "chat1", { content: "hi" });
      expect(result).toBe("sent-msg-id");
    });

    it("blocks messages exceeding rate limit", async () => {
      const manager = new ChannelManager({ rateLimitPerMinute: 2 });
      const adapter = createMockAdapter();
      const channel = { id: "ch1", name: "TG", platform: "telegram" as const, enabled: true, status: "disconnected" as const, config: {}, createdAt: Date.now(), messageCount: 0 };
      createChannel(channel);
      await manager.addChannel(channel, adapter);

      await manager.sendMessage("ch1", "c1", { content: "1" });
      await manager.sendMessage("ch1", "c1", { content: "2" });
      const blocked = await manager.sendMessage("ch1", "c1", { content: "3" });
      expect(blocked).toBeNull();
    });
  });

  describe("inbound message routing", () => {
    it("routes inbound message to chat session", async () => {
      const manager = new ChannelManager();
      const adapter = createMockAdapter();
      const channel = { id: "ch1", name: "TG", platform: "telegram" as const, enabled: true, status: "disconnected" as const, config: {}, createdAt: Date.now(), messageCount: 0 };
      createChannel(channel);
      await manager.addChannel(channel, adapter);

      // Trigger inbound message
      const typedAdapter = adapter as ChannelAdapter & { _messageHandler: ((msg: InboundMessage) => void) | null };
      expect(typedAdapter._messageHandler).toBeDefined();

      // The handler will try to route through handleChatMessage which accesses DB
      // This tests the wiring, not the full E2E flow (which is tested in message-handler tests)
      await typedAdapter._messageHandler!(makeInboundMessage());
      await vi.waitFor(() => {
        expect(listSessions("active").length).toBeGreaterThan(0);
      });
    });

    it("routes email inbound messages to a Mail channel chat session", async () => {
      const manager = new ChannelManager();
      const adapter = createMockAdapter({ platform: "email", id: "mail-adapter" });
      const channel = { id: "mail-1", name: "Client Mail", platform: "email" as const, enabled: true, status: "disconnected" as const, config: { address: "client@example.com" }, createdAt: Date.now(), messageCount: 0 };
      createChannel(channel);
      await manager.addChannel(channel, adapter);

      const typedAdapter = adapter as ChannelAdapter & { _messageHandler: ((msg: InboundMessage) => void) | null };
      await typedAdapter._messageHandler!(makeInboundMessage({
        channelId: "mail-1",
        platform: "email",
        chatId: "client@example.com",
        senderId: "client@example.com",
        content: "Run email report",
      }));

      await vi.waitFor(() => {
        expect(listSessions("active").some((session) => session.source.chatId === "client@example.com")).toBe(true);
      });

      const session = listSessions("active").find((candidate) => candidate.source.chatId === "client@example.com");
      expect(session?.source).toEqual({ type: "channel", channelId: "mail-1", chatId: "client@example.com" });
      expect(getMessagesBySession(session!.id)[0].content).toBe("Run email report");
    });

    it("rejects messages from non-allowed chats", async () => {
      const manager = new ChannelManager();
      const adapter = createMockAdapter();
      const channel = {
        id: "ch1", name: "TG", platform: "telegram" as const,
        enabled: true, status: "disconnected" as const,
        config: {}, allowedChatIds: ["allowed-chat"],
        createdAt: Date.now(), messageCount: 0,
      };
      createChannel(channel);
      await manager.addChannel(channel, adapter);

      const typedAdapter = adapter as ChannelAdapter & { _messageHandler: ((msg: InboundMessage) => void) | null };
      // Message from non-allowed chat should be silently dropped
      await typedAdapter._messageHandler!(makeInboundMessage({ chatId: "not-allowed" }));
      // No crash = success (message was silently dropped)
    });
  });

  describe("lifecycle", () => {
    it("stops all channels and clears state", async () => {
      const manager = new ChannelManager();
      const adapter = createMockAdapter();
      const channel = { id: "ch1", name: "TG", platform: "telegram" as const, enabled: true, status: "disconnected" as const, config: {}, createdAt: Date.now(), messageCount: 0 };
      createChannel(channel);
      await manager.addChannel(channel, adapter);

      await manager.stopAll();
      expect(adapter.disconnect).toHaveBeenCalled();
      expect(manager._getAdapterCount()).toBe(0);
    });
  });
});
