import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
const { chatConfig } = vi.hoisted(() => ({
  chatConfig: {
    sessionTimeoutMinutes: 30,
    maxSessionTurns: 20,
    autoTitle: true,
    archiveExtractMemory: true,
    contextBudgetTokens: 20000,
  },
}));

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/index.js", () => ({
  getChatConfig: () => chatConfig,
  getDefaults: () => ({}),
  DEFAULT_CONFIG: { chat: chatConfig },
}));

vi.mock("../../agent/memory-service.js", () => ({
  queryMemory: vi.fn().mockResolvedValue([]),
  queryMemoryByTier: vi.fn().mockResolvedValue([]),
}));

import { buildSessionContext } from "../../chat/context-builder.js";
import { getRecentDeliveryContextItems } from "../../chat/recent-delivery-context.js";
import { _resetForTest } from "../../chat/session-manager.js";
import { createChannel } from "../../store/channels.js";
import { createMessage } from "../../store/messages.js";
import { createSession } from "../../store/sessions.js";
import { recordUserVisibleDeliveryEvent } from "../../store/user-visible-events.js";

afterAll(() => {
  _resetForTest();
  cleanup();
});

beforeEach(() => {
  _resetForTest();
  clearTestDb();
  chatConfig.sessionTimeoutMinutes = 30;
  chatConfig.contextBudgetTokens = 20000;
});

function seedChannel(id: string, viewerKey: string): void {
  createChannel({
    id,
    name: id,
    platform: id.includes("email") ? "email" : "wechat",
    enabled: true,
    status: "connected",
    config: {},
    viewerKey,
    createdAt: 1,
    messageCount: 0,
  });
}

describe("chat/recent-delivery-context", () => {
  it("includes same-viewer Email delivery that predates the WeChat session", async () => {
    const t0 = new Date(2026, 4, 11, 8, 47).getTime();
    seedChannel("email-owner", "owner");
    seedChannel("wechat-owner", "owner");
    createSession({
      id: "wechat-session",
      status: "active",
      source: { type: "channel", channelId: "wechat-owner", chatId: "wx" },
      createdAt: t0 + 120_000,
      lastActiveAt: t0 + 120_000,
      messageCount: 0,
    });
    recordUserVisibleDeliveryEvent({
      eventKey: "owner|fc25b247|result_delivery|hash",
      sourceType: "template_execution",
      sourceId: "fc25b247",
      taskId: "fc25b247",
      templateId: "tmpl-podcast",
      templateName: "Daily podcast",
      messageType: "result_delivery",
      viewerKey: "owner",
      contentPreview: "AI weekly briefing 2026-05-11",
      targets: [{ type: "channel", channelId: "email-owner", chatId: "norvyn@example.com", label: "Email" }],
      attachments: [{ filename: "podcast_2026_05_11_final.mp3", mimeType: "audio/mpeg", sizeBytes: 5_400_000 }],
      deliveredAt: t0,
    });

    const context = await buildSessionContext("wechat-session", "刚才那个播客是什么？", {
      currentMessageAt: t0 + 180_000,
    });

    expect(context).toContain("[Recent deliveries - user-visible ledger]");
    expect(context).toContain("Daily podcast");
    expect(context).toContain("AI weekly briefing 2026-05-11");
    expect(context).toContain("Email:norvyn@example.com");
    expect(context).toContain("podcast_2026_05_11_final.mp3 audio/mpeg 5.1MB");
  });

  it("excludes delivery events already represented in the current session timeline", () => {
    const t0 = 10_000;
    seedChannel("wechat-owner", "owner");
    createSession({
      id: "s-dup",
      status: "active",
      source: { type: "channel", channelId: "wechat-owner", chatId: "wx" },
      createdAt: t0,
      lastActiveAt: t0,
      messageCount: 0,
    });
    createMessage({
      id: "msg-result",
      sessionId: "s-dup",
      role: "assistant",
      content: "delivered in timeline",
      source: { type: "channel", channelId: "wechat-owner", chatId: "wx" },
      taskId: "task-already-visible",
      kind: "result_delivery",
      createdAt: t0 + 1,
    });
    recordUserVisibleDeliveryEvent({
      eventKey: "owner|task-already-visible|result_delivery|hash",
      sourceType: "task",
      sourceId: "task-already-visible",
      taskId: "task-already-visible",
      messageType: "result_delivery",
      viewerKey: "owner",
      contentPreview: "duplicate delivery",
      deliveredAt: t0 + 2,
    });

    const items = getRecentDeliveryContextItems("s-dup", "next", { currentMessageAt: t0 + 3 });
    expect(items).toEqual([]);
  });

  it("excludes same-window events for other viewers", () => {
    const t0 = 20_000;
    seedChannel("wechat-owner", "owner");
    createSession({
      id: "s-owner",
      status: "active",
      source: { type: "channel", channelId: "wechat-owner", chatId: "wx" },
      createdAt: t0,
      lastActiveAt: t0,
      messageCount: 0,
    });
    recordUserVisibleDeliveryEvent({
      eventKey: "owner|task-owner|result_delivery|hash",
      sourceType: "task",
      sourceId: "task-owner",
      taskId: "task-owner",
      messageType: "result_delivery",
      viewerKey: "owner",
      contentPreview: "owner delivery",
      deliveredAt: t0 + 1,
    });
    recordUserVisibleDeliveryEvent({
      eventKey: "other|task-other|result_delivery|hash",
      sourceType: "task",
      sourceId: "task-other",
      taskId: "task-other",
      messageType: "result_delivery",
      viewerKey: "other",
      contentPreview: "other delivery",
      deliveredAt: t0 + 2,
    });

    const items = getRecentDeliveryContextItems("s-owner", "next", { currentMessageAt: t0 + 3 });
    expect(items).toHaveLength(1);
    expect(items[0].renderedPreview).toContain("owner delivery");
    expect(items[0].renderedPreview).not.toContain("other delivery");
  });

  it("drops oldest recent delivery rows through the context token budget", async () => {
    const t0 = 30_000;
    chatConfig.contextBudgetTokens = 10;
    seedChannel("wechat-owner", "owner");
    createSession({
      id: "s-budget",
      status: "active",
      source: { type: "channel", channelId: "wechat-owner", chatId: "wx" },
      createdAt: t0,
      lastActiveAt: t0,
      messageCount: 0,
    });
    recordUserVisibleDeliveryEvent({
      eventKey: "owner|old|result_delivery|hash",
      sourceType: "task",
      sourceId: "old",
      taskId: "old",
      messageType: "result_delivery",
      viewerKey: "owner",
      contentPreview: "oversized-delivery " + "x".repeat(1000),
      deliveredAt: t0 + 1,
    });
    recordUserVisibleDeliveryEvent({
      eventKey: "owner|new|result_delivery|hash",
      sourceType: "task",
      sourceId: "new",
      taskId: "new",
      messageType: "result_delivery",
      viewerKey: "owner",
      contentPreview: "small-delivery",
      deliveredAt: t0 + 2,
    });

    const context = await buildSessionContext("s-budget", "next", {
      currentMessageAt: t0 + 3,
      tokenCounter: (text) => text.includes("oversized-delivery") ? 1000 : 1,
    });

    expect(context).toContain("[Recent deliveries - user-visible ledger]");
    expect(context).toContain("1 older delivery row(s) omitted by chat.contextBudgetTokens");
    expect(context).toContain("small-delivery");
    expect(context).not.toContain("oversized-delivery");
  });
});
