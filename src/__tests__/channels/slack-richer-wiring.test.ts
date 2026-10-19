import { describe, test, expect, vi, beforeEach } from "vitest";
import { SlackAdapter } from "../../channels/adapters/slack.js";
import { WeChatAdapter } from "../../channels/adapters/wechat/wechat.js";
import type { OutboundMessage, InboundMessage } from "../../shared/types.js";

vi.mock("@slack/bolt", () => {
  const messageHandlers: Array<(args: { message: unknown; say: unknown }) => Promise<void>> = [];
  const actionHandlers: Array<{ pattern: RegExp; handler: (args: unknown) => Promise<void> }> = [];
  const mockClientChat = {
    postMessage: vi.fn().mockResolvedValue({ ts: "1715000000.000100" }),
    update: vi.fn().mockResolvedValue(undefined),
  };
  const mockApp = {
    client: { chat: mockClientChat },
    message: (handler: (args: { message: unknown; say: unknown }) => Promise<void>) => {
      messageHandlers.push(handler);
    },
    action: (pattern: RegExp, handler: (args: unknown) => Promise<void>) => {
      actionHandlers.push({ pattern, handler });
    },
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  // Use a real function (not arrow) so `new App(...)` works
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  function App(_config: unknown) { return mockApp; }
  return { App, __testMessageHandlers: messageHandlers, __testActionHandlers: actionHandlers, __testMockClientChat: mockClientChat };
});

import * as boltExports from "@slack/bolt";
const { __testMessageHandlers, __testActionHandlers, __testMockClientChat } = boltExports as unknown as {
  __testMessageHandlers: Array<(args: { message: unknown; say: unknown }) => Promise<void>>;
  __testActionHandlers: Array<{ pattern: RegExp; handler: (args: unknown) => Promise<void> }>;
  __testMockClientChat: {
    postMessage: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

const handleInboundForApprovalMock = vi.fn().mockResolvedValue(true);
vi.mock("../../channels/approval-handler.js", () => ({
  handleInboundForApproval: handleInboundForApprovalMock,
}));

describe("Slack outbound — chat.update + Block Kit blocks (Task 7)", () => {
  let adapter: SlackAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    __testMessageHandlers.length = 0;
    __testActionHandlers.length = 0;
    adapter = new SlackAdapter("ch-sl", { botToken: "x", signingSecret: "y" });
    await adapter.connect();
  });

  test("sendMessage passes blocks when replyMarkup.blocks is set", async () => {
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Approve?" } },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Yes" }, action_id: "yes-btn", value: "v1:A2K7" }] },
    ];
    const msg: OutboundMessage = {
      content: "fallback text",
      replyMarkup: { blocks } as unknown as OutboundMessage["replyMarkup"],
    };
    await adapter.sendMessage("C12345", msg);
    expect(__testMockClientChat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C12345",
      text: "fallback text",
      blocks,
    }));
  });

  test("sendMessage uses thread_ts when replyToMessageId is set", async () => {
    const msg: OutboundMessage = { content: "reply", replyToMessageId: "1715000000.000050" };
    await adapter.sendMessage("C12345", msg);
    expect(__testMockClientChat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      thread_ts: "1715000000.000050",
    }));
  });

  test("editMessage calls chat.update with channel/ts/text", async () => {
    await adapter.editMessage("C12345", "1715000000.000100", "edited");
    expect(__testMockClientChat.update).toHaveBeenCalledWith({ channel: "C12345", ts: "1715000000.000100", text: "edited" });
  });
});

