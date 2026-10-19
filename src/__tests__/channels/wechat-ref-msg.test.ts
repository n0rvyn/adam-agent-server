import { describe, test, expect, vi, beforeEach } from "vitest";
import { WeChatAdapter } from "../../channels/adapters/wechat/wechat.js";
import type { OutboundMessage, InboundMessage } from "../../shared/types.js";
import type { WeixinMessage } from "../../channels/adapters/wechat/types.js";
import { MessageItemType } from "../../channels/adapters/wechat/types.js";

// Mock the API module to capture sendMessage payloads + simulate inbound msgs
vi.mock("../../channels/adapters/wechat/api.js", () => ({
  getUpdates: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendTyping: vi.fn().mockResolvedValue(undefined),
}));

// Mock session-guard so isSessionPaused returns false
vi.mock("../../channels/adapters/wechat/session-guard.js", () => ({
  isSessionPaused: () => false,
  getRemainingPauseMs: () => 0,
  clearSessionPause: vi.fn(),
  pauseSession: vi.fn(),
  SESSION_EXPIRED_ERRCODE: -14,
  SESSION_PAUSE_DURATION_MS: 3_600_000,
}));

import * as wechatApi from "../../channels/adapters/wechat/api.js";

describe("WeChat ref_msg outbound (Phase 3 Task 3)", () => {
  let adapter: WeChatAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new WeChatAdapter("ch-w-test", { baseUrl: "https://fake.example.com", botToken: "tok" } as never);
    // Force session active by injecting state. Use the actual ChatSession interface (wechat.ts:132-136)
    // to guard against future field additions in isSessionActive(). If a new field becomes required,
    // TypeScript fails this `as` cast — forcing the test to update in lockstep with the runtime.
    const session: import("../../channels/adapters/wechat/wechat.js").ChatSession = {
      lastUserMessageAt: Date.now(),
      quotaRemaining: 10,
    };
    (adapter as unknown as { sessions: Map<string, import("../../channels/adapters/wechat/wechat.js").ChatSession> }).sessions.set("user-1", session);
  });

  test("ux-002-wechat-ref-msg-with-replyto: apiSendMessage body includes ref_msg when replyToMessageId is set", async () => {
    const msg: OutboundMessage = {
      content: "Approve git push?",
      replyToMessageId: "wechat-msg-id-12345",
      quoteExcerpt: "merge PR #123 into main",
      quoteTitle: "PR Review Thread",
    };
    await adapter.sendMessage("user-1", msg);
    expect(wechatApi.sendMessage).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(wechatApi.sendMessage).mock.calls[0][0];
    const itemList = callArgs.body.msg?.item_list;
    expect(itemList).toHaveLength(1);
    expect(itemList?.[0].text_item?.text).toBe("Approve git push?");
    expect(itemList?.[0].ref_msg?.message_item?.msg_id).toBe("wechat-msg-id-12345");
    expect(itemList?.[0].ref_msg?.message_item?.text_item?.text).toBe("merge PR #123 into main");
    expect(itemList?.[0].ref_msg?.title).toBe("PR Review Thread");
  });

  test("ref_msg excerpt is truncated to 80 chars", async () => {
    const longExcerpt = "x".repeat(200);
    const msg: OutboundMessage = {
      content: "test",
      replyToMessageId: "msg-id",
      quoteExcerpt: longExcerpt,
    };
    await adapter.sendMessage("user-1", msg);
    const callArgs = vi.mocked(wechatApi.sendMessage).mock.calls[0][0];
    const refExcerpt = callArgs.body.msg?.item_list?.[0].ref_msg?.message_item?.text_item?.text ?? "";
    expect(refExcerpt.length).toBe(80);
  });

  test("apiSendMessage body has NO ref_msg when replyToMessageId is absent", async () => {
    const msg: OutboundMessage = { content: "plain text" };
    await adapter.sendMessage("user-1", msg);
    const callArgs = vi.mocked(wechatApi.sendMessage).mock.calls[0][0];
    expect(callArgs.body.msg?.item_list?.[0].ref_msg).toBeUndefined();
  });

  test("ref_msg works even if quoteExcerpt is omitted (empty excerpt)", async () => {
    const msg: OutboundMessage = {
      content: "Approve?",
      replyToMessageId: "msg-id",
      // quoteExcerpt + quoteTitle omitted
    };
    await adapter.sendMessage("user-1", msg);
    const callArgs = vi.mocked(wechatApi.sendMessage).mock.calls[0][0];
    const refMsg = callArgs.body.msg?.item_list?.[0].ref_msg;
    expect(refMsg).toBeDefined();
    expect(refMsg?.message_item?.msg_id).toBe("msg-id");
    expect(refMsg?.message_item?.text_item?.text).toBe("");  // empty excerpt
    expect(refMsg?.title).toBeUndefined();
  });
});

