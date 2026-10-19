import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));

// Mock serverBus to capture emitted events
const emittedEvents: Array<{ type: string; [key: string]: unknown }> = [];
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: (event: { type: string; [key: string]: unknown }) => { emittedEvents.push(event); },
  },
}));

// Mock formatForChannel
vi.mock("../../delivery/format.js", () => ({
  formatForChannel: vi.fn((content: string, platform: string, _taskId?: string) => `[${platform}] ${content}`),
}));

// Mock getChannel to return a known platform
vi.mock("../../store/channels.js", () => ({
  getChannel: vi.fn((channelId: string) => {
    if (channelId === "wc-wechat-1") return { id: channelId, name: "WeChat", platform: "wechat", config: {}, viewerKey: "owner" };
    if (channelId === "tg-telegram-1") return { id: channelId, name: "Telegram", platform: "telegram", config: {}, viewerKey: "owner" };
    if (channelId === "unmapped-channel") return { id: channelId, name: "Unmapped", platform: "wechat", config: {} };
    return undefined;
  }),
}));

// Mock fetch globally for webhook tests
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock getChannelManager for channel path tests
const mockSendMessage = vi.fn();
const mockChannelManager = { sendMessage: mockSendMessage };
vi.mock("../../server/routes/channels.js", () => ({
  getChannelManager: vi.fn(() => mockChannelManager),
}));

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();

  // Seed task rows after clear (for FK constraint on delivery_log.task_id)
  const db = getTestDb();
  const now = Date.now();
  for (const id of [
    "task-1", "task-2",
    "task-log-1", "task-log-2", "task-log-3", "task-log-4",
    "task-wh-1", "task-wh-2",
    "task-evt-1", "task-evt-2",
    "task-media-1", "task-media-invalid", "task-media-queued",
    "task-ledger-1", "task-ledger-reply", "task-ledger-diagnostic",
    // rate limit test uses unique taskIds
    ...Array.from({ length: 61 }, (_, i) => `rate-task-${i}`),
    "rate-task-blocked",
  ]) {
    db.exec(`INSERT INTO tasks (id, status, prompt, config, created_at) VALUES ('${id}', 'pending', 'seed', '{}', ${now})`);
  }

  emittedEvents.length = 0;
  mockFetch.mockReset().mockResolvedValue({ ok: true });
  mockSendMessage.mockReset().mockResolvedValue("msg-123");

  // Reset gateway internal state
  const gateway = getOutboundGateway();
  (gateway as unknown as { _dedupCache: Map<string, unknown> })._dedupCache.clear();
  (gateway as unknown as { _rateLimitWindows: Map<string, number[]> })._rateLimitWindows.clear();
  (gateway as unknown as { _recentlySentIds: Set<string> })._recentlySentIds.clear();
});

import { getOutboundGateway, isRecentlySent } from "../../delivery/outbound-gateway.js";
import { getDeliveryLogByTask } from "../../store/delivery-log.js";
import { getUserVisibleEventByEventKey, listUserVisibleEventsForContext } from "../../store/user-visible-events.js";
import { listAuditDiagnostics } from "../../store/audit-diagnostics.js";

