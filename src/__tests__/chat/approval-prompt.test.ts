import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { v4 as uuidv4 } from "uuid";
import * as channels from "../../store/channels.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
}));

const mockSend = vi.fn();
vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined),
    send: (...args: unknown[]) => mockSend(...args),
  }),
}));

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

import { createApprovalPrompt } from "../../chat/approval-prompt.js";
import { getSession } from "../../store/sessions.js";
import { getMessage, findEnvelopesByPromptId } from "../../store/messages.js";
import { getPendingPrompt } from "../../store/pending-prompts.js";
import type { ChatSession } from "../../shared/types.js";
import * as sessionManager from "../../store/sessions.js";

function makeSession(id = "s1"): ChatSession {
  const existing = sessionManager.getSession(id);
  if (existing) return existing;
  sessionManager.createSession({
    id,
    status: "active",
    source: { type: "web" },
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    messageCount: 0,
  });
  return sessionManager.getSession(id)!;
}

describe("createApprovalPrompt (Task 9)", () => {
  beforeAll(() => {
    const { db } = setupTestDb();
    dbRef = db;
  });

  afterAll(() => {
    dbRef.close();
  });

  beforeEach(() => {
    clearTestDb();
    mockSend.mockReset().mockResolvedValue({ success: true, messageId: "WC-MSG-1" });
    makeSession("s1");
  });

  it("creates one chat_messages row per target sharing the same prompt_id", async () => {
    const result = await createApprovalPrompt({
      sessionId: "s1",
      content: "请确认操作",
      shape: "yes_no",
      targets: [
        { type: "channel", channelId: "wc", chatId: "chat1" },
        { type: "channel", channelId: "tg", chatId: "tgc1" },
        { type: "session", sessionId: "s1" },
      ],
    });

    expect(result.messageIds).toHaveLength(3);
    expect(result.promptId).toBeDefined();

    const rows = findEnvelopesByPromptId(result.promptId);
    expect(rows).toHaveLength(3);
    const promptIds = rows.map((r) => r.promptId);
    expect(new Set(promptIds).size).toBe(1); // all share same promptId
  });

  it("creates one pending_prompts row linked to the first messageId", async () => {
    const result = await createApprovalPrompt({
      sessionId: "s1",
      content: "请批准",
      shape: "yes_no",
      targets: [
        { type: "channel", channelId: "wc", chatId: "chat1" },
        { type: "session", sessionId: "s1" },
      ],
    });

    const prompt = getPendingPrompt(result.promptId);
    expect(prompt).toBeDefined();
    expect(prompt!.id).toBe(result.promptId);
    expect(prompt!.sessionId).toBe("s1");
    expect(prompt!.shape).toBe("yes_no");
    expect(prompt!.messageId).toBe(result.messageIds[0]); // first row
    expect(prompt!.resolvedAt).toBeUndefined();
    expect(prompt!.expiredReason).toBeUndefined();
  });

  it("persists platform_message_id for channel targets after gateway.send succeeds", async () => {
    mockSend.mockResolvedValueOnce({ success: true, messageId: "WC-REAL-123" });

    const result = await createApprovalPrompt({
      sessionId: "s1",
      content: "确认?",
      shape: "yes_no",
      targets: [{ type: "channel", channelId: "wc", chatId: "chat1" }],
    });

    const msg = getMessage(result.messageIds[0]);
    expect(msg?.platformMessageId).toBe("WC-REAL-123");
  });

  it("does not persist platform_message_id when gateway returns queued- prefix", async () => {
    mockSend.mockResolvedValueOnce({ success: true, messageId: "queued-ABC123" });

    const result = await createApprovalPrompt({
      sessionId: "s1",
      content: "confirm?",
      shape: "yes_no",
      targets: [{ type: "channel", channelId: "wc", chatId: "chat1" }],
    });

    const msg = getMessage(result.messageIds[0]);
    expect(msg?.platformMessageId).toBeUndefined();
  });

  it("gateway.send failure does not throw and does not update platform_message_id", async () => {
    mockSend.mockRejectedValueOnce(new Error("network error"));

    const result = await createApprovalPrompt({
      sessionId: "s1",
      content: "please confirm",
      shape: "yes_no",
      targets: [{ type: "channel", channelId: "wc", chatId: "chat1" }],
    });

    // Function should not throw
    expect(result).toBeDefined();
    const msg = getMessage(result.messageIds[0]);
    expect(msg?.platformMessageId).toBeUndefined();
  });

  it("sets parentMessageId on chat_messages rows when provided", async () => {
    makeSession("s2");
    const result = await createApprovalPrompt({
      sessionId: "s2",
      content: "follow-up",
      shape: "yes_no",
      parentMessageId: "parent-msg-xyz",
      targets: [{ type: "session", sessionId: "s2" }],
    });

    const msg = getMessage(result.messageIds[0]);
    expect(msg?.parentMessageId).toBe("parent-msg-xyz");
  });

  it("sets taskId on chat_messages rows and pending_prompts when provided", async () => {
    const result = await createApprovalPrompt({
      sessionId: "s1",
      taskId: "task-abc123",
      content: "task approval",
      shape: "yes_no",
      targets: [{ type: "session", sessionId: "s1" }],
    });

    const msg = getMessage(result.messageIds[0]);
    expect(msg?.taskId).toBe("task-abc123");

    const prompt = getPendingPrompt(result.promptId);
    expect(prompt?.taskId).toBe("task-abc123");
  });

  it("appends '(回 #XXXX 表态)' to wechat outbound content (D-S05)", async () => {
    // Seed a wechat channel row
    const db = getTestDb();
    db.prepare(`
      INSERT INTO channels (id, name, platform, enabled, status, config,
        linked_role_id, allowed_chat_ids, created_at, updated_at, last_message_at, message_count)
      VALUES ('wc-wechat-1', 'WeChat Bot', 'wechat', 1, 'connected', '{}',
        NULL, NULL, 1000, NULL, NULL, 0)
    `).run();

    mockSend.mockResolvedValueOnce({ success: true, messageId: "WX-MSG-1" });

    const result = await createApprovalPrompt({
      sessionId: "s1",
      content: "申请 git push 权限",
      shape: "yes_no",
      targets: [{ type: "channel", channelId: "wc-wechat-1", chatId: "u-x" }],
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const sentPayload = mockSend.mock.calls[0][0];
    expect(sentPayload.content).toMatch(/\n\(回 #[A-Z0-9]{4} 表态\)$/);
    // The promptId is returned and embedded in the suffix
    expect(sentPayload.content).toContain("申请 git push 权限");
  });

  it("does NOT append token suffix for non-wechat channels (D-S05)", async () => {
    const db = getTestDb();
    db.prepare(`
      INSERT INTO channels (id, name, platform, enabled, status, config,
        linked_role_id, allowed_chat_ids, created_at, updated_at, last_message_at, message_count)
      VALUES ('tg-telegram-1', 'Telegram Bot', 'telegram', 1, 'connected', '{}',
        NULL, NULL, 1000, NULL, NULL, 0)
    `).run();

    mockSend.mockResolvedValueOnce({ success: true, messageId: "TG-MSG-1" });

    await createApprovalPrompt({
      sessionId: "s1",
      content: "approve this",
      shape: "yes_no",
      targets: [{ type: "channel", channelId: "tg-telegram-1", chatId: "tgc1" }],
    });

    const sentPayload = mockSend.mock.calls[0][0];
    expect(sentPayload.content).not.toContain("(回 #");
    expect(sentPayload.content).toBe("approve this");
  });

  it("does NOT append token suffix for session targets (D-S05)", async () => {
    // Session targets do not go through gateway.send at all — chat_messages.content is original
    const result = await createApprovalPrompt({
      sessionId: "s1",
      content: "session-only prompt",
      shape: "yes_no",
      targets: [{ type: "session", sessionId: "s1" }],
    });
    const msg = getMessage(result.messageIds[0]);
    expect(msg?.content).toBe("session-only prompt");
    expect(msg?.content).not.toContain("(回 #");
  });

  it("passes parentPlatformMessageId to gateway.send as replyToMessageId (D-008 outbound)", async () => {
    mockSend.mockResolvedValueOnce({ success: true, messageId: "WX-REF-1" });

    await createApprovalPrompt({
      sessionId: "s1",
      content: "x",
      shape: "yes_no",
      parentPlatformMessageId: "wxmsg-1",
      targets: [{ type: "channel", channelId: "wc", chatId: "chat1" }],
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: "wxmsg-1" }),
    );
  });

  it("omits replyToMessageId when parentPlatformMessageId not set", async () => {
    mockSend.mockResolvedValueOnce({ success: true, messageId: "WX-REF-2" });

    await createApprovalPrompt({
      sessionId: "s1",
      content: "y",
      shape: "yes_no",
      targets: [{ type: "channel", channelId: "wc", chatId: "chat1" }],
    });

    const call = mockSend.mock.calls[0][0];
    expect(call.replyToMessageId).toBeUndefined();
  });
});
