import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createTaskPlan, getTaskPlan, getTaskPlanByTaskId, updateTaskPlanStatus, saveDeviationReport, saveLearnedRules } from "../../store/task-plans.js";
import { createTask } from "../../store/tasks.js";
import type { TaskPlan, ExecutionPlan, DeviationReport } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

const makePlan = (): ExecutionPlan => ({
  steps: [
    { index: 0, description: "Read file", toolsNeeded: ["Read"], expectedOutput: "file content", riskLevel: "low" },
    { index: 1, description: "Edit file", toolsNeeded: ["Edit"], expectedOutput: "file updated", riskLevel: "medium" },
  ],
  requiredPermissions: {
    allowedTools: ["Read", "Edit"],
    disallowedTools: [],
    approvalRequired: [],
    maxBudgetUsd: 5.0,
    plugins: [],
  },
  overallRisk: "medium",
});

function seedTask(id: string) {
  createTask({
    id,
    status: "running",
    prompt: "test task",
    createdAt: Date.now(),
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 } as any,
  });
}

describe("store/task-plans", () => {
  it("creates and retrieves a task plan", () => {
    seedTask("task-1");
    const plan: TaskPlan = {
      id: "plan-1",
      taskId: "task-1",
      roleId: undefined,
      plan: makePlan(),
      status: "pending",
      createdAt: Date.now(),
    };
    createTaskPlan(plan);

    const retrieved = getTaskPlan("plan-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.taskId).toBe("task-1");
    expect(retrieved!.plan.steps).toHaveLength(2);
    expect(retrieved!.status).toBe("pending");
  });

  it("retrieves by taskId", () => {
    seedTask("task-2");
    createTaskPlan({
      id: "plan-2",
      taskId: "task-2",
      plan: makePlan(),
      status: "pending",
      createdAt: Date.now(),
    });

    const retrieved = getTaskPlanByTaskId("task-2");
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe("plan-2");
  });

  it("updates status to approved with approval type", () => {
    seedTask("task-3");
    createTaskPlan({
      id: "plan-3",
      taskId: "task-3",
      plan: makePlan(),
      status: "pending",
      createdAt: Date.now(),
    });

    updateTaskPlanStatus("plan-3", "approved", "once");

    const retrieved = getTaskPlan("plan-3");
    expect(retrieved!.status).toBe("approved");
    expect(retrieved!.approvalType).toBe("once");
    expect(retrieved!.approvedAt).toBeDefined();
  });

  it("saves deviation report", () => {
    seedTask("task-4");
    createTaskPlan({
      id: "plan-4",
      taskId: "task-4",
      plan: makePlan(),
      status: "approved",
      createdAt: Date.now(),
    });

    const report: DeviationReport = {
      stepsPlanned: 2,
      stepsExecuted: 1,
      deviations: [{ stepIndex: 1, planned: "Edit file", actual: "Not executed", deviationType: "skipped" }],
      overallAccuracy: 0.5,
    };

    saveDeviationReport("plan-4", report);

    const retrieved = getTaskPlan("plan-4");
    expect(retrieved!.deviationReport).toBeDefined();
    expect(retrieved!.deviationReport!.overallAccuracy).toBe(0.5);
    expect(retrieved!.reviewedAt).toBeDefined();
  });

  it("saves learned rules", () => {
    seedTask("task-5");
    createTaskPlan({
      id: "plan-5",
      taskId: "task-5",
      plan: makePlan(),
      status: "completed",
      createdAt: Date.now(),
    });

    saveLearnedRules("plan-5", ["Rule A", "Rule B"]);

    const retrieved = getTaskPlan("plan-5");
    expect(retrieved!.learnedRules).toEqual(["Rule A", "Rule B"]);
  });
});
