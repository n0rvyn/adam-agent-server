import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { evaluateTaskCompletion } from "../../audit/audit-manager.js";
import { createRole, getRole } from "../../store/roles.js";
import { createTask } from "../../store/tasks.js";
import { getScoresByRole } from "../../store/role-scores.js";
import { listEvolutionAudit } from "../../store/evolution-audit.js";
import type { Role } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedAgent(id: string, status: Role["status"] = "active") {
  createRole({
    id, name: `Role ${id}`, cagPrompt: "", learnedRules: { stylePreferences: ["existing rule"], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `mem-${id}`, status, preferences: {},
    createdAt: Date.now(),
  });
}

function seedTask(id: string, status: "completed" | "failed" = "completed", roleId?: string) {
  createTask({
    id, status, prompt: "test", roleId,
    createdAt: Date.now(), completedAt: Date.now(),
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 } as any,
  });
}

describe("monitor integration", () => {
  it("evaluate records score and triggers retirement on low EMA", () => {
    seedAgent("lifecycle-agent");

    // Record a failing task — weighted score for failed: 0*0.3+1*0.25+1*0.25+1*0.2 = 0.7
    seedTask("fail-1", "failed", "lifecycle-agent");
    evaluateTaskCompletion("fail-1", "lifecycle-agent", 0.8); // threshold 0.8 > 0.7

    // Role should be retired (EMA 0.7 < threshold 0.8) then auto-reinstated to probation
    const role = getRole("lifecycle-agent")!;
    expect(role.status).toBe("probation");

    // Verify score was recorded
    const scores = getScoresByRole("lifecycle-agent");
    expect(scores.length).toBe(1);

    // Verify audit
    const audits = listEvolutionAudit();
    expect(audits.some(a => a.source === "audit")).toBe(true);

    // learnedRules should be modified (not cleared)
    expect(role.learnedRules.stylePreferences).toContain("existing rule");
    expect(role.learnedRules.stylePreferences.length).toBeGreaterThanOrEqual(1);
  });

  it("skips evaluation for dead agents", () => {
    seedAgent("dead-agent", "dead");
    seedTask("dead-task", "completed", "dead-agent");
    evaluateTaskCompletion("dead-task", "dead-agent");

    const scores = getScoresByRole("dead-agent");
    expect(scores.length).toBe(0);
  });

  it("records scores for successful tasks without retirement", () => {
    seedAgent("good-agent");
    seedTask("good-task", "completed", "good-agent");
    evaluateTaskCompletion("good-task", "good-agent");

    const role = getRole("good-agent")!;
    expect(role.status).toBe("active");

    const scores = getScoresByRole("good-agent");
    expect(scores.length).toBe(1);
    expect(scores[0].emaScore).toBeGreaterThan(0.4);
  });

  it("writes EMA back to Role.performanceScore after evaluateTaskCompletion", () => {
    // This test verifies DP-1: the performanceScore field on the Role record
    // is updated with the computed EMA score after each task evaluation.
    seedAgent("perf-agent");
    seedTask("perf-task", "completed", "perf-agent");

    evaluateTaskCompletion("perf-task", "perf-agent");

    const role = getRole("perf-agent")!;
    const scores = getScoresByRole("perf-agent");
    expect(scores.length).toBe(1);
    // performanceScore must equal the EMA stored in role_scores
    expect(role.performanceScore).toBeCloseTo(scores[0].emaScore);
  });

  it("updates performanceScore across multiple tasks", () => {
    // Verify the EMA is written back after each task, and drops after a failed task.
    seedAgent("multi-perf-agent");
    seedTask("multi-1", "completed", "multi-perf-agent");
    seedTask("multi-2", "failed", "multi-perf-agent");

    // After a successful task: performanceScore should reflect the EMA
    evaluateTaskCompletion("multi-1", "multi-perf-agent");
    const role1 = getRole("multi-perf-agent")!;
    const scores1 = getScoresByRole("multi-perf-agent");
    expect(role1.performanceScore).toBeCloseTo(scores1[0].emaScore);

    // After a failed task: performanceScore should drop (failed task lowers EMA)
    evaluateTaskCompletion("multi-2", "multi-perf-agent");
    const role2 = getRole("multi-perf-agent")!;
    expect(role2.performanceScore).toBeLessThan(role1.performanceScore!);
  });
});
