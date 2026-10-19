import { describe, test, expect, vi, beforeEach, afterAll } from "vitest";
import { setupTestDb, getTestDb, clearTestDb } from "../helpers/test-db.js";
import { _resetChannelManagerModuleCache } from "../../delivery/outbound-gateway.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));

// Mock channel store lookup so getChannel() inside gateway returns truthy
vi.mock("../../store/channels.js", () => ({
  getChannel: () => ({ id: "ch-test", platform: "telegram" }),
}));

// Mock formatForChannel passthrough
vi.mock("../../delivery/format.js", () => ({
  formatForChannel: vi.fn((content: string) => content),
}));

// Mock serverBus to avoid noise
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
}));

// Mock channel manager — capture sendMessage args
const captured: Array<{ channelId: string; chatId: string; message: unknown }> = [];
const mockMgr = {
  sendMessage: vi.fn(async (channelId: string, chatId: string, message: unknown) => {
    captured.push({ channelId, chatId, message });
    return "msg-id-fake";
  }),
};
vi.mock("../../server/routes/channels.js", () => ({
  getChannelManager: () => mockMgr,
}));

afterAll(() => cleanup());

describe("OutboundGateway plumbs replyToMessageId + quoteExcerpt + quoteTitle to adapter (Task 2)", () => {
  beforeEach(() => {
    _resetChannelManagerModuleCache();  // critical: prevents cached module ref bypass when test runs after another gateway test
    clearTestDb();
    captured.length = 0;
    mockMgr.sendMessage.mockClear();
  });

  test("all 3 quote fields flow into mgr.sendMessage payload", async () => {
    const { OutboundGateway } = await import("../../delivery/outbound-gateway.js");
    const gateway = new OutboundGateway();
    await gateway.send({
      channelId: "ch-test",
      chatId: "chat-1",
      content: "Approve?",
      messageType: "result_delivery",
      replyToMessageId: "parent-msg-id",
      quoteExcerpt: "excerpt text",
      quoteTitle: "thread title",
    });
    expect(captured).toHaveLength(1);
    const payload = captured[0].message as { replyToMessageId?: string; quoteExcerpt?: string; quoteTitle?: string };
    expect(payload.replyToMessageId).toBe("parent-msg-id");
    expect(payload.quoteExcerpt).toBe("excerpt text");
    expect(payload.quoteTitle).toBe("thread title");
  });

  test("absent quote fields are NOT spread into payload (regression)", async () => {
    const { OutboundGateway } = await import("../../delivery/outbound-gateway.js");
    const gateway = new OutboundGateway();
    await gateway.send({
      channelId: "ch-test",
      chatId: "chat-2",
      content: "plain",
      messageType: "result_delivery",
    });
    const payload = captured[0].message as Record<string, unknown>;
    expect(payload.replyToMessageId).toBeUndefined();
    expect(payload.quoteExcerpt).toBeUndefined();
    expect(payload.quoteTitle).toBeUndefined();
  });
});
