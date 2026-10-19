import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const mockGetUpdates = vi.fn();
const mockSendMessage = vi.fn();
const mockSendTyping = vi.fn();

vi.mock("../../../channels/adapters/wechat/api.js", () => ({
  getUpdates: (...args: unknown[]) => mockGetUpdates(...args),
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  sendTyping: (...args: unknown[]) => mockSendTyping(...args),
  getConfig: vi.fn().mockResolvedValue({ typing_ticket: "test-ticket" }),
}));

vi.mock("../../../channels/adapters/wechat/login-qr.js", () => ({
  startWeixinLoginWithQr: vi.fn(),
  waitForWeixinLogin: vi.fn(),
}));

// Mock fs for sync buf persistence
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { WeChatAdapter } from "../../../channels/adapters/wechat/wechat.js";

describe("WeChatAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates with correct platform and id", () => {
    const adapter = new WeChatAdapter("wc1", { baseUrl: "https://ilink.example.com" });
    expect(adapter.platform).toBe("wechat");
    expect(adapter.id).toBe("wc1");
    expect(adapter.getStatus()).toBe("disconnected");
  });

  it("throws on empty baseUrl", () => {
    expect(() => new WeChatAdapter("wc1", { baseUrl: "" })).toThrow("requires baseUrl");
  });

  it("throws on connect without botToken", async () => {
    const adapter = new WeChatAdapter("wc1", { baseUrl: "https://ilink.example.com" });
    await expect(adapter.connect()).rejects.toThrow("requires botToken");
  });

  it("connects with valid token", async () => {
    // Mock getUpdates to never resolve (long-poll)
    mockGetUpdates.mockReturnValue(new Promise(() => {}));

    const adapter = new WeChatAdapter("wc1", {
      baseUrl: "https://ilink.example.com",
      botToken: "test-token",
      accountId: "test-bot",
    });
    await adapter.connect();
    expect(adapter.getStatus()).toBe("connected");
    await adapter.disconnect();
  });

  it("disconnects and stops long-poll", async () => {
    mockGetUpdates.mockReturnValue(new Promise(() => {}));

    const adapter = new WeChatAdapter("wc1", {
      baseUrl: "https://ilink.example.com",
      botToken: "test-token",
    });
    await adapter.connect();
    await adapter.disconnect();
    expect(adapter.getStatus()).toBe("disconnected");
  });

  it("registers message handler", () => {
    const adapter = new WeChatAdapter("wc1", { baseUrl: "https://ilink.example.com" });
    const handler = vi.fn();
    adapter.onMessage(handler);
  });

  it("sends message via API", async () => {
    mockGetUpdates.mockReturnValue(new Promise(() => {}));
    mockSendMessage.mockResolvedValue(undefined);

    const adapter = new WeChatAdapter("wc1", {
      baseUrl: "https://ilink.example.com",
      botToken: "test-token",
    });
    await adapter.connect();

    // Set up active session so send gate allows the message through
    (adapter as any).sessions.set("user123", { lastUserMessageAt: Date.now(), quotaRemaining: 10 });
    const msgId = await adapter.sendMessage("user123", { content: "Hello" });
    expect(msgId).toBeDefined();
    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: "https://ilink.example.com",
      token: "test-token",
    }));

    await adapter.disconnect();
  });

  it("sends typing indicator", async () => {
    mockGetUpdates.mockReturnValue(new Promise(() => {}));
    mockSendTyping.mockResolvedValue(undefined);

    const adapter = new WeChatAdapter("wc1", {
      baseUrl: "https://ilink.example.com",
      botToken: "test-token",
    });
    await adapter.connect();
    await adapter.sendTypingIndicator?.("user123");
    expect(mockSendTyping).toHaveBeenCalled();
    await adapter.disconnect();
  });

  it("normalizes inbound group message with isGroup=true and chatId=group_id", async () => {
    const handler = vi.fn();
    const adapter = new WeChatAdapter("wc1", {
      baseUrl: "https://ilink.example.com",
      botToken: "test-token",
    });
    adapter.onMessage(handler);
    await (adapter as any).processInbound({
      from_user_id: "sender@im.wechat",
      to_user_id: "bot@im.bot",
      group_id: "group-abc@im.wechat",
      create_time_ms: Date.now(),
      context_token: "ctx-group",
      item_list: [{ type: 1, text_item: { text: "Hello from group" } }],
    });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "wc1",
      platform: "wechat",
      chatId: "group-abc@im.wechat",
      senderId: "sender@im.wechat",
      content: "Hello from group",
      isGroup: true,
    }));

  });

  it("direct message has isGroup=false and chatId=from_user_id", async () => {
    const handler = vi.fn();
    const adapter = new WeChatAdapter("wc1", {
      baseUrl: "https://ilink.example.com",
      botToken: "test-token",
    });
    adapter.onMessage(handler);
    await (adapter as any).processInbound({
      from_user_id: "sender@im.wechat",
      to_user_id: "bot@im.bot",
      create_time_ms: Date.now(),
      context_token: "ctx-direct",
      item_list: [{ type: 1, text_item: { text: "Hello direct" } }],
    });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "sender@im.wechat",
      senderId: "sender@im.wechat",
      isGroup: false,
    }));
  });

  it("normalizes inbound text message to InboundMessage", async () => {
    const handler = vi.fn();

    const adapter = new WeChatAdapter("wc1", {
      baseUrl: "https://ilink.example.com",
      botToken: "test-token",
    });
    adapter.onMessage(handler);
    await (adapter as any).processInbound({
      from_user_id: "sender@im.wechat",
      to_user_id: "bot@im.bot",
      create_time_ms: Date.now(),
      context_token: "ctx-123",
      item_list: [{ type: 1, text_item: { text: "Hello from WeChat" } }],
    });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "wc1",
      platform: "wechat",
      chatId: "sender@im.wechat",
      senderId: "sender@im.wechat",
      content: "Hello from WeChat",
      isGroup: false,
    }));
  });
});
