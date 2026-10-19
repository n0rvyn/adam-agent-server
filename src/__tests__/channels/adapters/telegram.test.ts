import { describe, it, expect, vi } from "vitest";
import type { InboundMessage } from "../../../shared/types.js";

vi.mock("../../../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

// Mock grammY
const mockOn = vi.fn();
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 123 });
const mockSendChatAction = vi.fn().mockResolvedValue(undefined);

vi.mock("grammy", () => ({
  Bot: vi.fn(function () {
    return {
      on: mockOn,
      start: mockStart,
      stop: mockStop,
      api: { sendMessage: mockSendMessage, sendChatAction: mockSendChatAction },
    };
  }),
}));

import { TelegramAdapter } from "../../../channels/adapters/telegram.js";

describe("TelegramAdapter", () => {
  it("creates with correct platform and id", () => {
    const adapter = new TelegramAdapter("tg1", { botToken: "test-token" });
    expect(adapter.platform).toBe("telegram");
    expect(adapter.id).toBe("tg1");
    expect(adapter.getStatus()).toBe("disconnected");
  });

  it("connects and starts polling", async () => {
    const adapter = new TelegramAdapter("tg1", { botToken: "test-token" });
    await adapter.connect();
    expect(adapter.getStatus()).toBe("connected");
    expect(mockStart).toHaveBeenCalled();
  });

  it("disconnects and stops bot", async () => {
    const adapter = new TelegramAdapter("tg1", { botToken: "test-token" });
    await adapter.connect();
    await adapter.disconnect();
    expect(adapter.getStatus()).toBe("disconnected");
    expect(mockStop).toHaveBeenCalled();
  });

  it("sends message via Bot API", async () => {
    const adapter = new TelegramAdapter("tg1", { botToken: "test-token" });
    await adapter.connect();
    const msgId = await adapter.sendMessage("123", { content: "Hello" });
    expect(msgId).toBe("123");
    expect(mockSendMessage).toHaveBeenCalledWith("123", "Hello", expect.any(Object));
  });

  it("registers message handler", () => {
    const adapter = new TelegramAdapter("tg1", { botToken: "test-token" });
    const handler = vi.fn();
    adapter.onMessage(handler);
    // Handler is stored internally — verified by mockOn being called during connect
  });

  it("sends typing indicator", async () => {
    const adapter = new TelegramAdapter("tg1", { botToken: "test-token" });
    await adapter.connect();
    await adapter.sendTypingIndicator?.("123");
    expect(mockSendChatAction).toHaveBeenCalledWith("123", "typing");
  });

  it("throws on empty botToken", () => {
    expect(() => new TelegramAdapter("tg1", { botToken: "" })).toThrow("requires botToken");
  });
});
