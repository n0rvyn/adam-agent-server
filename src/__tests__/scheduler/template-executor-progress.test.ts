import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

const _mockCreateTaskWithAdmission = vi.hoisted(() => vi.fn());
const _mockWaitForTaskCompletion = vi.hoisted(() => vi.fn());

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/index.js", () => ({
  getDefaults: () => ({
    timeout: 600,
    maxTurns: 100,
    maxBudgetUsd: 5,
    model: "",
    approvalRequired: [],
    approvalTimeout: 300,
    env: {},
    claudeCodePath: undefined,
  }),
}));

vi.mock("../../lib/task-dispatch.js", () => ({
  createTaskWithAdmission: (...args: unknown[]) => _mockCreateTaskWithAdmission(...args),
}));

vi.mock("../../scheduler/wait-for-task.js", () => ({
  waitForTaskCompletion: (...args: unknown[]) => _mockWaitForTaskCompletion(...args),
}));

import { TemplateExecutor } from "../../scheduler/template-executor.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { getTemplateExecution } from "../../store/template-executions.js";
import { createRole } from "../../store/roles.js";
import type { TaskTemplate } from "../../shared/types.js";

afterAll(() => cleanup());

describe("TemplateExecutor progress persistence", () => {
  beforeEach(() => {
    clearTestDb();
    vi.clearAllMocks();
  });

  it("persists a running step with taskId and roleId before the child task completes", async () => {
    const template: TaskTemplate = {
      id: "tmpl-progress",
      name: "Progress Template",
      trigger: { type: "manual" },
      steps: [{ id: "collect", prompt: "Collect source data", roleId: "role-progress" }],
      enabled: true,
      createdAt: Date.now(),
    };
    createRole({
      id: "role-progress",
      name: "progress role",
      cagPrompt: "test",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-role-progress",
      status: "active",
      preferences: {},
      createdAt: Date.now(),
    });
    createTaskTemplate(template);

    _mockCreateTaskWithAdmission.mockResolvedValue({ ok: true, taskId: "task-progress-1" });

    let releaseCompletion!: (status: "completed") => void;
    let waitStarted!: () => void;
    const waitStartedPromise = new Promise<void>((resolve) => {
      waitStarted = resolve;
    });
    _mockWaitForTaskCompletion.mockImplementation(() => {
      waitStarted();
      return new Promise((resolve) => {
        releaseCompletion = resolve;
      });
    });

    const executionPromise = new TemplateExecutor({ maxRetries: 1, baseDelayMs: 1 })
      .execute(template, "exec-progress");

    await waitStartedPromise;

    const execution = getTemplateExecution("exec-progress");
    expect(execution?.stepStatuses.collect).toMatchObject({
      taskId: "task-progress-1",
      roleId: "role-progress",
      status: "running",
    });

    releaseCompletion("completed");
    await executionPromise;
  });
});
