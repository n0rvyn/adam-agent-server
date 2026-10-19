/**
 * Tests for cross-channel sync (Task 11):
 * syncResolvedPrompt propagates prompt resolution to all channel targets,
 * capability-aware: canEdit=true → editMessage, canEdit=false → broadcast system_note.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";
import { syncResolvedPrompt } from "../../chat/cross-channel-sync.js";
import { createMessage } from "../../store/messages.js";
import * as sessionStore from "../../store/sessions.js";
import type { ChatSource, ChatSession } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------
let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

// Outbound gateway call tracker
const gatewaySendCalls: Array<{
  channelId: string;
  chatId: string;
  content: string;
  messageType: string;
}> = [];

// Channel capabilities registry (populated in each test before calling sync)
const channelCapabilities: Record<string, { canEdit: boolean } | null> = {};

// Track editMessage calls per channelId
const editMessageCalls: Array<{
  channelId: string;
  chatId: string;
  messageId: string;
  content: string;
}> = [];

// Module-level mock manager (initialized before vi.mock)
const mockManager = {
  getCapabilities: (channelId: string) => channelCapabilities[channelId] ?? null,
  editMessage: async (channelId: string, chatId: string, messageId: string, content: string) => {
    editMessageCalls.push({ channelId, chatId, messageId, content });
  },
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (opts: {
      channelId: string;
      chatId: string;
      content: string;
      messageType: string;
    }) => {
      gatewaySendCalls.push(opts);
      return { success: true };
    }),
  }),
}));

// NOTE: mockManager is captured by reference above; its methods are spied in beforeEach
vi.mock("../../server/routes/channels.js", () => ({
  getChannelManager: () => mockManager,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeSession(id: string, source: ChatSource = { type: "web" }): ChatSession {
  const existing = sessionStore.getSession(id);
  if (existing) return existing;
  sessionStore.createSession({
    id,
    status: "active",
    source,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    messageCount: 0,
  });
  return sessionStore.getSession(id)!;
}

describe("cross-channel sync (Task 11)", () => {
  beforeAll(() => {
    const result = setupTestDb();
    dbRef = result.db;
  });

  afterAll(() => {
    dbRef.close();
  });

  beforeEach(() => {
    clearTestDb();
    gatewaySendCalls.length = 0;
    editMessageCalls.length = 0;
    // Clear capabilities
    for (const k of Object.keys(channelCapabilities)) delete channelCapabilities[k];
  });

  // =======================================================================
  // Test: WeChat (canEdit=false) + Telegram (canEdit=true) + Web
  // =======================================================================
  it("edits canEdit channels and broadcasts to non-editable channels", async () => {
    const session = makeSession("s-sync-1", { type: "web" });
    const promptId = "SYNC1";

    // WeChat — canEdit=false → broadcast
    channelCapabilities["wc-id"] = { canEdit: false };
    createMessage({
      id: "msg-wc",
      sessionId: session.id,
      role: "assistant",
      content: "请确认",
      source: { type: "channel", channelId: "wc-id", chatId: "wc-chat" },
      kind: "approval_prompt",
      promptId,
      platformMessageId: "WC-PM-1",
      createdAt: Date.now(),
    });

    // Telegram — canEdit=true → editMessage
    channelCapabilities["tg-id"] = { canEdit: true };
    createMessage({
      id: "msg-tg",
      sessionId: session.id,
      role: "assistant",
      content: "请确认",
      source: { type: "channel", channelId: "tg-id", chatId: "tg-chat" },
      kind: "approval_prompt",
      promptId,
      platformMessageId: "TG-PM-1",
      createdAt: Date.now() + 1,
    });

    // Web — type='web' → skipped (matches skipSource)
    createMessage({
      id: "msg-web",
      sessionId: session.id,
      role: "assistant",
      content: "请确认",
      source: { type: "web" },
      kind: "approval_prompt",
      promptId,
      createdAt: Date.now() + 2,
    });

    await syncResolvedPrompt({
      promptId,
      verdict: "批准",
      originatorLabel: "Web",
      skipSource: { type: "web" },
    });

    // WeChat: broadcast system_note
    const wcCall = gatewaySendCalls.find((c) => c.channelId === "wc-id");
    expect(wcCall).toBeDefined();
    expect(wcCall!.messageType).toBe("system_note");
    expect(wcCall!.content).toContain(promptId);

    // Telegram: editMessage called
    const tgCall = editMessageCalls.find((c) => c.channelId === "tg-id");
    expect(tgCall).toBeDefined();
    expect(tgCall!.messageId).toBe("TG-PM-1");
    expect(tgCall!.content).toMatch(/\[\已批准.*✓\]/);

    // Web row NOT updated (skipSource)
    expect(gatewaySendCalls.filter((c) => c.channelId === "web").length).toBe(0);
    expect(editMessageCalls.filter((c) => c.channelId === "web").length).toBe(0);
  });

  // =======================================================================
  // Test: verdict classification
  // =======================================================================
  it('classifies "批准" verdict → check broadcast content includes promptId + mark', async () => {
    const session = makeSession("s-classify-1", { type: "web" });
    const promptId = "CLS001";

    channelCapabilities["ch"] = { canEdit: false };
    createMessage({
      id: "msg-cls",
      sessionId: session.id,
      role: "assistant",
      content: "confirm?",
      source: { type: "channel", channelId: "ch", chatId: "chat1" },
      kind: "approval_prompt",
      promptId,
      platformMessageId: "CH-PM",
      createdAt: Date.now(),
    });

    await syncResolvedPrompt({
      promptId,
      verdict: "批准",
      originatorLabel: "Web",
      skipSource: { type: "web" },
    });

    const call = gatewaySendCalls[0];
    // broadcastContent = `#${promptId} 已在 ${originatorLabel} 端${verdictLabel} ${verdictMark}`
    expect(call.content).toContain(promptId);
    expect(call.content).toContain("✓");
  });

  it('classifies "拒绝" verdict → check broadcast content includes ✗', async () => {
    const session = makeSession("s-classify-2", { type: "web" });
    const promptId = "CLS002";

    channelCapabilities["ch2"] = { canEdit: false };
    createMessage({
      id: "msg-cls2",
      sessionId: session.id,
      role: "assistant",
      content: "confirm?",
      source: { type: "channel", channelId: "ch2", chatId: "chat2" },
      kind: "approval_prompt",
      promptId,
      platformMessageId: "CH-PM-2",
      createdAt: Date.now(),
    });

    await syncResolvedPrompt({
      promptId,
      verdict: "拒绝",
      originatorLabel: "TUI",
      skipSource: { type: "tui" },
    });

    const call = gatewaySendCalls[0];
    expect(call.content).toContain(promptId);
    expect(call.content).toContain("✗");
  });

  it("falls back to verbatim verdict for unrecognized text", async () => {
    const session = makeSession("s-classify-3", { type: "web" });
    const promptId = "CLS003";

    channelCapabilities["ch3"] = { canEdit: false };
    createMessage({
      id: "msg-cls3",
      sessionId: session.id,
      role: "assistant",
      content: "confirm?",
      source: { type: "channel", channelId: "ch3", chatId: "chat3" },
      kind: "approval_prompt",
      promptId,
      platformMessageId: "CH-PM-3",
      createdAt: Date.now(),
    });

    await syncResolvedPrompt({
      promptId,
      verdict: "sounds good",
      originatorLabel: "Web",
      skipSource: { type: "web" },
    });

    const call = gatewaySendCalls[0];
    expect(call.content).toContain(promptId);
  });

  // =======================================================================
  // Test: editMessage failure → fallback to broadcast
  // =======================================================================
  it("falls back to broadcast when editMessage throws", async () => {
    const session = makeSession("s-fallback", { type: "web" });
    const promptId = "FALLBK";

    channelCapabilities["fallback-ch"] = { canEdit: true };
    createMessage({
      id: "msg-fallback",
      sessionId: session.id,
      role: "assistant",
      content: "confirm?",
      source: { type: "channel", channelId: "fallback-ch", chatId: "fb-chat" },
      kind: "approval_prompt",
      promptId,
      platformMessageId: "FB-PM",
      createdAt: Date.now(),
    });

    // Override editMessage to throw
    const originalEdit = mockManager.editMessage;
    mockManager.editMessage = async () => {
      throw new Error("edit failed");
    };

    await syncResolvedPrompt({
      promptId,
      verdict: "批准",
      originatorLabel: "Web",
      skipSource: { type: "web" },
    });

    // Restore
    mockManager.editMessage = originalEdit;

    // editMessage threw, fallback to broadcast
    const fallbackCall = gatewaySendCalls.find(
      (c) => c.channelId === "fallback-ch" && c.messageType === "system_note",
    );
    expect(fallbackCall).toBeDefined();
    expect(fallbackCall!.content).toContain(promptId);
  });

  // =======================================================================
  // Test: skip originator channel (D-P5-08)
  // =======================================================================
  it("skips originator channel row (D-P5-08)", async () => {
    const session = makeSession("s-skip-origin", { type: "web" });
    const promptId = "SKIPORG";

    // User resolves on Telegram — skip Telegram row
    channelCapabilities["telegram-skip"] = { canEdit: true };
    createMessage({
      id: "msg-tg-skip",
      sessionId: session.id,
      role: "assistant",
      content: "请确认",
      source: { type: "channel", channelId: "telegram-skip", chatId: "tg-skip-chat" },
      kind: "approval_prompt",
      promptId,
      platformMessageId: "TG-SKIP-PM",
      createdAt: Date.now(),
    });

    channelCapabilities["wechat-skip"] = { canEdit: false };
    createMessage({
      id: "msg-wc-skip",
      sessionId: session.id,
      role: "assistant",
      content: "请确认",
      source: { type: "channel", channelId: "wechat-skip", chatId: "wc-skip-chat" },
      kind: "approval_prompt",
      promptId,
      platformMessageId: "WC-SKIP-PM",
      createdAt: Date.now() + 1,
    });

    await syncResolvedPrompt({
      promptId,
      verdict: "批准",
      originatorLabel: "Telegram",
      // User clicked button on Telegram → skip Telegram channel row
      skipSource: { type: "channel", channelId: "telegram-skip", chatId: "tg-skip-chat" },
    });

    // Telegram NOT updated
    const tgEdit = editMessageCalls.filter((c) => c.channelId === "telegram-skip");
    const tgBroadcast = gatewaySendCalls.filter((c) => c.channelId === "telegram-skip");
    expect(tgEdit.length).toBe(0);
    expect(tgBroadcast.length).toBe(0);

    // WeChat IS updated
    const wcBroadcast = gatewaySendCalls.find((c) => c.channelId === "wechat-skip");
    expect(wcBroadcast).toBeDefined();
  });
});