describe("Slack inbound — thread_ts dual-write + action handler (Task 8)", () => {
  let adapter: SlackAdapter;
  let captured: InboundMessage[];

  beforeEach(async () => {
    vi.clearAllMocks();
    __testMessageHandlers.length = 0;
    __testActionHandlers.length = 0;
    captured = [];
    adapter = new SlackAdapter("ch-sl", { botToken: "x", signingSecret: "y" });
    adapter.onMessage((m) => captured.push(m));
    await adapter.connect();
  });

  test("message handler dual-writes replyToMessageId AND quotedPlatformMessageId from thread_ts", async () => {
    const handler = __testMessageHandlers[0];
    expect(handler).toBeDefined();
    await handler({
      message: {
        text: "in thread",
        ts: "1715000001.000200",
        channel: "C12345",
        user: "U987",
        channel_type: "channel",
        thread_ts: "1715000000.000100",
      },
      say: vi.fn(),
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].replyToMessageId).toBe("1715000000.000100");
    expect(captured[0].quotedPlatformMessageId).toBe("1715000000.000100");
  });

  test("message handler without thread_ts: both fields undefined", async () => {
    const handler = __testMessageHandlers[0];
    await handler({
      message: { text: "root", ts: "1715000001.000200", channel: "C12345", user: "U987", channel_type: "channel" },
      say: vi.fn(),
    });
    expect(captured[0].replyToMessageId).toBeUndefined();
    expect(captured[0].quotedPlatformMessageId).toBeUndefined();
  });

  test("action handler v1: prefix → buttonPayload, NOT approval-handler", async () => {
    const entry = __testActionHandlers.find(e => e.pattern.source === ".*");
    expect(entry).toBeDefined();
    await entry!.handler({
      ack: vi.fn().mockResolvedValue(undefined),
      body: { type: "block_actions", channel: { id: "C12345" }, user: { id: "U987" } },
      action: { value: "v1:A2K7", action_id: "approve-btn" },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].buttonPayload).toEqual({ promptId: "A2K7", rawValue: "v1:A2K7" });
    expect(handleInboundForApprovalMock).not.toHaveBeenCalled();
  });

  test("action handler legacy value → approval-handler, NOT buttonPayload", async () => {
    const entry = __testActionHandlers.find(e => e.pattern.source === ".*");
    await entry!.handler({
      ack: vi.fn().mockResolvedValue(undefined),
      body: { type: "block_actions", channel: { id: "C12345" }, user: { id: "U987" } },
      action: { value: "yes abc12345", action_id: "approve-btn" },
    });
    expect(captured).toHaveLength(0);
    expect(handleInboundForApprovalMock).toHaveBeenCalledWith("ch-sl", "C12345", "", "yes abc12345");
  });
});

describe("ChannelManager.editMessage capability check (Task 9)", () => {
  test("Slack canEdit=true: editMessage succeeds", async () => {
    const { ChannelManager } = await import("../../channels/manager.js");
    const adapter = new SlackAdapter("ch-sl", { botToken: "x", signingSecret: "y" });
    await adapter.connect();
    const mgr = new ChannelManager();
    (mgr as unknown as { adapters: Map<string, unknown> }).adapters.set("ch-sl", adapter);
    await mgr.editMessage("ch-sl", "C12345", "1715000000.000100", "new");
    expect(__testMockClientChat.update).toHaveBeenCalled();
  });

  test("WeChat canEdit=false: editMessage throws not-supported", async () => {
    const { ChannelManager } = await import("../../channels/manager.js");
    const adapter = new WeChatAdapter("ch-wc", { baseUrl: "https://fake", botToken: "tok" } as never);
    const mgr = new ChannelManager();
    (mgr as unknown as { adapters: Map<string, unknown> }).adapters.set("ch-wc", adapter);
    await expect(mgr.editMessage("ch-wc", "user-1", "msg-id", "x")).rejects.toThrow(/not supported|canEdit=false/);
  });

  test("non-existent channelId: editMessage throws no-adapter", async () => {
    const { ChannelManager } = await import("../../channels/manager.js");
    const mgr = new ChannelManager();
    await expect(mgr.editMessage("ch-nope", "x", "y", "z")).rejects.toThrow(/No adapter registered/);
  });
});
