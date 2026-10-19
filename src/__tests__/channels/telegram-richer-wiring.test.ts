import { describe, test, expect, vi, beforeEach } from "vitest";
import { TelegramAdapter } from "../../channels/adapters/telegram.js";
import type { OutboundMessage, InboundMessage } from "../../shared/types.js";

// Mock grammy Bot — use a shared object so both vi.mock factory and test code can reference it
const handleInboundForApprovalMock = vi.fn().mockResolvedValue(true);
vi.mock("../../channels/approval-handler.js", () => ({
  handleInboundForApproval: handleInboundForApprovalMock,
}));

vi.mock("grammy", () => {
  const onHandlers = new Map<string, (ctx: unknown) => void | Promise<void>>();
  const mockBotApi = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 999 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
  };
  const mockBot = {
    api: mockBotApi,
    on: (event: string, handler: (ctx: unknown) => void | Promise<void>) => {
      onHandlers.set(event, handler);
    },
    start: vi.fn().mockImplementation(async (opts: { onStart?: () => void }) => {
      opts?.onStart?.();
    }),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  // Use a real function (not arrow) so `new Bot(...)` works
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  function Bot(_token: string) { return mockBot; }
  return {
    Bot,
    __testOnHandlers: onHandlers,
    __testMockBotApi: mockBotApi,
  };
});

import * as grammyExports from "grammy";
const { __testOnHandlers, __testMockBotApi } = grammyExports as unknown as {
  __testOnHandlers: Map<string, (ctx: unknown) => void | Promise<void>>;
  __testMockBotApi: {
    sendMessage: ReturnType<typeof vi.fn>;
    editMessageText: ReturnType<typeof vi.fn>;
    sendChatAction: ReturnType<typeof vi.fn>;
  };
};

describe("Telegram outbound — inline_keyboard + editMessage (Task 5)", () => {
  let adapter: TelegramAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    __testOnHandlers.clear();
    adapter = new TelegramAdapter("ch-tg", { botToken: "fake-token" });
    await adapter.connect();
  });

  test("sendMessage passes inline_keyboard to grammy when replyMarkup.inlineKeyboard is set", async () => {
    const msg: OutboundMessage = {
      content: "Approve?",
      replyMarkup: {
        inlineKeyboard: [
          [{ text: "Yes", callbackData: "v1:A2K7" }, { text: "No", callbackData: "v1:B3J9" }],
        ],
      },
    };
    await adapter.sendMessage("123456", msg);
    expect(__testMockBotApi.sendMessage).toHaveBeenCalledWith(
      "123456",
      "Approve?",
      expect.objectContaining({
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Yes", callback_data: "v1:A2K7" },
              { text: "No", callback_data: "v1:B3J9" },
            ],
          ],
        },
      }),
    );
  });

  test("sendMessage omits reply_markup when replyMarkup is absent (regression)", async () => {
    const msg: OutboundMessage = { content: "plain" };
    await adapter.sendMessage("123456", msg);
    const callOpts = __testMockBotApi.sendMessage.mock.calls[0][2];
    expect(callOpts.reply_markup).toBeUndefined();
  });

  test("editMessage calls bot.api.editMessageText with parsed messageId", async () => {
    await adapter.editMessage("123456", "789", "edited text");
    expect(__testMockBotApi.editMessageText).toHaveBeenCalledWith("123456", 789, "edited text");
  });
});

describe("Telegram inbound — reply_to_message + callback_query routing (Task 6)", () => {
  let adapter: TelegramAdapter;
  let captured: InboundMessage[];

  beforeEach(async () => {
    vi.clearAllMocks();
    __testOnHandlers.clear();
    captured = [];
    adapter = new TelegramAdapter("ch-tg", { botToken: "fake-token" });
    // Register listener BEFORE connect() — bot.on() captures this.messageHandler at registration time
    adapter.onMessage((msg) => captured.push(msg));
    await adapter.connect();
  });

  test("message:text inbound extracts reply_to_message.message_id as quotedPlatformMessageId", async () => {
    const handler = __testOnHandlers.get("message:text");
    expect(handler).toBeDefined();
    await handler!({
      message: { text: "yes please", date: 1715000000, reply_to_message: { message_id: 42 } },
      chat: { id: 123, type: "private" },
      from: { id: 456, first_name: "User" },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].quotedPlatformMessageId).toBe("42");
    expect(captured[0].replyToMessageId).toBeUndefined();  // D-A3 single-write
    expect(captured[0].content).toBe("yes please");
  });

  test("message:text inbound without reply_to_message: quotedPlatformMessageId undefined", async () => {
    const handler = __testOnHandlers.get("message:text");
    await handler!({
      message: { text: "hi", date: 1715000000 },
      chat: { id: 123, type: "private" },
      from: { id: 456, first_name: "User" },
    });
    expect(captured[0].quotedPlatformMessageId).toBeUndefined();
  });

  test("callback_query:data with v1: prefix → buttonPayload, NOT approval-handler", async () => {
    const handler = __testOnHandlers.get("callback_query:data");
    expect(handler).toBeDefined();
    const ctx = {
      callbackQuery: { data: "v1:A2K7" },
      chat: { id: 123, type: "private" },
      from: { id: 456, first_name: "User" },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    };
    await handler!(ctx);
    expect(captured).toHaveLength(1);
    expect(captured[0].buttonPayload).toEqual({ promptId: "A2K7", rawValue: "v1:A2K7" });
    expect(handleInboundForApprovalMock).not.toHaveBeenCalled();
  });

  test("callback_query:data with legacy 'yes <shortId>' → approval-handler, NOT buttonPayload", async () => {
    const handler = __testOnHandlers.get("callback_query:data");
    const ctx = {
      callbackQuery: { data: "yes abc12345" },
      chat: { id: 123, type: "private" },
      from: { id: 456, first_name: "User" },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    };
    await handler!(ctx);
    expect(captured).toHaveLength(0);  // no InboundMessage created
    expect(handleInboundForApprovalMock).toHaveBeenCalledWith("ch-tg", "123", "", "yes abc12345");
  });

  test("callback_query:data with v1: but length != 7 is ignored (Task 6 strict length check)", async () => {
    const handler = __testOnHandlers.get("callback_query:data");
    // Too short: "v1:XX" = 5 chars
    await handler!({
      callbackQuery: { data: "v1:XX" },
      chat: { id: 123, type: "private" },
      from: { id: 456, first_name: "User" },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    });
    expect(captured).toHaveLength(0);
    expect(handleInboundForApprovalMock).not.toHaveBeenCalled();
    // Too long: "v1:A2K7extra" = 12 chars (silent-truncation regression check)
    await handler!({
      callbackQuery: { data: "v1:A2K7extra" },
      chat: { id: 123, type: "private" },
      from: { id: 456, first_name: "User" },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    });
    expect(captured).toHaveLength(0);
    expect(handleInboundForApprovalMock).not.toHaveBeenCalled();
  });
});

describe("ChannelManager.editMessage routing — Telegram path (Task 9)", () => {
  test("calls Telegram adapter editMessage when canEdit=true", async () => {
    const { ChannelManager } = await import("../../channels/manager.js");
    const adapter = new TelegramAdapter("ch-tg", { botToken: "fake" });
    await adapter.connect();
    const mgr = new ChannelManager();
    // bypass addChannel's DB requirement by directly setting adapters map
    (mgr as unknown as { adapters: Map<string, unknown> }).adapters.set("ch-tg", adapter);
    await mgr.editMessage("ch-tg", "123", "789", "new content");
    expect(__testMockBotApi.editMessageText).toHaveBeenCalledWith("123", 789, "new content");
  });
});
