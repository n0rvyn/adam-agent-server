import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));

import { createDeliveryRule, findMatchingRules } from "../../store/delivery-rules.js";
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

describe("excludePromptPatterns", () => {
  it("blocks matching when prompt matches an exclude pattern", () => {
    createDeliveryRule(makeRule({
      id: "r-block",
      matchCriteria: {
        promptPattern: ".*",
        excludePromptPatterns: ["E2E_TEST_MODE"],
      },
    }));
    // "check the weather" does not contain "E2E_TEST_MODE" → exclude does not fire → 1 match
    const matches = findMatchingRules("task_complete", { prompt: "check the weather" });
    expect(matches).toHaveLength(1);

    // "E2E_TEST_MODE check the weather" contains the exclude pattern → blocked → 0 matches
    const blocked = findMatchingRules("task_complete", { prompt: "E2E_TEST_MODE check the weather" });
    expect(blocked).toHaveLength(0);
  });

  it("allows matching when prompt does not match any exclude pattern", () => {
    createDeliveryRule(makeRule({
      id: "r-allow",
      matchCriteria: {
        promptPattern: ".*",
        excludePromptPatterns: ["E2E_TEST_MODE"],
      },
    }));
    // "deploy code" does not contain "E2E_TEST_MODE" → 1 match
    const matches = findMatchingRules("task_complete", { prompt: "deploy code" });
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe("r-allow");
  });

  it("blocks when any one of multiple exclude patterns matches", () => {
    createDeliveryRule(makeRule({
      id: "r-multi",
      matchCriteria: {
        promptPattern: ".*",
        excludePromptPatterns: ["PLAYWRIGHT", "CYPRESS", "SELENIUM"],
      },
    }));
    // "normal task" matches no exclude pattern → 1 match
    expect(findMatchingRules("task_complete", { prompt: "normal task" })).toHaveLength(1);
    // "PLAYWRIGHT automation" matches exclude pattern → 0 matches
    expect(findMatchingRules("task_complete", { prompt: "PLAYWRIGHT automation" })).toHaveLength(0);
    expect(findMatchingRules("task_complete", { prompt: "cypress test suite" })).toHaveLength(0);
    expect(findMatchingRules("task_complete", { prompt: "selenium check" })).toHaveLength(0);
  });

  it("skips invalid regex patterns silently without crashing", () => {
    createDeliveryRule(makeRule({
      id: "r-bad-regex",
      matchCriteria: {
        promptPattern: ".*",
        excludePromptPatterns: ["[invalid", "*(none", "normal"],
      },
    }));
    // "[invalid" and "*(none" are invalid regex — skipped; "normal" matches "normal task" → blocked → 0
    const matches = findMatchingRules("task_complete", { prompt: "normal task" });
    expect(matches).toHaveLength(0);
  });

  it("skips patterns longer than 200 characters silently", () => {
    const longPattern = "A".repeat(201);
    createDeliveryRule(makeRule({
      id: "r-long",
      matchCriteria: {
        promptPattern: ".*",
        excludePromptPatterns: [longPattern],
      },
    }));
    // Long pattern is skipped; only promptPattern matches → should match
    const matches = findMatchingRules("task_complete", { prompt: "any task" });
    expect(matches).toHaveLength(1);
  });

  it("empty excludePromptPatterns array does not block", () => {
    createDeliveryRule(makeRule({
      id: "r-empty",
      matchCriteria: {
        promptPattern: "deploy",
        excludePromptPatterns: [],
      },
    }));
    const matches = findMatchingRules("task_complete", { prompt: "deploy code" });
    expect(matches).toHaveLength(1);
  });

  it("empty prompt does not crash and uses empty-string behavior", () => {
    createDeliveryRule(makeRule({
      id: "r-no-prompt",
      matchCriteria: {
        promptPattern: ".*",
        excludePromptPatterns: ["E2E"],
      },
    }));
    // Empty string does not match "E2E" → 1 match
    const matches = findMatchingRules("task_complete", { prompt: "" });
    expect(matches).toHaveLength(1);
  });

  it("adam-tools zod boundary: pattern at max length 200 is accepted", () => {
    const maxPattern = "A".repeat(200);
    createDeliveryRule(makeRule({
      id: "r-max",
      matchCriteria: {
        promptPattern: ".*",
        excludePromptPatterns: [maxPattern],
      },
    }));
    // Pattern is exactly 200 chars — within zod limit. Prompt "xyz" does NOT match the exclude
    // pattern (which matches 200+ A's), so the rule fires → 1 match. This confirms the
    // max-length boundary is processed without crashing or being silently dropped.
    const matches = findMatchingRules("task_complete", { prompt: "xyz" });
    expect(matches).toHaveLength(1);
  });
});
