import { describe, expect, it, vi } from "vitest";
import type { DeliveryLogEntry, DeliveryRule } from "../../shared/types.js";

const sendMock = vi.fn(async () => ({ success: true }));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ send: sendMock , redeliverExecutionTo: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("../../store/channels.js", () => ({
  getChannel: () => ({
    id: "mail-1",
    name: "Client Mail",
    platform: "email",
    enabled: true,
    status: "connected",
    config: { address: "Test1@Test.com" },
    createdAt: 1,
    messageCount: 0,
  }),
}));

vi.mock("../../store/delivery-log.js", () => ({
  markDelivered: vi.fn(),
  updateDeliveryLogStatus: vi.fn(),
  createDeliveryLog: vi.fn(),
  getPendingDeliveries: () => [],
  getFailedDeliveries: () => [],
  cleanupExpired: vi.fn(),
  TTL_MS: 86_400_000,
}));

vi.mock("../../store/delivery-rules.js", () => ({
  findMatchingRules: () => [],
}));

vi.mock("../../store/tasks.js", () => ({ getTask: () => undefined }));
vi.mock("../../store/messages.js", () => ({ findMessageByTaskId: () => undefined }));
vi.mock("../../store/sessions.js", () => ({ getSession: () => undefined }));

const { DeliveryEngine } = await import("../../delivery/engine.js");

describe("DeliveryEngine email targets", () => {
  it("sends rule output to Mail channel address when no chatId is present", async () => {
    const engine = new DeliveryEngine();
    await engine.attemptDeliveryPublic(entry(), rule());

    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "mail-1",
      chatId: "test1@test.com",
      content: "result",
    }));
  });
});

function entry(): DeliveryLogEntry {
  return {
    id: "log-1",
    ruleId: "rule-1",
    taskId: "task-1",
    status: "pending",
    target: { type: "channel", channelId: "mail-1" },
    content: "result",
    attempts: 0,
    createdAt: 1,
    expiresAt: 2,
    source: "rule",
  };
}

function rule(): DeliveryRule {
  return {
    id: "rule-1",
    enabled: true,
    eventType: "task_complete",
    matchCriteria: {},
    target: { type: "channel", channelId: "mail-1" },
    maxPerMinute: 60,
    skipOriginChannel: true,
    createdAt: 1,
  };
}
