import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));

import { createDeliveryRule } from "../../store/delivery-rules.js";
import { createDeliveryLog, markDelivered, updateDeliveryLogStatus, getPendingDeliveries, getFailedDeliveries, cleanupExpired, getDeliveryLogByRule } from "../../store/delivery-log.js";
import type { DeliveryLogEntry, DeliveryRule } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedRule(): DeliveryRule {
  const rule: DeliveryRule = {
    id: "rule-log", eventType: "task_complete", matchCriteria: {},
    target: { type: "webhook", webhookUrl: "https://example.com" },
    maxPerMinute: 5, skipOriginChannel: true, enabled: true, createdAt: Date.now(),
  };
  createDeliveryRule(rule);
  return rule;
}

function makeEntry(overrides: Partial<DeliveryLogEntry> = {}): DeliveryLogEntry {
  return {
    id: overrides.id ?? "log-1", ruleId: "rule-log", status: "pending",
    target: { type: "webhook", webhookUrl: "https://example.com" },
    content: "test", attempts: 0, createdAt: Date.now(),
    expiresAt: Date.now() + 86400000, ...overrides,
  };
}

describe("store/delivery-log", () => {
  it("creates and retrieves pending deliveries", () => {
    seedRule();
    createDeliveryLog(makeEntry());
    expect(getPendingDeliveries()).toHaveLength(1);
  });

  it("marks as delivered", () => {
    seedRule();
    createDeliveryLog(makeEntry());
    markDelivered("log-1");
    expect(getPendingDeliveries()).toHaveLength(0);
  });

  it("updates status to failed with error", () => {
    seedRule();
    createDeliveryLog(makeEntry());
    updateDeliveryLogStatus("log-1", "failed", "Network timeout");
    const failed = getFailedDeliveries();
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe("Network timeout");
  });

  it("getFailedDeliveries excludes entries with 3+ attempts", () => {
    seedRule();
    createDeliveryLog(makeEntry({ attempts: 3 }));
    updateDeliveryLogStatus("log-1", "failed", "Max retries");
    // attempts is now 4 (3 + 1 from updateDeliveryLogStatus)
    expect(getFailedDeliveries()).toHaveLength(0);
  });

  it("cleanupExpired removes old entries", () => {
    seedRule();
    createDeliveryLog(makeEntry({ expiresAt: Date.now() - 1000 }));
    expect(cleanupExpired()).toBe(1);
  });

  it("getDeliveryLogByRule returns entries for a specific rule", () => {
    seedRule();
    createDeliveryLog(makeEntry({ id: "log-a" }));
    createDeliveryLog(makeEntry({ id: "log-b" }));
    expect(getDeliveryLogByRule("rule-log")).toHaveLength(2);
    expect(getDeliveryLogByRule("other-rule")).toHaveLength(0);
  });
});
