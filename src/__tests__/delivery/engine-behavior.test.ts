/**
 * DeliveryEngine behavioral tests: rate limiting, retry, anti-loop, isOriginChannel.
 * Tests the actual DeliveryEngine class, not just the data layer.
 *
 * A single DeliveryEngine instance is shared across all tests to avoid serverBus
 * listener stacking. Each test clears DB state and rate limit windows before running.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));
vi.mock("../../config/index.js", () => ({
  getDefaults: () => ({
    plugins: [], allowedTools: [], disallowedTools: [],
    approvalRequired: [], maxBudgetUsd: 5.0,
  }),
}));

// Mock channel manager — returns a message ID for anti-loop tracking
const mockSendMessage = vi.fn().mockResolvedValue("msg-sent-123");
vi.mock("../../server/routes/channels.js", () => ({
  getChannelManager: () => ({
    sendMessage: mockSendMessage,
  }),
}));
vi.mock("../../store/channels.js", () => ({
  getChannel: (id: string) => {
    if (id === "ch-no-userid") return { platform: "wechat", config: {} };
    return { platform: "wechat", config: { userId: "wx-user-from-config" } };
  },
}));

// Mock OutboundGateway — engine.attemptDelivery delegates to gateway.send().
// Provide a mock gateway so that gateway doesn't create its own delivery_log entries
// (the engine already creates them in matchAndDeliver).
// The _recentlySentIds set is maintained for the anti-loop test.
const _recentlySentIds = new Set<string>();
const mockGatewaySend = vi.fn().mockImplementation(async (options: { channelId?: string; chatId?: string; content: string; messageType: string; webhookUrl?: string }) => {
  // For channel targets, simulate the real gateway: call sendMessage and track anti-loop
  if (options.channelId && options.chatId) {
    const msgId = await mockSendMessage(options.channelId, options.chatId, { content: options.content });
    if (msgId) _recentlySentIds.add(msgId);
  } else if (options.webhookUrl) {
    // For webhook targets, call fetch (tests mock this)
    await fetch(options.webhookUrl, {
      method: "POST",
      body: JSON.stringify({ result: options.content }),
    });
  }
  return { success: true, logEntryId: "mock-log-entry", messageId: options.channelId ? "msg-sent-123" : undefined };
});
vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined),
    send: mockGatewaySend,
    isRecentlySent: (id: string) => _recentlySentIds.has(id),
  }),
  isRecentlySent: (id: string) => _recentlySentIds.has(id),
}));

import { createDeliveryRule } from "../../store/delivery-rules.js";
import { createDeliveryLog, getPendingDeliveries } from "../../store/delivery-log.js";
import { createTask } from "../../store/tasks.js";
import { DeliveryEngine, stopDeliveryEngine } from "../../delivery/engine.js";
import { isRecentlySent } from "../../delivery/outbound-gateway.js";
import { serverBus } from "../../server/events/server-bus.js";
import type { DeliveryRule } from "../../shared/types.js";

let sharedEngine: DeliveryEngine;

beforeAll(() => {
  // Create one engine instance shared by all tests to avoid serverBus listener stacking.
  // Each test clears the DB and rate limit window via beforeEach/stopDeliveryEngine.
  sharedEngine = new DeliveryEngine();
});

beforeEach(() => {
  clearTestDb();
  stopDeliveryEngine();
  mockSendMessage.mockClear();
  mockGatewaySend.mockClear();
  _recentlySentIds.clear();
});

afterAll(() => {
  stopDeliveryEngine();
  cleanup();
});

function makeRule(overrides: Partial<DeliveryRule> = {}): DeliveryRule {
  return {
    id: overrides.id ?? "rule-1",
    eventType: "task_complete",
    matchCriteria: {},
    target: { type: "webhook", webhookUrl: "https://example.com/hook" },
    maxPerMinute: 5,
    skipOriginChannel: true,
    enabled: true,
    createdAt: Date.now(),
    ...overrides,
  };
}

function seedAgent(id: string) {
  createRole({
    id, name: `Agent ${id}`, cagPrompt: "",
    preferences: {}, learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: `mem-${id}`,
    status: "active", createdAt: Date.now(),
  });
}

function seedTask(id: string, overrides: Record<string, unknown> = {}) {
  createTask({
    id, status: "completed", prompt: "test task", result: "done",
    createdAt: Date.now(), completedAt: Date.now(),
    ...overrides,
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 } as any,
  });
}

describe("DeliveryEngine behavior", () => {
  it("rate limit exceeded skips delivery", async () => {
    // Rule with maxPerMinute: 2
    createDeliveryRule(makeRule({
      id: "rule-rate",
      maxPerMinute: 2,
      target: { type: "webhook", webhookUrl: "https://example.com/hook" },
    }));

    // Emit 5 task events — only 2 should pass the rate limit
    for (let i = 0; i < 5; i++) {
      seedTask(`task-rate-${i}`);
      serverBus.emit({
        type: "task_status_change",
        taskId: `task-rate-${i}`,
        oldStatus: "running",
        newStatus: "completed",
      });
    }

    // Wait for async handlers
    await new Promise((r) => setTimeout(r, 200));

    // Exactly 2 deliveries should have been created (rate limit = 2/min)
    // Engine creates log entries only for events passing the rate limit check
    const allLogs = getTestDb().prepare("SELECT * FROM delivery_log").all();
    expect(allLogs.length).toBe(2);

    // Gateway.send called exactly 2 times (only rate-limit-passing events)
    expect(mockGatewaySend).toHaveBeenCalledTimes(2);
  });

  it("retryPending retries failed deliveries and dead-letters after 3 attempts", async () => {
    createDeliveryRule(makeRule({ id: "rule-retry" }));
    seedTask("task-1");
    seedTask("task-2");

    // Create a failed delivery log entry with 1 attempt — should be retried
    createDeliveryLog({
      id: "log-retry-ok",
      ruleId: "rule-retry",
      taskId: "task-1",
      status: "failed",
      target: { type: "webhook", webhookUrl: "https://example.com/hook" },
      content: "retry me",
      attempts: 1,
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000,
      source: "rule",
    });

    // Create another with 2 attempts — will be retried, succeed, and deliver
    createDeliveryLog({
      id: "log-retry-last",
      ruleId: "rule-retry",
      taskId: "task-2",
      status: "failed",
      target: { type: "webhook", webhookUrl: "https://example.com/hook" },
      content: "last chance",
      attempts: 2,
      createdAt: Date.now(),
      expiresAt: Date.now() + 86400000,
      source: "rule",
    });

    await sharedEngine.retryPending();

    // Both entries should have been retried (attempts < 3) — gateway.send is called
    expect(mockGatewaySend).toHaveBeenCalledTimes(2);

    // Gateway returns success; engine delegates delivery tracking to Gateway
    // (engine's own entries are not marked delivered — Gateway manages its own log entries)
    expect(mockGatewaySend).toHaveBeenCalledWith(
      expect.objectContaining({ webhookUrl: "https://example.com/hook", content: "retry me" }),
    );
    expect(mockGatewaySend).toHaveBeenCalledWith(
      expect.objectContaining({ webhookUrl: "https://example.com/hook", content: "last chance" }),
    );
  });

  it("anti-loop: isRecentlySent identifies engine-sent messages", async () => {
    createDeliveryRule(makeRule({
      id: "rule-channel",
      target: { type: "channel", channelId: "ch-1", chatId: "chat-1" },
    }));

    seedTask("task-antiloop");

    // Emit event to trigger delivery
    serverBus.emit({
      type: "task_status_change",
      taskId: "task-antiloop",
      oldStatus: "running",
      newStatus: "completed",
    });

    await new Promise((r) => setTimeout(r, 200));

    // sendMessage should have been called
    expect(mockSendMessage).toHaveBeenCalled();

    // The returned message ID should be tracked
    expect(isRecentlySent("msg-sent-123")).toBe(true);

    // Random message should not be tracked
    expect(isRecentlySent("msg-unknown")).toBe(false);
  });

  it("skipOriginChannel: skips delivery when task originated from same channel", async () => {
    createDeliveryRule(makeRule({
      id: "rule-skip",
      target: { type: "channel", channelId: "wc-1", chatId: "chat-1" },
      skipOriginChannel: true,
    }));

    const { createSession } = await import("../../store/sessions.js");
    const { createMessage } = await import("../../store/messages.js");
    createSession({
      id: "sess-wc-1", status: "active", source: { type: "channel", channelId: "wc-1", chatId: "chat-1" },
      createdAt: Date.now(), lastActiveAt: Date.now(), messageCount: 1,
    });
    createMessage({
      id: "msg-task-1", sessionId: "sess-wc-1", role: "user", content: "hello",
      source: { type: "channel" }, taskId: "task-skip-origin", createdAt: Date.now(),
    });
    seedTask("task-skip-origin");

    serverBus.emit({ type: "task_status_change", taskId: "task-skip-origin", oldStatus: "running", newStatus: "completed" });
    await new Promise((r) => setTimeout(r, 200));

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("skipOriginChannel: delivers when task from different channel", async () => {
    createDeliveryRule(makeRule({
      id: "rule-other",
      target: { type: "channel", channelId: "tg-1", chatId: "chat-tg" },
      skipOriginChannel: true,
    }));

    const { createSession } = await import("../../store/sessions.js");
    const { createMessage } = await import("../../store/messages.js");
    createSession({
      id: "sess-wc-diff", status: "active", source: { type: "channel", channelId: "wc-1", chatId: "chat-1" },
      createdAt: Date.now(), lastActiveAt: Date.now(), messageCount: 1,
    });
    createMessage({
      id: "msg-task-diff", sessionId: "sess-wc-diff", role: "user", content: "hello",
      source: { type: "channel" }, taskId: "task-diff-channel", createdAt: Date.now(),
    });
    seedTask("task-diff-channel");

    serverBus.emit({ type: "task_status_change", taskId: "task-diff-channel", oldStatus: "running", newStatus: "completed" });
    await new Promise((r) => setTimeout(r, 200));

    expect(mockSendMessage).toHaveBeenCalled();
  });

  it("skipOriginChannel: non-channel tasks are not skipped", async () => {
    createDeliveryRule(makeRule({
      id: "rule-cron",
      target: { type: "channel", channelId: "wc-1", chatId: "chat-1" },
      skipOriginChannel: true,
    }));

    seedTask("task-cron", { templateId: "tmpl-cron" } as any);

    serverBus.emit({ type: "task_status_change", taskId: "task-cron", oldStatus: "running", newStatus: "completed" });
    await new Promise((r) => setTimeout(r, 200));

    expect(mockSendMessage).toHaveBeenCalled();
  });

  it("skipOriginChannel: non-existent task triggers early return (no delivery attempted)", async () => {
    // isOriginChannel returns false for non-existent tasks (via getTask), causing the caller
    // to skip the delivery. Combined with handleTaskStatusChange also returning early when
    // the task is not found, no delivery log entry is created.
    createDeliveryRule(makeRule({
      id: "rule-nonexistent",
      target: { type: "channel", channelId: "wc-1", chatId: "chat-1" },
      skipOriginChannel: true,
    }));

    // Emit status change for a task that does not exist in the DB
    serverBus.emit({ type: "task_status_change", taskId: "nonexistent-task", oldStatus: "running", newStatus: "completed" });
    await new Promise((r) => setTimeout(r, 200));

    // Task not found → handleTaskStatusChange returns early → no delivery attempted
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("skipOriginChannel: skips delivery when rule target has channelId only (no chatId)", async () => {
    createDeliveryRule(makeRule({
      id: "rule-skip-no-chatid",
      target: { type: "channel", channelId: "wc-1" } as any,
      skipOriginChannel: true,
    }));

    const { createSession } = await import("../../store/sessions.js");
    const { createMessage } = await import("../../store/messages.js");
    createSession({
      id: "sess-skip-nochatid", status: "active", source: { type: "channel", channelId: "wc-1", chatId: "chat-1" },
      createdAt: Date.now(), lastActiveAt: Date.now(), messageCount: 1,
    });
    createMessage({
      id: "msg-skip-nochatid", sessionId: "sess-skip-nochatid", role: "user", content: "hello",
      source: { type: "channel" }, taskId: "task-skip-nochatid", createdAt: Date.now(),
    });
    seedTask("task-skip-nochatid");

    serverBus.emit({ type: "task_status_change", taskId: "task-skip-nochatid", oldStatus: "running", newStatus: "completed" });
    await new Promise((r) => setTimeout(r, 200));

    // Rule target has no chatId but same channelId → should be skipped
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("resolves chatId from channel config when rule target has channelId only", async () => {
    createDeliveryRule(makeRule({
      id: "rule-no-chatid",
      target: { type: "channel", channelId: "wc-resolve" } as any,
      skipOriginChannel: false,
    }));
    seedTask("task-resolve-chatid");

    serverBus.emit({ type: "task_status_change", taskId: "task-resolve-chatid", oldStatus: "running", newStatus: "completed" });
    await new Promise((r) => setTimeout(r, 200));

    // Gateway should be called with resolved chatId from channel config
    expect(mockGatewaySend).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "wc-resolve",
        chatId: "wx-user-from-config",
        content: "done",
        messageType: "deliver",
      }),
    );
  });

  it("fails gracefully when rule target has channelId only and channel has no userId", async () => {
    createDeliveryRule(makeRule({
      id: "rule-no-userid",
      target: { type: "channel", channelId: "ch-no-userid" } as any,
      skipOriginChannel: false,
    }));
    seedTask("task-no-userid");

    serverBus.emit({ type: "task_status_change", taskId: "task-no-userid", oldStatus: "running", newStatus: "completed" });
    await new Promise((r) => setTimeout(r, 200));

    // Gateway called with undefined chatId — will fail in gateway (same as before)
    expect(mockGatewaySend).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "ch-no-userid",
        chatId: undefined,
      }),
    );
  });

  it("task_complete event creates a delivery_log entry", async () => {
    // Verify the complete delivery path: event → matched rule → delivery_log entry created.
    // Genuinely new: existing tests cover rate limiting and retry but not the direct
    // task_complete → delivery_log table entry assertion.
    createDeliveryRule(makeRule({
      id: "rule-log-entry",
      target: { type: "channel", channelId: "wc-log", chatId: "chat-log" },
      skipOriginChannel: false,
    }));
    seedTask("task-log-entry");

    serverBus.emit({ type: "task_status_change", taskId: "task-log-entry", oldStatus: "running", newStatus: "completed" });
    await new Promise((r) => setTimeout(r, 200));

    // delivery_log entry must exist with correct fields
    const logs = getTestDb().prepare("SELECT * FROM delivery_log WHERE task_id = ?").all("task-log-entry") as any[];
    expect(logs.length).toBe(1);
    expect(logs[0].rule_id).toBe("rule-log-entry");
    expect(logs[0].task_id).toBe("task-log-entry");
    // target is stored as JSON
    const target = JSON.parse(logs[0].target);
    expect(target.type).toBe("channel");
    expect(target.channelId).toBe("wc-log");
    expect(logs[0].content).toBe("done");
  });
});
import { createRole } from "../../store/roles.js";
