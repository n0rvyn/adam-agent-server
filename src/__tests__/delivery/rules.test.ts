import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));

import { createDeliveryRule, getDeliveryRule, listDeliveryRules, updateDeliveryRule, deleteDeliveryRule, findMatchingRules } from "../../store/delivery-rules.js";
import type { DeliveryRule } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function makeRule(overrides: Partial<DeliveryRule> = {}): DeliveryRule {
  return {
    id: overrides.id ?? "rule-1",
    eventType: "task_complete",
    matchCriteria: {},
    target: { type: "channel", channelId: "ch-1", chatId: "chat-1" },
    maxPerMinute: 5,
    skipOriginChannel: true,
    enabled: true,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("delivery-rules store", () => {
  it("creates and retrieves a rule", () => {
    createDeliveryRule(makeRule());
    const rule = getDeliveryRule("rule-1");
    expect(rule).toBeDefined();
    expect(rule!.eventType).toBe("task_complete");
    expect(rule!.target.channelId).toBe("ch-1");
  });

  it("lists enabled rules", () => {
    createDeliveryRule(makeRule({ id: "r1", enabled: true }));
    createDeliveryRule(makeRule({ id: "r2", enabled: false }));
    expect(listDeliveryRules(true)).toHaveLength(1);
    expect(listDeliveryRules(false)).toHaveLength(1);
    expect(listDeliveryRules()).toHaveLength(2);
  });

  it("updates a rule", () => {
    createDeliveryRule(makeRule());
    updateDeliveryRule("rule-1", { maxPerMinute: 10, enabled: false });
    const updated = getDeliveryRule("rule-1")!;
    expect(updated.maxPerMinute).toBe(10);
    expect(updated.enabled).toBe(false);
  });

  it("deletes a rule and its log entries", () => {
    createDeliveryRule(makeRule());
    deleteDeliveryRule("rule-1");
    expect(getDeliveryRule("rule-1")).toBeUndefined();
  });

  describe("findMatchingRules", () => {
    it("matches by exact eventType", () => {
      createDeliveryRule(makeRule({ id: "r-complete", eventType: "task_complete" }));
      createDeliveryRule(makeRule({ id: "r-error", eventType: "task_error" }));

      const matches = findMatchingRules("task_complete", {});
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe("r-complete");
    });

    it("matches wildcard * eventType", () => {
      createDeliveryRule(makeRule({ id: "r-wild", eventType: "*" }));
      expect(findMatchingRules("task_complete", {})).toHaveLength(1);
      expect(findMatchingRules("task_error", {})).toHaveLength(1);
    });

    it("matches by templateId criteria", () => {
      createDeliveryRule(makeRule({ id: "r-tmpl", matchCriteria: { templateId: "tmpl-weather" } }));
      expect(findMatchingRules("task_complete", { templateId: "tmpl-weather" })).toHaveLength(1);
      expect(findMatchingRules("task_complete", { templateId: "tmpl-other" })).toHaveLength(0);
    });

    it("matches by promptPattern regex", () => {
      createDeliveryRule(makeRule({ id: "r-pattern", matchCriteria: { promptPattern: "天气|weather" } }));
      expect(findMatchingRules("task_complete", { prompt: "获取今日天气" })).toHaveLength(1);
      expect(findMatchingRules("task_complete", { prompt: "check weather" })).toHaveLength(1);
      expect(findMatchingRules("task_complete", { prompt: "deploy code" })).toHaveLength(0);
    });

    it("applies AND logic for multiple criteria", () => {
      createDeliveryRule(makeRule({
        id: "r-multi",
        matchCriteria: { roleId: "analyst" },
      }));
      expect(findMatchingRules("task_complete", { roleId: "analyst" })).toHaveLength(1);
      expect(findMatchingRules("task_complete", { roleId: "engineer" })).toHaveLength(0);
      expect(findMatchingRules("task_complete", { roleId: "other" })).toHaveLength(0);
    });

    it("excludes disabled rules", () => {
      createDeliveryRule(makeRule({ id: "r-off", enabled: false }));
      expect(findMatchingRules("task_complete", {})).toHaveLength(0);
    });
  });
});
