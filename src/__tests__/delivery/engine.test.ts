import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));
vi.mock("../../config/index.js", () => ({
  getDefaults: () => ({
    plugins: [], allowedTools: [], disallowedTools: [],
    approvalRequired: [], maxBudgetUsd: 5.0,
  }),
}));

import { createDeliveryRule } from "../../store/delivery-rules.js";
import { createDeliveryLog, getPendingDeliveries, cleanupExpired } from "../../store/delivery-log.js";
import { createTask } from "../../store/tasks.js";
import type { DeliveryRule, DeliveryLogEntry } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function makeRule(overrides: Partial<DeliveryRule> = {}): DeliveryRule {
  return {
    id: overrides.id ?? "rule-test",
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

function makeLogEntry(overrides: Partial<DeliveryLogEntry> = {}): DeliveryLogEntry {
  return {
    id: overrides.id ?? "log-1",
    ruleId: "rule-test",
    status: "pending",
    target: { type: "webhook", webhookUrl: "https://example.com/hook" },
    content: "test content",
    attempts: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

describe("delivery/engine data layer", () => {
  it("creates delivery log entry for matched rule", () => {
    createDeliveryRule(makeRule());
    createTask({
      id: "task-deliver", status: "completed", prompt: "test",
      createdAt: Date.now(),
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 } as any,
    });

    createDeliveryLog(makeLogEntry({ taskId: "task-deliver" }));

    const pending = getPendingDeliveries();
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe("test content");
  });

  it("cleans up expired entries", () => {
    createDeliveryRule(makeRule());

    // Create an expired entry
    createDeliveryLog(makeLogEntry({
      id: "log-expired",
      expiresAt: Date.now() - 1000, // already expired
    }));

    const cleaned = cleanupExpired();
    expect(cleaned).toBe(1);
    expect(getPendingDeliveries()).toHaveLength(0);
  });

  it("does not clean up non-expired entries", () => {
    createDeliveryRule(makeRule());
    createDeliveryLog(makeLogEntry({ id: "log-fresh" }));

    const cleaned = cleanupExpired();
    expect(cleaned).toBe(0);
    expect(getPendingDeliveries()).toHaveLength(1);
  });
});
