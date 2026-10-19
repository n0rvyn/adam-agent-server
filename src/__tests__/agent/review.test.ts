import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { generateDeviationReport, isExecutionSuccessful } from "../../agent/review.js";
import { createTaskPlan } from "../../store/task-plans.js";
import { createTask } from "../../store/tasks.js";
import { createStepLog } from "../../store/logs.js";
import type { ExecutionPlan, DeviationReport } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

const makePlan = (): ExecutionPlan => ({
  steps: [
    { index: 0, description: "Read config", toolsNeeded: ["Read"], expectedOutput: "config content", riskLevel: "low" },
    { index: 1, description: "Edit config", toolsNeeded: ["Edit"], expectedOutput: "config updated", riskLevel: "medium" },
  ],
  requiredPermissions: {
    allowedTools: ["Read", "Edit"],
    disallowedTools: [], approvalRequired: [], maxBudgetUsd: 5.0, plugins: [],
  },
  overallRisk: "medium",
});

function seedTaskAndPlan(taskId: string, planId: string) {
  createTask({
    id: taskId, status: "completed", prompt: "test", createdAt: Date.now(),
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 } as any,
  });
  createTaskPlan({
    id: planId, taskId, plan: makePlan(), status: "approved", createdAt: Date.now(),
  });
}

describe("agent/review", () => {
  it("returns undefined when no plan exists", () => {
    createTask({
      id: "no-plan", status: "completed", prompt: "test", createdAt: Date.now(),
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 } as any,
    });
    const report = generateDeviationReport("no-plan");
    expect(report).toBeUndefined();
  });

  it("detects skipped steps", () => {
    seedTaskAndPlan("task-skip", "plan-skip");
    // Only one step was executed (step 0), step 1 was skipped
    createStepLog({
      id: "log-1", taskId: "task-skip", index: 0, type: "tool_result",
      content: "config content", toolName: "Read", timestamp: Date.now(), planStepIndex: 0,
    });

    const report = generateDeviationReport("task-skip");
    expect(report).toBeDefined();
    expect(report!.deviations.some(d => d.deviationType === "skipped")).toBe(true);
    expect(report!.overallAccuracy).toBe(0.5); // 1 of 2 steps skipped
  });

  it("reports 100% accuracy when all steps executed", () => {
    seedTaskAndPlan("task-full", "plan-full");
    createStepLog({
      id: "log-2", taskId: "task-full", index: 0, type: "tool_result",
      content: "config", toolName: "Read", timestamp: Date.now(), planStepIndex: 0,
    });
    createStepLog({
      id: "log-3", taskId: "task-full", index: 1, type: "tool_result",
      content: "updated", toolName: "Edit", timestamp: Date.now(), planStepIndex: 1,
    });

    const report = generateDeviationReport("task-full");
    expect(report!.overallAccuracy).toBe(1);
    expect(report!.deviations).toHaveLength(0);
  });

  describe("isExecutionSuccessful", () => {
    it("returns true for high accuracy, no critical deviations", () => {
      const report: DeviationReport = {
        stepsPlanned: 3, stepsExecuted: 4, overallAccuracy: 0.9,
        deviations: [{ stepIndex: -1, planned: "", actual: "extra step", deviationType: "added" }],
      };
      expect(isExecutionSuccessful(report)).toBe(true);
    });

    it("returns false for failed steps", () => {
      const report: DeviationReport = {
        stepsPlanned: 2, stepsExecuted: 1, overallAccuracy: 0.5,
        deviations: [{ stepIndex: 1, planned: "Edit", actual: "DENIED", deviationType: "failed" }],
      };
      expect(isExecutionSuccessful(report)).toBe(false);
    });
  });
});
