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
  getChannelManager: vi.fn(() => mockChannelManager),
}));

afterAll(() => cleanup());

import { OutboundGateway } from "../../delivery/outbound-gateway.js";

describe("UX-005: per-(channelId, chatId) FIFO across concurrent task envelopes", () => {
  let gateway: OutboundGateway;
  let arrivedAt: Array<{ taskId: string; messageType: string; t: number }>;

  beforeEach(() => {
    clearTestDb();
    arrivedAt = [];
    mockSendMessage.mockReset();
    // Default impl — captures task tag from content prefix ("T-1:..."),
    // delays 25ms so ordering is observable, returns synthetic messageId.
    mockSendMessage.mockImplementation(async (_ch: string, _chat: string, payload: { content: string; messageType?: string }) => {
      arrivedAt.push({
        taskId: payload.content.split(":")[0],
        messageType: payload.messageType ?? "",
        t: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 25));
      return `mid-${arrivedAt.length}`;
    });
    gateway = new OutboundGateway();
  });

  test("ux-005-fifo-same-lane-construction-order: 3 concurrent tasks -> result_delivery to same (channelId, chatId) arrive in construction order", async () => {
    // Simulate 3 tasks completing concurrently, each sending result_delivery
    const ch = "ch-X";
    const chat = "chat-shared";

    const p1 = gateway.send({ taskId: "T-1", channelId: ch, chatId: chat, content: "T-1:result", messageType: "result_delivery" });
    const p2 = gateway.send({ taskId: "T-2", channelId: ch, chatId: chat, content: "T-2:result", messageType: "result_delivery" });
    const p3 = gateway.send({ taskId: "T-3", channelId: ch, chatId: chat, content: "T-3:result", messageType: "result_delivery" });

    await Promise.all([p1, p2, p3]);

    expect(arrivedAt.map((a) => a.taskId)).toEqual(["T-1", "T-2", "T-3"]);
    // All 3 messageType reached adapter as 'result_delivery' (no translation needed, already envelope kind)
    expect(arrivedAt.every((a) => a.messageType === "result_delivery")).toBe(true);
  });

  test("legacy 'report' messageType — 3 concurrent -> arrive in order, all translated to 'status_report'", async () => {
    const ch = "ch-Y";
    const chat = "chat-legacy";

    const p1 = gateway.send({ taskId: "L-1", channelId: ch, chatId: chat, content: "L-1:report", messageType: "report" });
    const p2 = gateway.send({ taskId: "L-2", channelId: ch, chatId: chat, content: "L-2:report", messageType: "report" });
    const p3 = gateway.send({ taskId: "L-3", channelId: ch, chatId: chat, content: "L-3:report", messageType: "report" });

    await Promise.all([p1, p2, p3]);

    expect(arrivedAt.map((a) => a.taskId)).toEqual(["L-1", "L-2", "L-3"]);
    // All 3 translated to status_report at adapter
    expect(arrivedAt.every((a) => a.messageType === "status_report")).toBe(true);
  });

  test("mixed envelope kind + legacy on same lane -> ordering preserved across kind types", async () => {
    const ch = "ch-Z";
    const chat = "chat-mix";

    const p1 = gateway.send({ taskId: "M-1", channelId: ch, chatId: chat, content: "M-1:status", messageType: "status_report" });
    const p2 = gateway.send({ taskId: "M-2", channelId: ch, chatId: chat, content: "M-2:legacy", messageType: "deliver" });
    const p3 = gateway.send({ taskId: "M-3", channelId: ch, chatId: chat, content: "M-3:envelope", messageType: "result_delivery" });

    await Promise.all([p1, p2, p3]);

    expect(arrivedAt.map((a) => a.taskId)).toEqual(["M-1", "M-2", "M-3"]);
    // Translated values
    expect(arrivedAt.map((a) => a.messageType)).toEqual(["status_report", "result_delivery", "result_delivery"]);
  });

  test("different (channelId, chatId) lanes -> can complete in any order based on adapter delay", async () => {
    // Different chats run independently
    const aDelay = 50, bDelay = 10;
    mockSendMessage.mockImplementation(async (ch: string, _chat: string, payload: { content: string; messageType?: string }) => {
      const delay = ch === "ch-A" ? aDelay : bDelay;
      arrivedAt.push({ taskId: payload.content.split(":")[0], messageType: payload.messageType ?? "", t: Date.now() });
      await new Promise((r) => setTimeout(r, delay));
      return `mid-${arrivedAt.length}`;
    });

    const pA = gateway.send({ taskId: "A-1", channelId: "ch-A", chatId: "c", content: "A-1:slow", messageType: "result_delivery" });
    const pB = gateway.send({ taskId: "B-1", channelId: "ch-B", chatId: "c", content: "B-1:fast", messageType: "result_delivery" });

    await Promise.all([pA, pB]);

    // Both arrive close in time at adapter (parallel lanes), B may arrive first if slot scheduling lucky
    // Just assert both arrived
    expect(arrivedAt.map((a) => a.taskId).sort()).toEqual(["A-1", "B-1"]);
  });
});
