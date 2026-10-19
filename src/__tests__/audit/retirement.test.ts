import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { checkRetirement, reinstateAgent, checkProbationGraduation } from "../../audit/retirement.js";
import { recordTaskScore } from "../../audit/score.js";
import { getRole, createRole } from "../../store/roles.js";
import { createTask } from "../../store/tasks.js";
import { listEvolutionAudit } from "../../store/evolution-audit.js";
import type { Role } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedRole(id: string, status: Role["status"] = "active") {
  createRole({
    id, name: `Role ${id}`, cagPrompt: "", learnedRules: { stylePreferences: ["existing rule"], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `mem-${id}`, status, preferences: {},
    createdAt: Date.now(),
  });
}

function seedFailedTask(id: string, roleId?: string) {
  createTask({
    id, status: "failed", prompt: "test", roleId,
    createdAt: Date.now(), completedAt: Date.now(),
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 } as any,
  });
}

function seedCompletedTask(id: string, roleId?: string) {
  createTask({
    id, status: "completed", prompt: "test", roleId,
    createdAt: Date.now(), completedAt: Date.now(),
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 } as any,
  });
}

describe("monitor/retirement", () => {
  describe("checkRetirement", () => {
    it("retires agent when EMA below threshold", () => {
      seedRole("retire-me");
      const report = checkRetirement("retire-me", 0.3, 0.4);
      expect(report).toBeDefined();
      expect(getRole("retire-me")!.status).toBe("retired");
    });

    it("does not retire when EMA above threshold", () => {
      seedRole("keep-me");
      const report = checkRetirement("keep-me", 0.8, 0.4);
      expect(report).toBeUndefined();
      expect(getRole("keep-me")!.status).toBe("active");
    });

    it("applies targeted learnedRules modification (not full reset)", () => {
      seedRole("rules-mod");
      // Seed some failing scores so diagnostic produces recommendations
      for (let i = 0; i < 3; i++) {
        seedFailedTask(`rules-fail-${i}`, "rules-mod");
        recordTaskScore("rules-mod", `rules-fail-${i}`);
      }
      checkRetirement("rules-mod", 0.1, 0.4);
      const role = getRole("rules-mod")!;
      // Should still have the original rule (in stylePreferences from legacy fixture)
      // + new audit-derived rules in avoidedActions (per Task 4: applyDiagnosticRecommendations writes to avoidedActions)
      expect(role.learnedRules.stylePreferences.some((r: string) => r === "existing rule")).toBe(true);
      expect(role.learnedRules.avoidedActions.length).toBeGreaterThan(0);
    });

    it("logs to evolution_audit with source: audit", () => {
      seedRole("audit-me");
      checkRetirement("audit-me", 0.1, 0.4);
      const audits = listEvolutionAudit();
      expect(audits.some(a => a.source === "audit")).toBe(true);
    });
  });

  describe("reinstateAgent", () => {
    it("moves retired agent to probation", () => {
      seedRole("reinstate", "retired");
      const result = reinstateAgent("reinstate");
      expect(result).toBe(true);
      expect(getRole("reinstate")!.status).toBe("probation");
    });

    it("returns false for non-retired agent", () => {
      seedRole("not-retired");
      expect(reinstateAgent("not-retired")).toBe(false);
    });
  });

  describe("checkProbationGraduation", () => {
    it("graduates when EMA recovers above threshold", () => {
      seedRole("probation-grad", "probation");
      // Seed enough scores for probation period
      for (let i = 0; i < 5; i++) {
        seedCompletedTask(`grad-task-${i}`, "probation-grad");
        recordTaskScore("probation-grad", `grad-task-${i}`);
      }
      const graduated = checkProbationGraduation("probation-grad", 0.8, 0.4, 5);
      expect(graduated).toBe(true);
      expect(getRole("probation-grad")!.status).toBe("active");
    });

    it("does not graduate with insufficient tasks", () => {
      seedRole("probation-few", "probation");
      seedCompletedTask("few-task-1", "probation-few");
      recordTaskScore("probation-few", "few-task-1");
      const graduated = checkProbationGraduation("probation-few", 0.8, 0.4, 5);
      expect(graduated).toBe(false);
    });
  });
});
