import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const mockOn = vi.fn();
const mockLogin = vi.fn().mockResolvedValue("token");
const mockDestroy = vi.fn().mockResolvedValue(undefined);
const mockChannelsFetch = vi.fn();

vi.mock("discord.js", () => ({
  Client: vi.fn(function () {
    return {
      on: mockOn,
      login: mockLogin,
      destroy: mockDestroy,
      channels: { fetch: mockChannelsFetch },
    };
  }),
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
  },
}));

import { DiscordAdapter } from "../../../channels/adapters/discord.js";

describe("DiscordAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogin.mockResolvedValue("token");
    mockDestroy.mockResolvedValue(undefined);
  });

  it("creates with correct platform and id", () => {
    const adapter = new DiscordAdapter("dc1", { botToken: "test-token" });
    expect(adapter.platform).toBe("discord");
    expect(adapter.id).toBe("dc1");
    expect(adapter.getStatus()).toBe("disconnected");
  });

  it("throws on empty botToken", () => {
    expect(() => new DiscordAdapter("dc1", { botToken: "" })).toThrow("requires botToken");
  });

  it("connects and logs in", async () => {
    const adapter = new DiscordAdapter("dc1", { botToken: "test-token" });
    await adapter.connect();
    expect(adapter.getStatus()).toBe("connected");
    expect(mockLogin).toHaveBeenCalledWith("test-token");
  });

  it("sets status to error on connect failure", async () => {
    mockLogin.mockRejectedValueOnce(new Error("invalid token"));
    const adapter = new DiscordAdapter("dc1", { botToken: "bad-token" });
    await expect(adapter.connect()).rejects.toThrow("invalid token");
    expect(adapter.getStatus()).toBe("error");
  });

  it("disconnects", async () => {
    const adapter = new DiscordAdapter("dc1", { botToken: "test-token" });
    await adapter.connect();
    await adapter.disconnect();
    expect(adapter.getStatus()).toBe("disconnected");
    expect(mockDestroy).toHaveBeenCalled();
  });

  it("disconnect without connect is safe", async () => {
    const adapter = new DiscordAdapter("dc1", { botToken: "test-token" });
    await adapter.disconnect();
    expect(adapter.getStatus()).toBe("disconnected");
  });

  it("sends message to channel", async () => {
    const mockSend = vi.fn().mockResolvedValue({ id: "msg-1" });
    mockChannelsFetch.mockResolvedValue({ send: mockSend });

    const adapter = new DiscordAdapter("dc1", { botToken: "test-token" });
    await adapter.connect();
    const id = await adapter.sendMessage("ch-1", { content: "Hello Discord" });
    expect(id).toBe("msg-1");
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ content: "Hello Discord" }));
  });

  it("sends message with replyToMessageId", async () => {
    const mockSend = vi.fn().mockResolvedValue({ id: "msg-2" });
    mockChannelsFetch.mockResolvedValue({ send: mockSend });

    const adapter = new DiscordAdapter("dc1", { botToken: "test-token" });
    await adapter.connect();
    await adapter.sendMessage("ch-1", { content: "Reply", replyToMessageId: "orig-1" });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      content: "Reply",
      reply: expect.anything(),
    }));
  });

  it("throws on sendMessage when not connected", async () => {
    const adapter = new DiscordAdapter("dc1", { botToken: "test-token" });
    await expect(adapter.sendMessage("ch-1", { content: "test" })).rejects.toThrow("not connected");
  });

  it("throws on sendMessage when channel not found", async () => {
    mockChannelsFetch.mockResolvedValue(null);
    const adapter = new DiscordAdapter("dc1", { botToken: "test-token" });
    await adapter.connect();
    await expect(adapter.sendMessage("bad-ch", { content: "test" })).rejects.toThrow("not found");
  });

  it("registers message handler", () => {
    const adapter = new DiscordAdapter("dc1", { botToken: "test-token" });
    adapter.onMessage(vi.fn());
  });

  describe("inbound message processing", () => {
    it("routes guild messages with isGroup=true", async () => {
      const handler = vi.fn();
      const adapter = new DiscordAdapter("dc1", { botToken: "test-token" });
      adapter.onMessage(handler);
      await adapter.connect();

      // Extract the messageCreate handler registered via client.on
      const messageCreateCall = mockOn.mock.calls.find((c) => c[0] === "messageCreate");
      expect(messageCreateCall).toBeDefined();
      const onMessageCreate = messageCreateCall![1] as (msg: unknown) => void;

      // Simulate a guild message
      onMessageCreate({
        author: { id: "user-1", bot: false, displayName: "Alice", username: "alice" },
        channelId: "text-ch-1",
        guildId: "guild-1",
        content: "Hello from guild",
        createdTimestamp: 1700000000000,
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        channelId: "dc1",
        platform: "discord",
        chatId: "text-ch-1",
        senderId: "user-1",
        senderName: "Alice",
        content: "Hello from guild",
        isGroup: true,
      }));
    });

    it("routes DM messages with isGroup=false", async () => {
      const handler = vi.fn();
      const adapter = new DiscordAdapter("dc1", { botToken: "test-token" });
      adapter.onMessage(handler);
      await adapter.connect();

      const onMessageCreate = mockOn.mock.calls.find((c) => c[0] === "messageCreate")![1] as (msg: unknown) => void;

      // DM: no guildId
      onMessageCreate({
        author: { id: "user-2", bot: false, displayName: "Bob", username: "bob" },
        channelId: "dm-ch-1",
        guildId: null,
        content: "Hello DM",
        createdTimestamp: 1700000000001,
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        chatId: "dm-ch-1",
        senderId: "user-2",
        isGroup: false,
      }));
    });

    it("ignores bot messages", async () => {
      const handler = vi.fn();
      const adapter = new DiscordAdapter("dc1", { botToken: "test-token" });
      adapter.onMessage(handler);
      await adapter.connect();

      const onMessageCreate = mockOn.mock.calls.find((c) => c[0] === "messageCreate")![1] as (msg: unknown) => void;

      onMessageCreate({
        author: { id: "bot-1", bot: true, displayName: "Bot", username: "bot" },
        channelId: "text-ch-1",
        guildId: "guild-1",
        content: "I am a bot",
        createdTimestamp: 1700000000002,
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it("filters by allowedGuildIds when configured", async () => {
      const handler = vi.fn();
      const adapter = new DiscordAdapter("dc1", {
        botToken: "test-token",
        allowedGuildIds: ["guild-allowed"],
      });
      adapter.onMessage(handler);
      await adapter.connect();

      const onMessageCreate = mockOn.mock.calls.find((c) => c[0] === "messageCreate")![1] as (msg: unknown) => void;

      // Message from disallowed guild
      onMessageCreate({
        author: { id: "user-3", bot: false, displayName: "Eve", username: "eve" },
        channelId: "text-ch-2",
        guildId: "guild-blocked",
        content: "Should be filtered",
        createdTimestamp: 1700000000003,
      });
      expect(handler).not.toHaveBeenCalled();

      // Message from allowed guild
      onMessageCreate({
        author: { id: "user-4", bot: false, displayName: "Dan", username: "dan" },
        channelId: "text-ch-3",
        guildId: "guild-allowed",
        content: "Should pass",
        createdTimestamp: 1700000000004,
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ content: "Should pass" }));
    });

    it("allows DMs even when allowedGuildIds is set", async () => {
      const handler = vi.fn();
      const adapter = new DiscordAdapter("dc1", {
        botToken: "test-token",
        allowedGuildIds: ["guild-only"],
      });
      adapter.onMessage(handler);
      await adapter.connect();

      const onMessageCreate = mockOn.mock.calls.find((c) => c[0] === "messageCreate")![1] as (msg: unknown) => void;

      // DM (no guildId) — should pass since allowedGuildIds only filters guild messages
      onMessageCreate({
        author: { id: "user-5", bot: false, displayName: "Frank", username: "frank" },
        channelId: "dm-ch-2",
        guildId: null,
        content: "DM should pass",
        createdTimestamp: 1700000000005,
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("skips message when no handler registered", async () => {
      const adapter = new DiscordAdapter("dc1", { botToken: "test-token" });
      // Do NOT call onMessage
      await adapter.connect();

      const onMessageCreate = mockOn.mock.calls.find((c) => c[0] === "messageCreate")![1] as (msg: unknown) => void;

      // Should not throw
      onMessageCreate({
        author: { id: "user-6", bot: false, displayName: "Grace", username: "grace" },
        channelId: "text-ch-4",
        guildId: "guild-1",
        content: "No handler",
        createdTimestamp: 1700000000006,
      });
    });
  });

  describe("typing indicator", () => {
    it("sends typing to channel", async () => {
      const mockSendTyping = vi.fn().mockResolvedValue(undefined);
      mockChannelsFetch.mockResolvedValue({ sendTyping: mockSendTyping });

      const adapter = new DiscordAdapter("dc1", { botToken: "test-token" });
      await adapter.connect();
      await adapter.sendTypingIndicator("text-ch-1");
      expect(mockSendTyping).toHaveBeenCalled();
    });

    it("typing is safe when not connected", async () => {
      const adapter = new DiscordAdapter("dc1", { botToken: "test-token" });
      // Should not throw
      await adapter.sendTypingIndicator("text-ch-1");
    });

    it("typing is safe when channel has no sendTyping", async () => {
      mockChannelsFetch.mockResolvedValue({}); // no sendTyping method
      const adapter = new DiscordAdapter("dc1", { botToken: "test-token" });
      await adapter.connect();
      // Should not throw
      await adapter.sendTypingIndicator("text-ch-1");
    });
  });
});
