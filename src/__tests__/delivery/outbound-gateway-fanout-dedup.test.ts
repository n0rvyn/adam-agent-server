import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
}));

vi.mock("../../delivery/format.js", () => ({
  formatForChannel: vi.fn((content: string) => content),
}));

vi.mock("../../store/channels.js", () => ({
  getChannel: vi.fn((channelId: string) => ({ id: channelId, name: "WeChat", platform: "wechat", config: {}, viewerKey: "owner" })),
}));

const mockSendMessage = vi.fn();
vi.mock("../../server/routes/channels.js", () => ({
  getChannelManager: vi.fn(() => ({ sendMessage: mockSendMessage })),
}));

import { getOutboundGateway, _resetChannelManagerModuleCache } from "../../delivery/outbound-gateway.js";
import { getDeliveryLogByTask } from "../../store/delivery-log.js";

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
  _resetChannelManagerModuleCache();
  mockSendMessage.mockReset().mockResolvedValue("msg-1");
  const db = getTestDb();
  const now = Date.now();
  db.exec("INSERT INTO tasks (id, status, prompt, config, created_at) VALUES ('task-fanout', 'completed', 'seed', '{}', " + now + ")");
  const gateway = getOutboundGateway();
  (gateway as unknown as { _dedupCache: Map<string, unknown> })._dedupCache.clear();
  (gateway as unknown as { _rateLimitWindows: Map<string, number[]> })._rateLimitWindows.clear();
});

describe("OutboundGateway committed fanout dedup discriminator", () => {
  it("keeps sibling attachment sends distinct while deduping repeat sends for the same discriminator", async () => {
    const gateway = getOutboundGateway();

    const first = await gateway.send({
      taskId: "task-fanout",
      channelId: "wechat-1",
      chatId: "chat-1",
      content: "image",
      messageType: "result_delivery",
      attachments: [{ path: "/tmp/1.png", filename: "1.png", contentType: "image/png" }],
      dedupDiscriminator: "commit-1:0:artifact-1",
    });
    const second = await gateway.send({
      taskId: "task-fanout",
      channelId: "wechat-1",
      chatId: "chat-1",
      content: "image",
      messageType: "result_delivery",
      attachments: [{ path: "/tmp/2.png", filename: "2.png", contentType: "image/png" }],
      dedupDiscriminator: "commit-1:1:artifact-2",
    });
    const repeatFirst = await gateway.send({
      taskId: "task-fanout",
      channelId: "wechat-1",
      chatId: "chat-1",
      content: "image",
      messageType: "result_delivery",
      attachments: [{ path: "/tmp/1.png", filename: "1.png", contentType: "image/png" }],
      dedupDiscriminator: "commit-1:0:artifact-1",
    });

    expect(first.logEntryId).not.toBe(second.logEntryId);
    expect(repeatFirst.logEntryId).toBe(first.logEntryId);
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(getDeliveryLogByTask("task-fanout")).toHaveLength(2);
  });

  it("preserves existing non-fanout dedup behavior", async () => {
    const gateway = getOutboundGateway();
    const first = await gateway.send({
      taskId: "task-fanout",
      channelId: "wechat-1",
      chatId: "chat-1",
      content: "done",
      messageType: "result_delivery",
    });
    const second = await gateway.send({
      taskId: "task-fanout",
      channelId: "wechat-1",
      chatId: "chat-1",
      content: "done again",
      messageType: "result_delivery",
    });

    expect(second.logEntryId).toBe(first.logEntryId);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });
});
