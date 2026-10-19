/**
 * Integration Tests: DeliveryEngine + ChatManager to Gateway to ChannelManager
 *
 * Verifies the full chain: caller → OutboundGateway.send() → delivery_log + ChannelManager
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));

// Capture serverBus events
const emittedEvents: Array<{ type: string; [key: string]: unknown }> = [];
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: (event: { type: string; [key: string]: unknown }) => { emittedEvents.push(event); },
  },
}));

// Mock ChannelManager
const mockSendMessage = vi.fn().mockResolvedValue("platform-msg-id");
const mockChannelManager = { sendMessage: mockSendMessage };
const tempDirs: string[] = [];
vi.mock("../../server/routes/channels.js", () => ({
  getChannelManager: vi.fn(() => mockChannelManager),
}));

// Mock formatForChannel to track calls
vi.mock("../../delivery/format.js", () => ({
  formatForChannel: vi.fn((content: string, platform: string) => `[${platform}] ${content}`),
}));

// Mock getChannel
vi.mock("../../store/channels.js", () => ({
  getChannel: vi.fn((channelId: string) => {
    if (channelId === "wc-wechat-1") return { id: channelId, platform: "wechat" };
    if (channelId === "mail-email-1") return { id: channelId, platform: "email" };
    return undefined;
  }),
}));

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanup();
});
beforeEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  clearTestDb();
  emittedEvents.length = 0;
  mockSendMessage.mockReset().mockResolvedValue("platform-msg-id");

  // Seed task row for FK
  const db = getTestDb();
  const now = Date.now();
  for (const id of ["int-task-1", "int-task-2"]) {
    db.exec(`INSERT INTO tasks (id, status, prompt, config, created_at) VALUES ('${id}', 'completed', 'test', '{}', ${now})`);
  }

  // Reset gateway state
  const gateway = getOutboundGateway();
  (gateway as unknown as { _dedupCache: Map<string, unknown> })._dedupCache.clear();
  (gateway as unknown as { _rateLimitWindows: Map<string, number[]> })._rateLimitWindows.clear();
  (gateway as unknown as { _recentlySentIds: Set<string> })._recentlySentIds.clear();
});

import { getOutboundGateway } from "../../delivery/outbound-gateway.js";
import { createDeliveryLog, getDeliveryLogByTask } from "../../store/delivery-log.js";
import { createDeliveryRule } from "../../store/delivery-rules.js";
import type { DeliveryRule } from "../../shared/types.js";

function seedDeliveryRule(): DeliveryRule {
  const rule: DeliveryRule = {
    id: "int-rule-1",
    eventType: "task_complete",
    matchCriteria: {},
    target: { type: "channel", channelId: "wc-wechat-1", chatId: "chat-1" },
    maxPerMinute: 5,
    skipOriginChannel: true,
    enabled: true,
    createdAt: Date.now(),
  };
  createDeliveryRule(rule);
  return rule;
}

describe("DeliveryEngine to Gateway integration", () => {
  it("gateway.send creates delivery_log entry for rule-based delivery", async () => {
    const rule = seedDeliveryRule();
    const gateway = getOutboundGateway();
    const result = await gateway.send({
      taskId: "int-task-1",
      channelId: rule.target.channelId,
      chatId: rule.target.chatId,
      content: "Task completed: weather report",
      messageType: "report",
    });

    expect(result.success).toBe(true);
    const logs = getDeliveryLogByTask("int-task-1");
    expect(logs).toHaveLength(1);
    expect(logs[0].source).toBe("direct");
  });

  it("gateway.send calls ChannelManager.sendMessage with formatted content", async () => {
    const gateway = getOutboundGateway();
    await gateway.send({
      taskId: "int-task-1",
      channelId: "wc-wechat-1",
      chatId: "chat-1",
      content: "Formatted message content",
      messageType: "report",
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const call = mockSendMessage.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(call[0]).toBe("wc-wechat-1"); // channelId
    expect(call[1]).toBe("chat-1"); // chatId
    expect(call[2].content).toBe("[wechat] Formatted message content");
  });

  it("gateway.send forwards email message type and local artifact metadata", async () => {
    const gateway = getOutboundGateway();
    const dir = mkdtempSync(join(tmpdir(), "adam-email-send-"));
    tempDirs.push(dir);
    const reportPath = join(dir, "report.md");
    writeFileSync(reportPath, "# Report");

    await gateway.send({
      taskId: "int-task-1",
      channelId: "mail-email-1",
      chatId: "client@example.com",
      content: "# Report",
      messageType: "deliver",
      mediaUrl: reportPath,
      mediaType: "file",
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const call = mockSendMessage.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(call[0]).toBe("mail-email-1");
    expect(call[1]).toBe("client@example.com");
    expect(call[2]).toEqual(expect.objectContaining({
      content: "[email] # Report",
      messageType: "result_delivery",
      mediaUrl: reportPath,
      mediaType: "file",
    }));
  });

  it("gateway.send emits delivery_status_change on success", async () => {
    const gateway = getOutboundGateway();
    await gateway.send({
      taskId: "int-task-1",
      channelId: "wc-wechat-1",
      chatId: "chat-1",
      content: "Status update",
      messageType: "report",
    });

    const statusChange = emittedEvents.find((e) => e.type === "delivery_status_change");
    expect(statusChange).toBeDefined();
    expect((statusChange as Record<string, unknown>).status).toBe("delivered");
    expect((statusChange as Record<string, unknown>).logEntryId).toBeDefined();
    expect((statusChange as Record<string, unknown>).messageType).toBe("status_report");
  });
});

describe("ChatManager messageType semantics via Gateway", () => {
  it("reportTo uses messageType=report (status summary)", async () => {
    const gateway = getOutboundGateway();
    await gateway.send({
      taskId: "int-task-1",
      channelId: "wc-wechat-1",
      chatId: "chat-1",
      content: "Task completed (analyst)\n\n**Result:** weather report here",
      messageType: "report",
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      "wc-wechat-1",
      "chat-1",
      expect.objectContaining({ content: expect.stringContaining("[wechat]") }),
    );
  });

  it("deliverTo uses messageType=deliver (full result)", async () => {
    const gateway = getOutboundGateway();
    await gateway.send({
      taskId: "int-task-2",
      channelId: "wc-wechat-1",
      chatId: "chat-1",
      content: "**Full Weather Report**\nTemperature: 25C\nConditions: Sunny\nWind: 5km/h",
      messageType: "deliver",
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const call = mockSendMessage.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(call[0]).toBe("wc-wechat-1");
    expect(call[1]).toBe("chat-1");
    expect(call[2].content).toContain("Full Weather Report");
  });

  it("reply uses messageType=reply (interactive reply)", async () => {
    const gateway = getOutboundGateway();
    await gateway.send({
      channelId: "wc-wechat-1",
      chatId: "chat-1",
      content: "You said: what is the weather?",
      messageType: "reply",
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const call = mockSendMessage.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(call[1]).toBe("chat-1");
  });

  it("approval uses messageType=approval (approval request)", async () => {
    const gateway = getOutboundGateway();
    await gateway.send({
      taskId: "int-task-1",
      channelId: "wc-wechat-1",
      chatId: "chat-1",
      content: "Approval required: Delete file /tmp/test.txt?",
      messageType: "approval",
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const call = mockSendMessage.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(call[0]).toBe("wc-wechat-1");
    expect(call[2].content).toContain("Approval required");
  });
});

describe("Dedup across callers", () => {
  it("same task+channel+chat+messageType is deduped even from different callers", async () => {
    const gateway = getOutboundGateway();

    // Caller 1: ChatManager sends report
    const r1 = await gateway.send({
      taskId: "int-task-1",
      channelId: "wc-wechat-1",
      chatId: "chat-1",
      content: "Task completed",
      messageType: "report",
    });

    // Caller 2: DeliveryEngine (different path, same dedup key)
    const r2 = await gateway.send({
      taskId: "int-task-1",
      channelId: "wc-wechat-1",
      chatId: "chat-1",
      content: "Task completed",
      messageType: "report",
    });

    // Should return the same logEntryId (dedup hit)
    expect(r2.logEntryId).toBe(r1.logEntryId);
    // ChannelManager should only be called once
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it("different messageType between callers prevents dedup", async () => {
    const gateway = getOutboundGateway();

    await gateway.send({
      taskId: "int-task-1",
      channelId: "wc-wechat-1",
      chatId: "chat-1",
      content: "Task completed",
      messageType: "report",
    });

    await gateway.send({
      taskId: "int-task-1",
      channelId: "wc-wechat-1",
      chatId: "chat-1",
      content: "Full result text",
      messageType: "deliver",
    });

    // Both should go through since messageType differs
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });
});