describe("WeChat ref_msg inbound (Phase 3 Task 4)", () => {
  let adapter: WeChatAdapter;
  let captured: InboundMessage[];

  beforeEach(() => {
    vi.clearAllMocks();
    captured = [];
    adapter = new WeChatAdapter("ch-w-test", { baseUrl: "https://fake.example.com", botToken: "tok" } as never);
    adapter.onMessage((msg) => captured.push(msg));
  });

  test("processInbound extracts ref_msg.message_item.msg_id as quotedPlatformMessageId", async () => {
    const msg: WeixinMessage = {
      from_user_id: "user-1",
      create_time_ms: 1715000000000,
      item_list: [{
        type: MessageItemType.TEXT,
        text_item: { text: "approve" },
        ref_msg: {
          message_item: {
            msg_id: "parent-platform-msg-id-789",
            text_item: { text: "Original prompt text" },
          },
          title: "Approval thread",
        },
      }],
    };
    await (adapter as unknown as { processInbound: (m: WeixinMessage) => Promise<void> }).processInbound(msg);
    expect(captured).toHaveLength(1);
    expect(captured[0].quotedPlatformMessageId).toBe("parent-platform-msg-id-789");
    expect(captured[0].content).toBe("approve");
  });

  test("processInbound: no ref_msg → quotedPlatformMessageId is undefined", async () => {
    const msg: WeixinMessage = {
      from_user_id: "user-1",
      create_time_ms: 1715000000000,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: "hello" } }],
    };
    await (adapter as unknown as { processInbound: (m: WeixinMessage) => Promise<void> }).processInbound(msg);
    expect(captured).toHaveLength(1);
    expect(captured[0].quotedPlatformMessageId).toBeUndefined();
  });

  test("WeChat InboundMessage does NOT dual-write replyToMessageId (D-A3)", async () => {
    const msg: WeixinMessage = {
      from_user_id: "user-1",
      create_time_ms: 1715000000000,
      item_list: [{
        type: MessageItemType.TEXT,
        text_item: { text: "approve" },
        ref_msg: { message_item: { msg_id: "ref-id", text_item: { text: "x" } } },
      }],
    };
    await (adapter as unknown as { processInbound: (m: WeixinMessage) => Promise<void> }).processInbound(msg);
    expect(captured[0].replyToMessageId).toBeUndefined();
    expect(captured[0].quotedPlatformMessageId).toBe("ref-id");
  });

  test("first ref_msg in item_list wins when multiple items have ref_msg", async () => {
    const msg: WeixinMessage = {
      from_user_id: "user-1",
      create_time_ms: 1715000000000,
      item_list: [
        { type: MessageItemType.TEXT, text_item: { text: "a" }, ref_msg: { message_item: { msg_id: "first" } } },
        { type: MessageItemType.TEXT, text_item: { text: "b" }, ref_msg: { message_item: { msg_id: "second" } } },
      ],
    };
    await (adapter as unknown as { processInbound: (m: WeixinMessage) => Promise<void> }).processInbound(msg);
    expect(captured[0].quotedPlatformMessageId).toBe("first");
  });
});
