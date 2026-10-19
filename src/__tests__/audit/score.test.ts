import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { computeTaskScore, recordTaskScore } from "../../audit/score.js";
import { createTask } from "../../store/tasks.js";
import { createTaskPlan, saveDeviationReport } from "../../store/task-plans.js";
import { createStepLog } from "../../store/logs.js";
import { getLatestEmaScore } from "../../store/role-scores.js";
import { recordAuditViolation } from "../../store/audit-violations.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedAgent(id: string) {
  createRole({
    id, name: "Test", cagPrompt: "",
    preferences: {}, learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: `mem-${id}`,
    status: "active", createdAt: Date.now(),
  });
}

function seedTask(id: string, status: "completed" | "failed" = "completed") {
  createTask({
    id, status, prompt: "test", createdAt: Date.now(),
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 } as any,
  });
}

describe("monitor/score", () => {
  describe("computeTaskScore", () => {
    it("returns 1.0 task_success for completed task", () => {
      seedTask("task-ok");
      const scores = computeTaskScore("task-ok");
      expect(scores.taskSuccess).toBe(1.0);
    });

    it("returns 0.0 task_success for failed task", () => {
      seedTask("task-fail", "failed");
      const scores = computeTaskScore("task-fail");
      expect(scores.taskSuccess).toBe(0.0);
    });

    it("uses deviation report for plan_accuracy", () => {
      seedTask("task-plan");
      seedAgent("agent-plan");
      createTaskPlan({
        id: "plan-1", taskId: "task-plan", roleId: "agent-plan",
        plan: { steps: [{ index: 0, description: "a", toolsNeeded: [], expectedOutput: "", riskLevel: "low" }], requiredPermissions: { allowedTools: [], disallowedTools: [], approvalRequired: [], maxBudgetUsd: 5, plugins: [] }, overallRisk: "low" },
        status: "completed", createdAt: Date.now(),
      });
      saveDeviationReport("plan-1", { stepsPlanned: 2, stepsExecuted: 1, deviations: [{ stepIndex: 1, planned: "step", actual: "skipped", deviationType: "skipped" }], overallAccuracy: 0.5 });

      const scores = computeTaskScore("task-plan");
      expect(scores.planAccuracy).toBe(0.5);
    });

    it("computes permission_compliance from denial logs", () => {
      seedTask("task-deny");
      createStepLog({ id: "log-1", taskId: "task-deny", index: 0, type: "tool_result", content: "ok", toolName: "Read", timestamp: Date.now() });
      createStepLog({ id: "log-2", taskId: "task-deny", index: 1, type: "permission_denied", content: "denied", toolName: "Write", timestamp: Date.now() });

      const scores = computeTaskScore("task-deny");
      expect(scores.permissionCompliance).toBe(0.5); // 1 deny / 2 total
    });

    it("returns weighted score", () => {
      seedTask("task-weighted");
      const scores = computeTaskScore("task-weighted");
      expect(scores.weighted).toBeGreaterThan(0);
      expect(scores.weighted).toBeLessThanOrEqual(1);
    });
  });

  describe("recordTaskScore", () => {
    it("records score and returns EMA", () => {
      seedAgent("agent-ema");
      seedTask("task-ema-1");
      const ema = recordTaskScore("agent-ema", "task-ema-1");
      expect(ema).toBeGreaterThan(0);
      expect(getLatestEmaScore("agent-ema")).toBe(ema);
    });

    it("EMA changes with different task outcomes", () => {
      seedAgent("agent-ema2");
      seedTask("task-ema2-a");
      seedTask("task-ema2-b", "failed");
      const ema1 = recordTaskScore("agent-ema2", "task-ema2-a");
      const ema2 = recordTaskScore("agent-ema2", "task-ema2-b");
      // EMA should decrease after failed task
      expect(ema2).toBeLessThan(ema1);
    });
  });

  describe("contractCompliance severity filter (Task 6 — D-004)", () => {
    function seedContractTask(id: string, checkCount: number) {
      createTask({
        id,
        status: "completed",
        prompt: "test",
        createdAt: Date.now(),
        config: {
          timeout: 600,
          approvalRequired: [],
          approvalTimeout: 300,
          outputContractCheckCount: checkCount,
        } as any,
      });
    }

    function makeViolation(id: string, taskId: string, layer: "A" | "B" | "C", severity: "error" | "warning") {
      recordAuditViolation({
        id,
        stepTaskId: taskId,
        executionId: "exec-score-test",
        roleId: "role-score-test",
        contractField: layer === "C" ? "customAssertions" : "lengthTarget",
        layer,
        severity,
        message: `test violation ${id}`,
        createdAt: Date.now(),
      });
    }

    it("regression: 2 Layer-A error violations penalize contractCompliance (errors still count)", () => {
      seedContractTask("task-2errors", 4);
      makeViolation("v1", "task-2errors", "A", "error");
      makeViolation("v2", "task-2errors", "A", "error");
      const scores = computeTaskScore("task-2errors");
      // 2 errors out of 4 contracts → 1 - 2/4 = 0.5
      expect(scores.contractCompliance).toBeCloseTo(0.5);
    });

    it("4 Layer-C-warning violations → contractCompliance == 1.0 (Layer C warnings excluded per D-004)", () => {
      seedContractTask("task-4cwarnings", 4);
      makeViolation("w1", "task-4cwarnings", "C", "warning");
      makeViolation("w2", "task-4cwarnings", "C", "warning");
      makeViolation("w3", "task-4cwarnings", "C", "warning");
      makeViolation("w4", "task-4cwarnings", "C", "warning");
      const scores = computeTaskScore("task-4cwarnings");
      expect(scores.contractCompliance).toBe(1.0);
    });

    it("1 error + 3 Layer-C-warnings → contractCompliance reflects only the 1 error penalty", () => {
      seedContractTask("task-mixed", 4);
      makeViolation("e1", "task-mixed", "A", "error");
      makeViolation("cw1", "task-mixed", "C", "warning");
      makeViolation("cw2", "task-mixed", "C", "warning");
      makeViolation("cw3", "task-mixed", "C", "warning");
      const scores = computeTaskScore("task-mixed");
      // Only 1 error counts → 1 - 1/4 = 0.75
      expect(scores.contractCompliance).toBeCloseTo(0.75);
    });

    it("0 violations → contractCompliance == 1.0", () => {
      seedContractTask("task-clean", 2);
      const scores = computeTaskScore("task-clean");
      expect(scores.contractCompliance).toBe(1.0);
    });

    it("regression: race-rescue warning (severity=warning, layer=A) still penalizes contractCompliance", () => {
      seedContractTask("task-racerescue", 4);
      // race-rescue uses severity="warning" layer="A" — should NOT be excluded by the layer-C filter
      makeViolation("rr1", "task-racerescue", "A", "warning");
      const scores = computeTaskScore("task-racerescue");
      // layer A warning is not filtered → 1 - 1/4 = 0.75
      expect(scores.contractCompliance).toBeCloseTo(0.75);
    });
  });
});
import { createRole } from "../../store/roles.js";
