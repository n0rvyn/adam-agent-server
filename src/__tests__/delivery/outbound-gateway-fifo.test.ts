import { describe, test, expect, beforeEach, afterAll, vi } from "vitest";
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
  getChannel: vi.fn((id: string) => ({ id, platform: "test" })),
}));

const mockSendMessage = vi.fn();
const mockChannelManager = { sendMessage: mockSendMessage };
vi.mock("../../server/routes/channels.js", () => ({
  getChannelManager: () => mockChannelManager,
}));

afterAll(() => cleanup());

import { OutboundGateway } from "../../delivery/outbound-gateway.js";

describe("OutboundGateway per-(channelId, chatId) FIFO mutex", () => {
  let gateway: OutboundGateway;
  let sendCallOrder: Array<{ channelId: string; chatId: string; content: string; t: number }>;

  beforeEach(() => {
    clearTestDb();
    sendCallOrder = [];
    mockSendMessage.mockReset();
    mockSendMessage.mockImplementation(async (channelId: string, chatId: string, message: { content: string }) => {
      sendCallOrder.push({ channelId, chatId, content: message.content, t: Date.now() });
      await new Promise((r) => setTimeout(r, 30));
      return `mid-${sendCallOrder.length}`;
    });
    gateway = new OutboundGateway();
  });

  test("3 concurrent sends to same (channelId, chatId) serialize in call order", async () => {
    const ch = "ch-A";
    const chat = "chat-1";

    const p1 = gateway.send({ channelId: ch, chatId: chat, content: "msg-1", messageType: "reply" });
    const p2 = gateway.send({ channelId: ch, chatId: chat, content: "msg-2", messageType: "reply" });
    const p3 = gateway.send({ channelId: ch, chatId: chat, content: "msg-3", messageType: "reply" });

    await Promise.all([p1, p2, p3]);

    expect(sendCallOrder.map((c) => c.content)).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect(sendCallOrder[1].t - sendCallOrder[0].t).toBeGreaterThanOrEqual(25);
    expect(sendCallOrder[2].t - sendCallOrder[1].t).toBeGreaterThanOrEqual(25);
  });

  test("concurrent sends to DIFFERENT (channelId, chatId) run in parallel", async () => {
    const p1 = gateway.send({ channelId: "ch-A", chatId: "chat-1", content: "A1", messageType: "reply" });
    const p2 = gateway.send({ channelId: "ch-A", chatId: "chat-2", content: "A2", messageType: "reply" });
    const p3 = gateway.send({ channelId: "ch-B", chatId: "chat-1", content: "B1", messageType: "reply" });

    const start = Date.now();
    await Promise.all([p1, p2, p3]);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(70);
  });

  test("error in adapter releases lane — next send proceeds", async () => {
    // Use mockImplementationOnce so the override still pushes to sendCallOrder
    // (mockRejectedValueOnce/mockResolvedValueOnce bypass the default impl).
    mockSendMessage
      .mockImplementationOnce(async (channelId: string, chatId: string, message: { content: string }) => {
        sendCallOrder.push({ channelId, chatId, content: message.content, t: Date.now() });
        throw new Error("adapter boom");
      })
      .mockImplementationOnce(async (channelId: string, chatId: string, message: { content: string }) => {
        sendCallOrder.push({ channelId, chatId, content: message.content, t: Date.now() });
        return "mid-2";
      });

    const p1 = gateway.send({ channelId: "ch-A", chatId: "chat-1", content: "fail", messageType: "reply" });
    const p2 = gateway.send({ channelId: "ch-A", chatId: "chat-1", content: "ok", messageType: "reply" });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.success).toBe(false);
    expect(r2.success).toBe(true);
    expect(sendCallOrder.map((c) => c.content)).toEqual(["fail", "ok"]);
  });

  test("lane map doesn't grow unboundedly across many distinct chats", async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        gateway.send({ channelId: `ch-${i}`, chatId: `c-${i}`, content: `m-${i}`, messageType: "reply" })
      )
    );
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const lanes = (gateway as unknown as { _laneTails: Map<string, unknown> })._laneTails;
    expect(lanes.size).toBeLessThanOrEqual(2);
  });
});
