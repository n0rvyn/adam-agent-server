import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  createEvolutionAudit,
  listEvolutionAudit,
  listEvolutionAuditByRole,
  getLatestRoleEvolution,
  generateDiff,
} from "../../store/evolution-audit.js";
import type { Role } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedAgent(id = "agent-1"): void {
  const agent: Role = {
    id,
    name: `Test Agent ${id}`,
    cagPrompt: "",
    preferences: {},
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `stream-${id}`,
    status: "active",
    createdAt: Date.now(),
  };
  createRole(agent);
}

describe("store/evolution-audit", () => {
  describe("createEvolutionAudit + listEvolutionAudit", () => {
    it("should create and list audit records", () => {
      seedAgent();
      createEvolutionAudit({
        timestamp: Date.now(),
        oldRules: "rule A",
        newRules: "rule B",
        diff: "+ rule B\n- rule A",
        roleId: "agent-1",
      });

      const records = listEvolutionAudit();
      expect(records.length).toBe(1);
      expect(records[0].oldRules).toBe("rule A");
      expect(records[0].newRules).toBe("rule B");
      expect(records[0].roleId).toBe("agent-1");
    });

    it("should auto-generate uuid for id", () => {
      seedAgent();
      createEvolutionAudit({
        timestamp: Date.now(),
        oldRules: "old",
        newRules: "new",
        diff: "+ new\n- old",
        roleId: "agent-1",
      });

      const records = listEvolutionAudit();
      expect(records[0].id).toBeDefined();
      expect(records[0].id.length).toBeGreaterThan(0);
    });

    it("should order by timestamp descending", () => {
      seedAgent();
      createEvolutionAudit({
        timestamp: 1000,
        oldRules: "a",
        newRules: "b",
        diff: "diff1",
        roleId: "agent-1",
      });
      createEvolutionAudit({
        timestamp: 2000,
        oldRules: "b",
        newRules: "c",
        diff: "diff2",
        roleId: "agent-1",
      });

      const records = listEvolutionAudit();
      expect(records[0].timestamp).toBe(2000);
      expect(records[1].timestamp).toBe(1000);
    });
  });

  describe("listEvolutionAuditByRole", () => {
    it("should filter by role id", () => {
      seedAgent("agent-1");
      seedAgent("agent-2");
      createEvolutionAudit({
        timestamp: Date.now(),
        oldRules: "a",
        newRules: "b",
        diff: "diff",
        roleId: "agent-1",
      });
      createEvolutionAudit({
        timestamp: Date.now(),
        oldRules: "c",
        newRules: "d",
        diff: "diff",
        roleId: "agent-2",
      });

      const agent1Records = listEvolutionAuditByRole("agent-1");
      expect(agent1Records.length).toBe(1);
      expect(agent1Records[0].roleId).toBe("agent-1");
    });

    it("should return empty for role with no audits", () => {
      seedAgent("agent-none");
      const records = listEvolutionAuditByRole("agent-none");
      expect(records).toEqual([]);
    });
  });

  describe("getLatestRoleEvolution", () => {
    it("should return the most recent evolution for a role", () => {
      seedAgent();
      createEvolutionAudit({
        timestamp: 1000,
        oldRules: "first",
        newRules: "second",
        diff: "diff1",
        roleId: "agent-1",
      });
      createEvolutionAudit({
        timestamp: 2000,
        oldRules: "second",
        newRules: "third",
        diff: "diff2",
        roleId: "agent-1",
      });

      const latest = getLatestRoleEvolution("agent-1");
      expect(latest).toBeDefined();
      expect(latest!.timestamp).toBe(2000);
      expect(latest!.newRules).toBe("third");
    });

    it("should return undefined if no evolution exists", () => {
      const result = getLatestRoleEvolution("nonexistent");
      expect(result).toBeUndefined();
    });
  });

  describe("generateDiff", () => {
    it("should show added lines", () => {
      const diff = generateDiff("line1", "line1\nline2");
      expect(diff).toContain("+ line2");
    });

    it("should show removed lines", () => {
      const diff = generateDiff("line1\nline2", "line1");
      expect(diff).toContain("- line2");
    });

    it("should return no changes when identical", () => {
      const diff = generateDiff("same", "same");
      expect(diff).toBe("(no changes)");
    });

    it("should show both added and removed lines", () => {
      const diff = generateDiff("old rule", "new rule");
      expect(diff).toContain("+ new rule");
      expect(diff).toContain("- old rule");
    });
  });
});
import { createRole } from "../../store/roles.js";