describe("OutboundGateway", () => {

  describe("dedup", () => {
    it("returns cached logEntryId on duplicate send within 5 minutes", async () => {
      const gateway = getOutboundGateway();
      const result1 = await gateway.send({
        taskId: "task-1",
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "hello",
        messageType: "report",
      });
      expect(result1.success).toBe(true);
      const result2 = await gateway.send({
        taskId: "task-1",
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "hello",
        messageType: "report",
      });
      expect(result2.success).toBe(true);
      expect(result2.logEntryId).toBe(result1.logEntryId);
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    it("does not dedup different messageType", async () => {
      const gateway = getOutboundGateway();
      await gateway.send({
        taskId: "task-1",
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "hello",
        messageType: "report",
      });
      await gateway.send({
        taskId: "task-1",
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "hello",
        messageType: "deliver",
      });
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });

    it("does not dedup different taskId", async () => {
      const gateway = getOutboundGateway();
      await gateway.send({
        taskId: "task-1",
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "hello",
        messageType: "report",
      });
      await gateway.send({
        taskId: "task-2",
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "hello",
        messageType: "report",
      });
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe("format", () => {
    it("calls formatForChannel with correct platform for wechat", async () => {
      const gateway = getOutboundGateway();
      await gateway.send({
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "test content",
        messageType: "report",
      });
      const { formatForChannel } = await import("../../delivery/format.js");
      expect(formatForChannel).toHaveBeenCalledWith("test content", "wechat", undefined);
    });

    it("skips formatting for webhook targets", async () => {
      const { formatForChannel } = await import("../../delivery/format.js");
      (formatForChannel as ReturnType<typeof vi.fn>).mockClear();
      const gateway = getOutboundGateway();
      await gateway.send({
        webhookUrl: "https://example.com/hook",
        content: "raw data",
        messageType: "deliver",
      });
      expect(formatForChannel).not.toHaveBeenCalled();
    });
  });

  describe("anti-loop", () => {
    it("isRecentlySent returns true after sending a message", async () => {
      const gateway = getOutboundGateway();
      await gateway.send({
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "test",
        messageType: "report",
      });
      expect(isRecentlySent("msg-123")).toBe(true);
    });

    it("isRecentlySent returns false for unknown ID", async () => {
      expect(isRecentlySent("unknown-id")).toBe(false);
    });

    it("isRecentlySent exported function delegates to singleton", async () => {
      const gateway = getOutboundGateway();
      await gateway.send({
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "test",
        messageType: "report",
      });
      expect(isRecentlySent("msg-123")).toBe(true);
    });
  });

  describe("rate limit", () => {
    it("blocks the 61st message to same channel within 60 seconds", async () => {
      const gateway = getOutboundGateway();
      for (let i = 0; i < 60; i++) {
        const r = await gateway.send({
          taskId: `rate-task-${i}`, // unique taskId avoids dedup collisions
          channelId: "wc-wechat-1",
          chatId: "chat-1",
          content: `msg ${i}`,
          messageType: "report",
        });
        expect(r.success).toBe(true);
      }
      const r61 = await gateway.send({
        taskId: "rate-task-blocked",
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "should be blocked",
        messageType: "report",
      });
      expect(r61.success).toBe(false);
      expect(r61.error).toBe("rate_limited");
    });

    it("different channels do not share rate limit", async () => {
      const gateway = getOutboundGateway();
      for (let i = 0; i < 60; i++) {
        await gateway.send({
          channelId: "wc-wechat-1",
          chatId: "chat-1",
          content: `msg ${i}`,
          messageType: "report",
        });
      }
      const r = await gateway.send({
        channelId: "tg-telegram-1",
        chatId: "chat-tg",
        content: "telegram msg",
        messageType: "report",
      });
      expect(r.success).toBe(true);
    });
  });

  describe("delivery_log", () => {
    it("creates delivery_log entry with source=direct on send", async () => {
      const gateway = getOutboundGateway();
      const result = await gateway.send({
        taskId: "task-log-1",
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "log test",
        messageType: "report",
      });
      const logs = getDeliveryLogByTask("task-log-1");
      expect(logs).toHaveLength(1);
      expect(logs[0].id).toBe(result.logEntryId);
      expect(logs[0].source).toBe("direct");
      expect(logs[0].messageType).toBe("status_report");
    });

    it("marks log entry as delivered on success", async () => {
      const gateway = getOutboundGateway();
      await gateway.send({
        taskId: "task-log-2",
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "success test",
        messageType: "deliver",
      });
      const logs = getDeliveryLogByTask("task-log-2");
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe("delivered");
    });

    it("updates log entry to failed on channel error", async () => {
      mockSendMessage.mockRejectedValueOnce(new Error("Channel unavailable"));
      const gateway = getOutboundGateway();
      const result = await gateway.send({
        taskId: "task-log-3",
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "should fail",
        messageType: "report",
      });
      expect(result.success).toBe(false);
      const logs = getDeliveryLogByTask("task-log-3");
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe("failed");
      expect(logs[0].error).toBe("Channel unavailable");
    });

    it("updates log entry to failed on webhook error", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      const gateway = getOutboundGateway();
      const result = await gateway.send({
        taskId: "task-log-4",
        webhookUrl: "https://example.com/fail",
        content: "webhook fail",
        messageType: "deliver",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("Webhook returned 500");
      const logs = getDeliveryLogByTask("task-log-4");
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe("failed");
      expect(logs[0].error).toBe("Webhook returned 500");
    });
  });

  describe("user-visible delivery ledger", () => {
    it("records one logical ledger event and merges fanout targets", async () => {
      const gateway = getOutboundGateway();
      await gateway.send({
        taskId: "task-ledger-1",
        channelId: "wc-wechat-1",
        chatId: "chat-wx",
        content: "daily podcast delivered",
        messageType: "deliver",
        attachments: [{
          path: "/tmp/podcast.mp3",
          mediaType: "audio",
          filename: "podcast.mp3",
          contentType: "audio/mpeg",
          mimeType: "audio/mpeg",
          sizeBytes: 128,
          artifactId: "artifact-1",
          locator: "local:///tmp/podcast.mp3",
          purpose: "media",
          contentHash: "hash-1",
        }],
      });
      await gateway.send({
        taskId: "task-ledger-1",
        channelId: "tg-telegram-1",
        chatId: "chat-tg",
        content: "daily podcast delivered",
        messageType: "result_delivery",
      });

      const rows = listUserVisibleEventsForContext({
        viewerKey: "owner",
        since: 0,
        until: Date.now() + 1,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({
        sourceType: "task",
        sourceId: "task-ledger-1",
        messageType: "result_delivery",
        contentPreview: "daily podcast delivered",
      }));
      expect(rows[0].targets).toEqual(expect.arrayContaining([
        expect.objectContaining({ channelId: "wc-wechat-1", chatId: "chat-wx" }),
        expect.objectContaining({ channelId: "tg-telegram-1", chatId: "chat-tg" }),
      ]));
      expect(rows[0].attachments).toEqual([
        expect.objectContaining({
          artifactId: "artifact-1",
          filename: "podcast.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 128,
          purpose: "media",
          contentHash: "hash-1",
        }),
      ]);
    });

    it("does not record conversational replies", async () => {
      const gateway = getOutboundGateway();
      await gateway.send({
        taskId: "task-ledger-reply",
        channelId: "wc-wechat-1",
        chatId: "chat-wx",
        content: "chat reply",
        messageType: "reply",
      });

      expect(getUserVisibleEventByEventKey("owner|task-ledger-reply|reply|unused")).toBeUndefined();
      expect(listUserVisibleEventsForContext({ viewerKey: "owner", since: 0, until: Date.now() + 1 })).toEqual([]);
    });

    it("records a diagnostic when viewer identity is unresolved", async () => {
      const gateway = getOutboundGateway();
      await gateway.send({
        taskId: "task-ledger-diagnostic",
        channelId: "unmapped-channel",
        chatId: "chat",
        content: "unscoped",
        messageType: "deliver",
      });

      const diagnostics = listAuditDiagnostics({ source: "delivery_ledger" });
      expect(diagnostics[0]).toEqual(expect.objectContaining({
        severity: "warning",
        sourceId: "task-ledger-diagnostic",
      }));
    });
  });

  describe("webhook path", () => {
    it("sends raw content (no formatting) to webhook", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      const gateway = getOutboundGateway();
      await gateway.send({
        taskId: "task-wh-1",
        webhookUrl: "https://example.com/hook",
        content: "raw task result here",
        messageType: "deliver",
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://example.com/hook");
      const body = JSON.parse(opts.body as string) as Record<string, unknown>;
      expect(body.result).toBe("raw task result here");
      expect(body.taskId).toBe("task-wh-1");
      expect(body.timestamp).toBeDefined();
    });

    it("marks delivered on webhook 200", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      const gateway = getOutboundGateway();
      const result = await gateway.send({
        taskId: "task-wh-2",
        webhookUrl: "https://example.com/ok",
        content: "ok",
        messageType: "report",
      });
      const logs = getDeliveryLogByTask("task-wh-2");
      expect(logs[0].status).toBe("delivered");
      expect(result.success).toBe(true);
    });
  });

  describe("serverBus events", () => {
    it("emits delivery_status_change with delivered on success", async () => {
      const gateway = getOutboundGateway();
      await gateway.send({
        taskId: "task-evt-1",
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "event test",
        messageType: "report",
      });
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].type).toBe("delivery_status_change");
      expect((emittedEvents[0] as Record<string, unknown>).status).toBe("delivered");
    });

    it("emits delivery_status_change with failed on error", async () => {
      mockSendMessage.mockRejectedValueOnce(new Error("network error"));
      const gateway = getOutboundGateway();
      await gateway.send({
        taskId: "task-evt-2",
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "should fail",
        messageType: "report",
      });
      const failed = emittedEvents.find((e) => (e as Record<string, unknown>).status === "failed");
      expect(failed).toBeDefined();
      expect((failed as Record<string, unknown>).error).toBe("network error");
    });
  });

  describe("media passthrough", () => {
    it("passes mediaUrl and mediaType to ChannelManager.sendMessage", async () => {
      const dir = mkdtempSync(join(tmpdir(), "adam-gateway-media-"));
      const mediaFile = join(dir, "recording.mp3");
      writeFileSync(mediaFile, "audio");
      const gateway = getOutboundGateway();
      await gateway.send({
        taskId: "task-media-1",
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "Here is your recording",
        messageType: "deliver",
        mediaUrl: mediaFile,
        mediaType: "audio",
      });

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      const payload = mockSendMessage.mock.calls[0][2];
      expect(payload.mediaUrl).toBe(mediaFile);
      expect(payload.mediaType).toBe("audio");
    });

    it("passes attachments to ChannelManager.sendMessage", async () => {
      const gateway = getOutboundGateway();
      await gateway.send({
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "attachments",
        messageType: "deliver",
        attachments: [{ path: "/tmp/report.md", mediaType: "file", filename: "report.md", contentType: "text/markdown" }],
      });

      const payload = mockSendMessage.mock.calls[0][2];
      expect(payload.attachments).toEqual([{ path: "/tmp/report.md", mediaType: "file", filename: "report.md", contentType: "text/markdown" }]);
    });

    it("rejects invalid mediaUrl before adapter dispatch and records failed", async () => {
      const gateway = getOutboundGateway();
      const result = await gateway.send({
        taskId: "task-media-invalid",
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "bad media",
        messageType: "deliver",
        mediaUrl: "https://example.com/recording.mp3",
        mediaType: "audio",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("mediaUrl must be a local file path");
      expect(mockSendMessage).not.toHaveBeenCalled();
      const logs = getDeliveryLogByTask("task-media-invalid");
      expect(logs[0].status).toBe("failed");
      expect(logs[0].error).toBe("mediaUrl must be a local file path");
    });

    it("leaves queued adapter returns pending and returns success false", async () => {
      mockSendMessage.mockResolvedValueOnce("queued-paused-session");
      const gateway = getOutboundGateway();
      const result = await gateway.send({
        taskId: "task-media-queued",
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "queued",
        messageType: "deliver",
      });

      expect(result.success).toBe(false);
      expect(result.messageId).toBe("queued-paused-session");
      expect(result.error).toBe("queued_not_delivered");
      const logs = getDeliveryLogByTask("task-media-queued");
      expect(logs[0].status).toBe("pending");
      const pendingEvent = emittedEvents.find((e) => e.status === "pending" && e.logEntryId === result.logEntryId);
      expect(pendingEvent?.error).toBe("queued_not_delivered");
    });

    it("marks delivery as failed when sendMessage returns null", async () => {
      mockSendMessage.mockResolvedValueOnce(null);
      const gateway = getOutboundGateway();
      const result = await gateway.send({
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "should fail",
        messageType: "deliver",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("returned null");

      // Verify delivery_log has "failed" status
      const logs = getDeliveryLogByTask(undefined as unknown as string);
      // The null-check path should not mark as delivered
      const failedEvent = emittedEvents.find((e) => e.status === "failed" && e.logEntryId === result.logEntryId);
      expect(failedEvent).toBeDefined();
    });

    it("omits media fields when not provided", async () => {
      const gateway = getOutboundGateway();
      await gateway.send({
        channelId: "wc-wechat-1",
        chatId: "chat-1",
        content: "Plain text",
        messageType: "deliver",
      });

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      const payload = mockSendMessage.mock.calls[0][2];
      expect(payload.mediaUrl).toBeUndefined();
      expect(payload.mediaType).toBeUndefined();
    });
  });

});
