import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
const mockGatewaySend = vi.fn().mockResolvedValue({ success: true, logEntryId: "gw-log" });

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined),
    send: mockGatewaySend,
  }),
}));

import { DeliveryEngine, stopDeliveryEngine } from "../../delivery/engine.js";
import { createDeliveryRule } from "../../store/delivery-rules.js";
import { getDeliveryLogByTask } from "../../store/delivery-log.js";
import { createTask } from "../../store/tasks.js";
import { serverBus } from "../../server/events/server-bus.js";
import type { DeliveryRule } from "../../shared/types.js";

beforeAll(() => {
  new DeliveryEngine();
});

beforeEach(() => {
  clearTestDb();
  mockGatewaySend.mockClear();
});

afterAll(() => {
  stopDeliveryEngine();
  cleanup();
});

function makeRule(overrides: Partial<DeliveryRule> = {}): DeliveryRule {
  return {
    id: "rule-broad",
    eventType: "task_complete",
    matchCriteria: {},
    target: { type: "webhook", webhookUrl: "https://example.com/hook" },
    maxPerMinute: 10,
    skipOriginChannel: false,
    enabled: true,
    createdAt: Date.now(),
    ...overrides,
  };
}

function seedTask(id: string, overrides: Record<string, unknown> = {}): void {
  createTask({
    id,
    status: "completed",
    prompt: "done",
    result: "result",
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
    createdAt: Date.now(),
    completedAt: Date.now(),
    ...overrides,
  });
}

describe("TemplateExecution step delivery isolation", () => {
  it("does not create delivery logs for internal TemplateExecution step tasks", async () => {
    createDeliveryRule(makeRule());
    seedTask("task-template-step", {
      parentId: "exec-1",
      templateId: "tmpl-1",
      stepId: "polish",
    });

    serverBus.emit({
      type: "task_status_change",
      taskId: "task-template-step",
      oldStatus: "running",
      newStatus: "completed",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getDeliveryLogByTask("task-template-step")).toEqual([]);
    expect(mockGatewaySend).not.toHaveBeenCalled();
  });

  it("still delivers normal ad-hoc tasks matched by broad task_complete rules", async () => {
    createDeliveryRule(makeRule({ id: "rule-normal" }));
    seedTask("task-normal");

    serverBus.emit({
      type: "task_status_change",
      taskId: "task-normal",
      oldStatus: "running",
      newStatus: "completed",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getDeliveryLogByTask("task-normal")).toHaveLength(1);
    expect(mockGatewaySend).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-normal",
        webhookUrl: "https://example.com/hook",
        content: "result",
      }),
    );
  });
});
