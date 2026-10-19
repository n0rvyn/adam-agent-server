import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createApprovalRule, findMatchingRule, listApprovalRules, deleteApprovalRule } from "../../store/approval-rules.js";
import type { ApprovalRule } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedAgent(id: string): void {
  createRole({
    id, name: "Test", cagPrompt: "",
    preferences: {}, learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: `mem-${id}`,
    status: "active", createdAt: Date.now(),
  });
}

describe("store/approval-rules", () => {
  it("creates and lists approval rules", () => {
    seedAgent("agent-1");
    const rule: ApprovalRule = {
      id: "rule-1",
      roleId: "agent-1",
      taskPattern: "deploy.*production",
      maxRiskLevel: "high",
      createdAt: Date.now(),
    };
    createApprovalRule(rule);

    const rules = listApprovalRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].taskPattern).toBe("deploy.*production");
  });

  it("finds matching rule by prompt regex", () => {
    seedAgent("agent-1");
    createApprovalRule({
      id: "rule-2",
      roleId: "agent-1",
      taskPattern: "read.*file",
      maxRiskLevel: "low",
      createdAt: Date.now(),
    });

    const match = findMatchingRule("agent-1", "read the file at /tmp/test.txt", "low");
    expect(match).toBeDefined();
    expect(match!.id).toBe("rule-2");
  });

  it("does not match when risk level exceeds rule", () => {
    createApprovalRule({
      id: "rule-3",
      taskPattern: ".*",
      maxRiskLevel: "low",
      createdAt: Date.now(),
    });

    // medium > low, so rule doesn't cover this risk
    const match = findMatchingRule(undefined, "any task", "medium");
    expect(match).toBeUndefined();
  });

  it("does not match when agent does not match", () => {
    seedAgent("agent-specific");
    createApprovalRule({
      id: "rule-4",
      roleId: "agent-specific",
      taskPattern: ".*",
      maxRiskLevel: "high",
      createdAt: Date.now(),
    });

    const match = findMatchingRule("other-agent", "any task", "low");
    expect(match).toBeUndefined();
  });

  it("matches rule without roleId (wildcard)", () => {
    createApprovalRule({
      id: "rule-5",
      taskPattern: "test.*",
      maxRiskLevel: "medium",
      createdAt: Date.now(),
    });

    const match = findMatchingRule("any-agent", "test something", "low");
    expect(match).toBeDefined();
  });

  it("deletes a rule", () => {
    createApprovalRule({
      id: "rule-6",
      taskPattern: ".*",
      maxRiskLevel: "high",
      createdAt: Date.now(),
    });

    deleteApprovalRule("rule-6");
    expect(listApprovalRules()).toHaveLength(0);
  });
});
import { createRole } from "../../store/roles.js";
