import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));

import { generateDiagnosticReport } from "../../audit/diagnostic.js";
import { createTask } from "../../store/tasks.js";
import { createRoleScore } from "../../store/role-scores.js";
import { v4 as uuidv4 } from "uuid";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedAgent(id: string) {
  createRole({
    id, name: `Agent ${id}`, cagPrompt: "",
    preferences: {}, learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: `mem-${id}`,
    status: "active", createdAt: Date.now(),
  });
}

function seedScore(roleId: string, taskId: string, scores: { taskSuccess: number; planAccuracy: number; permissionCompliance: number; efficiency: number }, emaScore: number) {
  createTask({
    id: taskId, status: scores.taskSuccess > 0.5 ? "completed" : "failed", prompt: "test",
    createdAt: Date.now(),
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 } as any,
  });
  createRoleScore({
    id: uuidv4(), roleId, taskId,
    scores: { ...scores, weighted: scores.taskSuccess * 0.3 + scores.planAccuracy * 0.25 + scores.permissionCompliance * 0.25 + scores.efficiency * 0.2 },
    emaScore, createdAt: Date.now(),
  });
}

describe("monitor/diagnostic", () => {
  it("generates report with failure classifications", () => {
    seedAgent("diag-agent");
    seedScore("diag-agent", "t1", { taskSuccess: 0, planAccuracy: 1, permissionCompliance: 1, efficiency: 1 }, 0.7);
    seedScore("diag-agent", "t2", { taskSuccess: 0, planAccuracy: 0.3, permissionCompliance: 0.5, efficiency: 1 }, 0.5);
    seedScore("diag-agent", "t3", { taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 0.1 }, 0.6);

    const report = generateDiagnosticReport("diag-agent");
    expect(report.roleId).toBe("diag-agent");
    expect(report.taskCount).toBe(3);
    expect(report.failureBehaviors.length).toBeGreaterThan(0);
    expect(report.failureBehaviors.some(f => f.category === "task_failures")).toBe(true);
  });

  it("returns empty behaviors for a perfect agent", () => {
    seedAgent("perfect");
    seedScore("perfect", "tp1", { taskSuccess: 1, planAccuracy: 1, permissionCompliance: 1, efficiency: 0.8 }, 0.95);

    const report = generateDiagnosticReport("perfect");
    expect(report.failureBehaviors).toHaveLength(0);
    expect(report.rootCauses).toHaveLength(0);
  });

  it("includes recommendations for high failure rates", () => {
    seedAgent("failing");
    for (let i = 0; i < 5; i++) {
      seedScore("failing", `fail-${i}`, { taskSuccess: 0, planAccuracy: 0.3, permissionCompliance: 1, efficiency: 1 }, 0.3);
    }

    const report = generateDiagnosticReport("failing");
    expect(report.recommendations.length).toBeGreaterThan(0);
    expect(report.rootCauses.length).toBeGreaterThan(0);
  });
});
import { createRole } from "../../store/roles.js";
