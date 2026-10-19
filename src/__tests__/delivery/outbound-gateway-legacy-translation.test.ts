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
import { getDeliveryLogByTask } from "../../store/delivery-log.js";

describe("OutboundGateway legacy MessageType translation", () => {
  let gateway: OutboundGateway;
  let sentPayloads: Array<{ messageType: string }>;

  beforeEach(() => {
    clearTestDb();
    sentPayloads = [];
    mockSendMessage.mockReset();
    mockSendMessage.mockImplementation(async (_chId: string, _chatId: string, payload: { messageType?: string }) => {
      sentPayloads.push({ messageType: payload.messageType ?? "" });
      return "mid-1";
    });
    gateway = new OutboundGateway();
  });

  test("back-compat-legacy-report-to-status-report: 'report' translates to 'status_report'", async () => {
    await gateway.send({ taskId: "t-1", channelId: "ch", chatId: "c", content: "x", messageType: "report" });
    expect(sentPayloads[0].messageType).toBe("status_report");
    const logs = getDeliveryLogByTask("t-1");
    expect(logs[0].messageType).toBe("status_report");
  });

  test("back-compat-legacy-deliver-to-result-delivery: 'deliver' translates to 'result_delivery'", async () => {
    await gateway.send({ taskId: "t-2", channelId: "ch", chatId: "c", content: "x", messageType: "deliver" });
    expect(sentPayloads[0].messageType).toBe("result_delivery");
    const logs = getDeliveryLogByTask("t-2");
    expect(logs[0].messageType).toBe("result_delivery");
  });

  test("'reply' passes through unchanged", async () => {
    await gateway.send({ channelId: "ch", chatId: "c", content: "x", messageType: "reply" });
    expect(sentPayloads[0].messageType).toBe("reply");
  });

  test("'approval' passes through unchanged", async () => {
    await gateway.send({ taskId: "t-3", channelId: "ch", chatId: "c", content: "x", messageType: "approval" });
    expect(sentPayloads[0].messageType).toBe("approval");
  });

  test("envelope kind 'status_report' passes through unchanged", async () => {
    await gateway.send({ taskId: "t-4", channelId: "ch", chatId: "c", content: "x", messageType: "status_report" });
    expect(sentPayloads[0].messageType).toBe("status_report");
  });

  test("custom tag 'mistake_digest' passes through unchanged", async () => {
    await gateway.send({ taskId: "t-5", channelId: "ch", chatId: "c", content: "x", messageType: "mistake_digest" });
    expect(sentPayloads[0].messageType).toBe("mistake_digest");
  });

  test("prefix-tagged 'deliver:artifact:xyz' passes through unchanged (prefix not translated)", async () => {
    await gateway.send({ taskId: "t-6", channelId: "ch", chatId: "c", content: "x", messageType: "deliver:artifact:xyz" });
    expect(sentPayloads[0].messageType).toBe("deliver:artifact:xyz");
  });

  test("dedup key uses translated value — 'report' twice with same task -> second is dedup hit", async () => {
    const r1 = await gateway.send({ taskId: "t-dup", channelId: "ch", chatId: "c", content: "x", messageType: "report" });
    const r2 = await gateway.send({ taskId: "t-dup", channelId: "ch", chatId: "c", content: "x2", messageType: "report" });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    // Same task + same channel + same translated kind -> dedup
    expect(r2.logEntryId).toBe(r1.logEntryId);
    expect(sentPayloads.length).toBe(1);
  });

  test("dedup key consistency — 'report' and 'status_report' on same task collapse to one send", async () => {
    const r1 = await gateway.send({ taskId: "t-mix", channelId: "ch", chatId: "c", content: "x", messageType: "report" });
    const r2 = await gateway.send({ taskId: "t-mix", channelId: "ch", chatId: "c", content: "x2", messageType: "status_report" });
    expect(r2.logEntryId).toBe(r1.logEntryId); // dedup hit (both -> 'status_report' key)
    expect(sentPayloads.length).toBe(1);
  });
});

describe("buildEmailSubject envelope-kind awareness (D-A4)", () => {
  test("legacy 'report' -> [Adam Report]", async () => {
    const { buildEmailSubject } = await import("../../channels/adapters/email/email-renderer.js");
    expect(buildEmailSubject({ prefix: "Adam", messageType: "report" })).toBe("[Adam Report]");
  });

  test("envelope kind 'status_report' -> [Adam Report]", async () => {
    const { buildEmailSubject } = await import("../../channels/adapters/email/email-renderer.js");
    expect(buildEmailSubject({ prefix: "Adam", messageType: "status_report" })).toBe("[Adam Report]");
  });

  test("legacy 'deliver' -> [Adam Deliver]", async () => {
    const { buildEmailSubject } = await import("../../channels/adapters/email/email-renderer.js");
    expect(buildEmailSubject({ prefix: "Adam", messageType: "deliver" })).toBe("[Adam Deliver]");
  });

  test("envelope kind 'result_delivery' -> [Adam Deliver]", async () => {
    const { buildEmailSubject } = await import("../../channels/adapters/email/email-renderer.js");
    expect(buildEmailSubject({ prefix: "Adam", messageType: "result_delivery" })).toBe("[Adam Deliver]");
  });

  test("unrecognized 'reply' -> fallback [Adam]", async () => {
    const { buildEmailSubject } = await import("../../channels/adapters/email/email-renderer.js");
    expect(buildEmailSubject({ prefix: "Adam", messageType: "reply" })).toBe("[Adam]");
  });
});
