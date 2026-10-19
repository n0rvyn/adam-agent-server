/**
 * Unit tests for OutboundGateway receipt writes (Phase 2 DP-002).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

const emittedEvents: Array<{ type: string; [key: string]: unknown }> = [];
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: (event: { type: string; [key: string]: unknown }) => { emittedEvents.push(event); },
  },
}));

vi.mock("../../delivery/format.js", () => ({
  formatForChannel: vi.fn((content: string, platform: string) => `[${platform}] ${content}`),
}));

const channelRows = new Map<string, Record<string, unknown>>();
vi.mock("../../store/channels.js", () => ({
  getChannel: vi.fn((channelId: string) => channelRows.get(channelId) as unknown),
}));

const mockSendMessage = vi.fn();
vi.mock("../../server/routes/channels.js", () => ({
  getChannelManager: vi.fn(() => ({ sendMessage: mockSendMessage })),
}));

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  emittedEvents.length = 0;
  channelRows.clear();
  mockSendMessage.mockReset();
  channelRows.set("ch-A", { id: "ch-A", name: "Channel A", platform: "email", config: {}, viewerKey: "owner" });
  channelRows.set("ch-B", { id: "ch-B", name: "Channel B", platform: "email", config: {}, viewerKey: "owner" });

  const db = getTestDb();
  db.exec("INSERT OR IGNORE INTO tasks (id, status, prompt, config, created_at) VALUES ('task-receipts', 'completed', 'seed', '{}', " + Date.now() + ")");
  db.exec("INSERT OR IGNORE INTO tasks (id, status, prompt, config, created_at) VALUES ('task-webhook', 'completed', 'seed', '{}', " + Date.now() + ")");

  const gateway = getOutboundGateway();
  (gateway as unknown as { _dedupCache: Map<string, unknown> })._dedupCache.clear();
  (gateway as unknown as { _rateLimitWindows: Map<string, number[]> })._rateLimitWindows.clear();
  (gateway as unknown as { _recentlySentIds: Set<string> })._recentlySentIds.clear();
});

import { getOutboundGateway } from "../../delivery/outbound-gateway.js";
import { listReceiptsByTask } from "../../store/effect-receipts.js";
import { withNewTrace } from "../../lib/trace-context.js";

function makeAttachment(overrides: Partial<{ artifactId: string | undefined; path: string; mediaType: "image" | "file" | "audio" | "video" | undefined; filename: string; contentType: string; mimeType: string | undefined }> = {}) {
  return {
    path: "/tmp/test.txt",
    mediaType: "file" as const,
    filename: "test.txt",
    contentType: "text/plain",
    mimeType: "text/plain",
    artifactId: "art-1",
    ...overrides,
  };
}

describe("OutboundGateway receipt writes — Phase 2 DP-002", () => {

  it("In-trace channel success → outcome='success' receipt written", async () => {
    mockSendMessage.mockResolvedValue("msg-1");
    await withNewTrace("chat", async () => {
      const gateway = getOutboundGateway();
      await gateway.send({
        taskId: "task-receipts",
        channelId: "ch-A",
        chatId: "chat-1",
        content: "Hello",
        messageType: "deliver",
        platform: "email",
      });
    });
    const receipts = listReceiptsByTask("task-receipts");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].outcome).toBe("success");
    expect(receipts[0].effectCategory).toBe("outbound_message");
    expect(receipts[0].verb).toBe("send");
    expect(receipts[0].entityType).toBe("channel_message");
  });

  it("In-trace adapter-null failure → outcome='failure' receipt written", async () => {
    mockSendMessage.mockResolvedValue(null);
    await withNewTrace("chat", async () => {
      const gateway = getOutboundGateway();
      await gateway.send({
        taskId: "task-receipts",
        channelId: "ch-A",
        chatId: "chat-1",
        content: "Hello",
        messageType: "deliver",
        platform: "email",
      });
    });
    const receipts = listReceiptsByTask("task-receipts");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].outcome).toBe("failure");
  });

  it("In-trace rate-limit failure → outcome='failure' receipt written", async () => {
    // Seed the rate limit window directly: 60 entries = at limit.
    // Cluster within the last ~6 seconds so the gateway's 60-second-window
    // cleanup doesn't drop any entries due to seed-vs-gateway clock drift
    // when the suite is under load.
    const gateway = getOutboundGateway();
    const rateLimitWindows = (gateway as unknown as { _rateLimitWindows: Map<string, number[]> })._rateLimitWindows;
    const seedNow = Date.now();
    rateLimitWindows.set("ch-A", Array.from({ length: 60 }, (_, i) => seedNow - i * 100));

    await withNewTrace("chat", async () => {
      const result = await gateway.send({
        taskId: "task-receipts",
        channelId: "ch-A",
        chatId: "chat-rate",
        content: "Should be rate limited",
        messageType: "deliver",
        platform: "email",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("rate_limited");
    });
    const receipts = listReceiptsByTask("task-receipts");
    expect(receipts.some((r) => r.outcome === "failure")).toBe(true);
  });

  it("In-trace mediaUrl-invalid failure → outcome='failure' receipt written", async () => {
    await withNewTrace("chat", async () => {
      const gateway = getOutboundGateway();
      const result = await gateway.send({
        taskId: "task-receipts",
        channelId: "ch-A",
        chatId: "chat-1",
        content: "With bad media",
        messageType: "deliver",
        mediaUrl: "/nonexistent/path/to/file.txt",
        platform: "email",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("does not exist");
    });
    const receipts = listReceiptsByTask("task-receipts");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].outcome).toBe("failure");
  });

  it("In-trace queued_not_delivered → NO receipt (regression guard)", async () => {
    mockSendMessage.mockResolvedValue("queued-msg-1");
    await withNewTrace("chat", async () => {
      const gateway = getOutboundGateway();
      const result = await gateway.send({
        taskId: "task-receipts",
        channelId: "ch-A",
        chatId: "chat-1",
        content: "Queued message",
        messageType: "deliver",
        platform: "email",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("queued_not_delivered");
    });
    const receipts = listReceiptsByTask("task-receipts");
    expect(receipts).toHaveLength(0);
  });

  it("Out-of-trace → no receipt (success path)", async () => {
    mockSendMessage.mockResolvedValue("msg-1");
    const gateway = getOutboundGateway();
    await gateway.send({
      taskId: "task-receipts",
      channelId: "ch-A",
      chatId: "chat-1",
      content: "Hello",
      messageType: "deliver",
      platform: "email",
    });
    const receipts = listReceiptsByTask("task-receipts");
    expect(receipts).toHaveLength(0);
  });

  it("Out-of-trace → no receipt (failure path)", async () => {
    mockSendMessage.mockResolvedValue(null);
    const gateway = getOutboundGateway();
    await gateway.send({
      taskId: "task-receipts",
      channelId: "ch-A",
      chatId: "chat-1",
      content: "Hello",
      messageType: "deliver",
      platform: "email",
    });
    const receipts = listReceiptsByTask("task-receipts");
    expect(receipts).toHaveLength(0);
  });

  it("Webhook success → no receipt", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal("fetch", fetchMock);
    await withNewTrace("chat", async () => {
      const gateway = getOutboundGateway();
      const result = await gateway.send({
        taskId: "task-webhook",
        webhookUrl: "https://example.com/hook",
        content: "Webhook payload",
        messageType: "deliver",
      });
      expect(result.success).toBe(true);
    });
    const receipts = listReceiptsByTask("task-webhook");
    expect(receipts).toHaveLength(0);
  });

  it("actorToolName propagates to receipt", async () => {
    mockSendMessage.mockResolvedValue("msg-1");
    await withNewTrace("chat", async () => {
      const gateway = getOutboundGateway();
      await gateway.send({
        taskId: "task-receipts",
        channelId: "ch-A",
        chatId: "chat-1",
        content: "Hello",
        messageType: "deliver",
        platform: "email",
        actorToolName: "test-tool-x",
      });
    });
    const receipts = listReceiptsByTask("task-receipts");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].actor.toolName).toBe("test-tool-x");
  });

  it("Default actorToolName is 'OutboundGateway.send'", async () => {
    mockSendMessage.mockResolvedValue("msg-1");
    await withNewTrace("chat", async () => {
      const gateway = getOutboundGateway();
      await gateway.send({
        taskId: "task-receipts",
        channelId: "ch-A",
        chatId: "chat-1",
        content: "Hello",
        messageType: "deliver",
        platform: "email",
      });
    });
    const receipts = listReceiptsByTask("task-receipts");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].actor.toolName).toBe("OutboundGateway.send");
  });

  it("dispatch_outbound_batch actorToolName as redelivery discriminator", async () => {
    mockSendMessage.mockResolvedValue("msg-1");
    await withNewTrace("chat", async () => {
      const gateway = getOutboundGateway();
      await gateway.redeliverExecutionTo({
        executionId: "exec-redelivery",
        targets: [{ channelId: "ch-A", chatId: "chat-1" }],
        content: "Redelivered content",
        messageType: "result_delivery",
        actorToolName: "dispatch_outbound_batch",
        sessionId: "session-1",
      });
    });
    const receipts = listReceiptsByTask("exec-redelivery");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].actor.toolName).toBe("dispatch_outbound_batch");
    expect(receipts[0].outcome).toBe("success");
    expect(receipts[0].effectCategory).toBe("outbound_message");
  });

  it("attachmentRefs filters undefined artifactId", async () => {
    mockSendMessage.mockResolvedValue("msg-1");
    await withNewTrace("chat", async () => {
      const gateway = getOutboundGateway();
      await gateway.send({
        taskId: "task-receipts",
        channelId: "ch-A",
        chatId: "chat-1",
        content: "With mixed attachments",
        messageType: "deliver",
        platform: "email",
        attachments: [
          makeAttachment({ artifactId: "art-a" }),
          makeAttachment({ artifactId: "art-b" }),
          makeAttachment({ artifactId: "art-c" }),
          makeAttachment({ artifactId: undefined }),
        ],
      });
    });
    const receipts = listReceiptsByTask("task-receipts");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].payload?.attachmentCount).toBe(4);
    expect(receipts[0].payload?.attachmentRefs ?? []).toHaveLength(3);
  });

  it("Validation error does NOT block delivery", async () => {
    mockSendMessage.mockResolvedValue("msg-1");
    await withNewTrace("chat", async () => {
      const gateway = getOutboundGateway();
      const result = await gateway.send({
        taskId: "task-receipts",
        channelId: "ch-A",
        chatId: "chat-1",
        content: "Should still deliver",
        messageType: "deliver",
        platform: "email",
        actorToolName: "",
      });
      expect(result.success).toBe(true);
    });
    const receipts = listReceiptsByTask("task-receipts");
    expect(receipts).toHaveLength(0);
  });

  it("TemplateExecutor.deliver actorToolName in receipt", async () => {
    mockSendMessage.mockResolvedValue("msg-1");
    await withNewTrace("chat", async () => {
      const gateway = getOutboundGateway();
      await gateway.redeliverExecutionTo({
        executionId: "exec-template-deliver",
        targets: [{ channelId: "ch-A", chatId: "chat-1" }],
        content: "Template execution result",
        messageType: "result_delivery",
        actorToolName: "TemplateExecutor.deliver",
      });
    });
    const receipts = listReceiptsByTask("exec-template-deliver");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].actor.toolName).toBe("TemplateExecutor.deliver");
  });

  it("Multiple deliveries in one trace → multiple receipts", async () => {
    mockSendMessage.mockResolvedValue("msg-multi");
    await withNewTrace("chat", async () => {
      const gateway = getOutboundGateway();
      await gateway.redeliverExecutionTo({
        executionId: "exec-multi",
        targets: [
          { channelId: "ch-A", chatId: "chat-A1" },
          { channelId: "ch-B", chatId: "chat-B1" },
        ],
        content: "Multi-target delivery",
        messageType: "result_delivery",
        actorToolName: "dispatch_outbound_batch",
      });
    });
    const receipts = listReceiptsByTask("exec-multi");
    expect(receipts).toHaveLength(2);
    expect(receipts.every((r) => r.outcome === "success")).toBe(true);
    expect(new Set(receipts.map((r) => r.traceId)).size).toBe(1);
  });
});
