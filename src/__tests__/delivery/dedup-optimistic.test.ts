/**
 * Tests for optimistic dedup cache behavior in OutboundGateway.
 * Verifies: pre-send cache write, cache cleanup on failure, concurrent send dedup.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));

const emittedEvents: Array<{ type: string; [key: string]: unknown }> = [];
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: (event: { type: string; [key: string]: unknown }) => { emittedEvents.push(event); },
  },
}));

vi.mock("../../delivery/format.js", () => ({
  formatForChannel: vi.fn((content: string) => content),
}));

vi.mock("../../store/channels.js", () => ({
  getChannel: vi.fn(() => ({ id: "ch-1", platform: "wechat" })),
}));

const mockSendMessage = vi.fn();
vi.mock("../../server/routes/channels.js", () => ({
  getChannelManager: vi.fn(() => ({ sendMessage: mockSendMessage })),
}));

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
  const db = getTestDb();
  const now = Date.now();
  for (const id of ["task-dedup-1", "task-dedup-2", "task-dedup-fail"]) {
    db.prepare("INSERT INTO tasks (id, status, prompt, config, created_at) VALUES (?, 'pending', 'test', '{}', ?)").run(id, now);
  }
  emittedEvents.length = 0;
  mockSendMessage.mockReset().mockResolvedValue("msg-ok");

  const gateway = getOutboundGateway();
  (gateway as unknown as { _dedupCache: Map<string, unknown> })._dedupCache.clear();
  (gateway as unknown as { _rateLimitWindows: Map<string, number[]> })._rateLimitWindows.clear();
  (gateway as unknown as { _recentlySentIds: Set<string> })._recentlySentIds.clear();
});

import { getOutboundGateway } from "../../delivery/outbound-gateway.js";

describe("OutboundGateway optimistic dedup", () => {
  it("claims dedup key before sending — concurrent sends are deduplicated", async () => {
    const gateway = getOutboundGateway();

    // Simulate concurrent sends by making the first send slow
    let resolveFirst: (value: string) => void;
    const firstSendPromise = new Promise<string>((resolve) => { resolveFirst = resolve; });
    mockSendMessage.mockImplementationOnce(async () => {
      await firstSendPromise;
      return "msg-1";
    }).mockResolvedValueOnce("msg-2");

    const opts = {
      taskId: "task-dedup-1",
      channelId: "ch-1",
      chatId: "chat-1",
      content: "hello",
      messageType: "deliver" as const,
    };

    // Fire both sends concurrently
    const p1 = gateway.send(opts);
    const p2 = gateway.send(opts);

    // Second send should hit dedup immediately (optimistic cache from first)
    const result2 = await p2;
    expect(result2.success).toBe(true);

    // Now let first send complete
    resolveFirst!("msg-1");
    const result1 = await p1;
    expect(result1.success).toBe(true);

    // Only 1 actual channel send
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it("clears dedup cache on send failure — allows retry", async () => {
    const gateway = getOutboundGateway();
    mockSendMessage.mockRejectedValueOnce(new Error("Network error"));

    const opts = {
      taskId: "task-dedup-fail",
      channelId: "ch-1",
      chatId: "chat-1",
      content: "hello",
      messageType: "deliver" as const,
    };

    const result1 = await gateway.send(opts);
    expect(result1.success).toBe(false);

    // After failure, dedup cache should be cleared — retry should succeed
    mockSendMessage.mockResolvedValueOnce("msg-retry");
    const result2 = await gateway.send(opts);
    expect(result2.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not dedup when taskId is missing", async () => {
    const gateway = getOutboundGateway();
    const opts = {
      channelId: "ch-1",
      chatId: "chat-1",
      content: "hello",
      messageType: "report" as const,
    };

    await gateway.send(opts);
    await gateway.send(opts);
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not dedup reply messageType even with taskId", async () => {
    const gateway = getOutboundGateway();
    const opts = {
      taskId: "task-dedup-1",
      channelId: "ch-1",
      chatId: "chat-1",
      content: "hello",
      messageType: "reply" as const,
    };

    await gateway.send(opts);
    await gateway.send(opts);
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it("different messageTypes are not cross-deduplicated", async () => {
    const gateway = getOutboundGateway();
    const base = {
      taskId: "task-dedup-2",
      channelId: "ch-1",
      chatId: "chat-1",
      content: "hello",
    };

    await gateway.send({ ...base, messageType: "report" });
    await gateway.send({ ...base, messageType: "deliver" });
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });
});
