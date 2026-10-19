import { describe, it, expect, beforeEach, afterEach, afterAll, vi, beforeAll } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  },
}));

vi.mock("../../config/index.js", () => ({
  getDefaults: () => ({
    timeout: 600,
    maxTurns: 100,
    maxBudgetUsd: 5.0,
    effort: "high" as const,
    model: "claude-sonnet-4-6",
    settingSources: ["project"],
    allowedTools: [],
    disallowedTools: [],
    approvalRequired: [],
    approvalTimeout: 300,
    env: {},
  }),
  getConfig: () => ({
    defaults: {},
    workers: { count: 2, maxTasksBeforeRecycle: 50, maxMemoryMB: 512 },
    server: { port: 7100, host: "0.0.0.0" },
  }),
}));

vi.mock("../../store/role-workspace.js", () => ({
  ensureRoleWorkspace: vi.fn((role: { name: string }) => `/tmp/adam-test-roles/${role.name}`),
  getRoleWorkspacePath: vi.fn((roleName: string) => `/tmp/adam-test-roles/${roleName}`),
  writeRoleCLAUDEmd: vi.fn(),
  syncRoleSettings: vi.fn(),
}));

const { mockTemplateExecute } = vi.hoisted(() => ({
  mockTemplateExecute: vi.fn(async (_template: unknown, executionId: string) => (
    { executionId, status: "completed", stepResults: new Map() }
  )),
}));

// Mock TemplateExecutor so executeTemplateExecution does not run real async step processing
vi.mock("../../scheduler/template-executor.js", () => ({
  TemplateExecutor: class {
    async execute(_template: unknown, executionId: string) {
      return mockTemplateExecute(_template, executionId);
    }
  },
}));

import { BreeEngine } from "../../scheduler/bree-engine.js";
import { createTaskTemplate, getTaskTemplate } from "../../store/task-templates.js";
import { listTasks } from "../../store/tasks.js";
import { createGoal, listGoals } from "../../store/goals.js";
import { createRole } from "../../store/roles.js";
import { serverBus } from "../../server/events/server-bus.js";
import type { Role } from "../../shared/types.js";

function seedRole(id: string, name?: string): void {
  const role: Role = {
    id,
    name: name ?? id,
    cagPrompt: "test",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `ms-${id}`,
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  };
  createRole(role);
}

afterAll(() => cleanup());

describe("BreeEngine", () => {
  let engine: BreeEngine;

  beforeEach(() => {
    clearTestDb();
    mockTemplateExecute.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    engine = new BreeEngine();
  });

  afterEach(async () => {
    await engine.stop();
    vi.useRealTimers();
  });

  function createCronTemplate(id: string, cron: string, enabled = true) {
    createTaskTemplate({
      id,
      name: `template-${id}`,
      trigger: { type: "cron", cron },
      steps: [{ id: "s1", prompt: "test prompt" }],
      rolePreference: "role-test-seed",
      enabled,
      createdAt: Date.now(),
    });
  }

  describe("start", () => {
    it("schedules enabled cron templates", async () => {
      createCronTemplate("t-1", "*/5 * * * *");
      createCronTemplate("t-2", "0 * * * *");

      await engine.start();

      // Engine started without error; cron jobs are scheduled internally
      // (cron intervals are setInterval-based)
    });

    it("does not schedule disabled templates", async () => {
      createCronTemplate("t-disabled", "*/5 * * * *", false);

      await engine.start();
      // No error; disabled templates are skipped
    });

    it("schedules memory cleanup job", async () => {
      await engine.start();
      // Memory cleanup is scheduled as an internal interval
    });
  });

  describe("stop", () => {
    it("clears all scheduled jobs", async () => {
      createCronTemplate("t-1", "*/5 * * * *");
      await engine.start();
      await engine.stop();
      // No error; all intervals cleared
    });

    it("can be called multiple times safely", async () => {
      await engine.start();
      await engine.stop();
      await engine.stop();
    });
  });

  describe("scheduleJob / unscheduleJob", () => {
    it("schedules a job by template id", async () => {
      createCronTemplate("t-sched", "*/10 * * * *");
      await engine.scheduleJob("t-sched");
      // No error; job is scheduled
    });

    it("unschedules a job by template id", async () => {
      createCronTemplate("t-unsched", "*/10 * * * *");
      await engine.scheduleJob("t-unsched");
      await engine.unscheduleJob("t-unsched");
      // No error; job is removed
    });

    it("unscheduleJob is safe for nonexistent job", async () => {
      await engine.unscheduleJob("nonexistent");
      // No error
    });

    it("scheduleJob with non-cron template is a no-op", async () => {
      createTaskTemplate({
        id: "t-manual",
        name: "manual-template",
        trigger: { type: "manual" },
        steps: [{ id: "s1", prompt: "test" }],
        rolePreference: "role-test-seed",
        enabled: true,
        createdAt: Date.now(),
      });
      await engine.scheduleJob("t-manual");
      // No error; manual templates are skipped
    });
  });

  describe("runNow", () => {
    it("returns an execution ID", async () => {
      createCronTemplate("t-run", "*/5 * * * *");
      const executionId = await engine.runNow("t-run");
      expect(executionId).toBeDefined();
      expect(typeof executionId).toBe("string");
      expect(executionId.length).toBeGreaterThan(0);
    });

    it("throws for nonexistent template", async () => {
      await expect(engine.runNow("nonexistent")).rejects.toThrow("not found");
    });
  });

  describe("checkTemplateCompleteTriggers", () => {
    it("does not throw when no template_complete triggers match", async () => {
      await engine.checkTemplateCompleteTriggers("nonexistent-template");
      // No error; no matching templates returns early
    });
  });

  describe("cron scheduling (via cron-parser)", () => {
    it("schedules */5 every 5 minutes", async () => {
      createCronTemplate("t-5min", "*/5 * * * *");
      await engine.scheduleJob("t-5min");
    });

    it("schedules 0 * * * * as hourly", async () => {
      createCronTemplate("t-hourly", "0 * * * *");
      await engine.scheduleJob("t-hourly");
    });

    it("schedules daily at specific time", async () => {
      createCronTemplate("t-daily", "0 9 * * *");
      await engine.scheduleJob("t-daily");
    });

    it("handles invalid cron expression gracefully", async () => {
      createCronTemplate("t-invalid", "not-a-cron");
      // Should not throw; logs warning and skips
      await engine.scheduleJob("t-invalid");
    });

    it("schedules twice daily", async () => {
      createCronTemplate("t-twice", "0 8,20 * * *");
      await engine.scheduleJob("t-twice");
    });
  });

  describe("serverBus subscription", () => {
    // These tests need real timers (not fake) because start() schedules cron jobs
    it("subscribes to template_execution_status_change when start() is called", async () => {
      vi.useRealTimers();
      vi.clearAllMocks();
      const freshEngine = new BreeEngine();
      await freshEngine.start();
      expect(serverBus.on).toHaveBeenCalledWith("template_execution_status_change", expect.any(Function));
      await freshEngine.stop();
      vi.useFakeTimers({ shouldAdvanceTime: false });
    });

    it("calls checkTemplateCompleteTriggers when template_execution_status_change finalizes successfully", async () => {
      vi.useRealTimers();
      vi.clearAllMocks();
      const freshEngine = new BreeEngine();
      const checkSpy = vi.spyOn(freshEngine, "checkTemplateCompleteTriggers").mockResolvedValue();
      await freshEngine.start();

      const handler = (freshEngine as any).templateExecutionCompletionHandler;
      expect(handler).toBeDefined();
      handler({ executionId: "exec-1", templateId: "source-template", status: "completed" });
      handler({ executionId: "exec-2", templateId: "partial-source-template", status: "partial" });
      await new Promise((r) => setTimeout(r, 10));

      expect(checkSpy).toHaveBeenCalledWith("source-template");
      expect(checkSpy).toHaveBeenCalledWith("partial-source-template");
      await freshEngine.stop();
      vi.useFakeTimers({ shouldAdvanceTime: false });
    });

    it("does not call checkTemplateCompleteTriggers when TemplateExecution status is not final success", async () => {
      vi.useRealTimers();
      vi.clearAllMocks();
      const freshEngine = new BreeEngine();
      const checkSpy = vi.spyOn(freshEngine, "checkTemplateCompleteTriggers").mockResolvedValue();
      await freshEngine.start();

      const handler = (freshEngine as any).templateExecutionCompletionHandler;
      expect(handler).toBeDefined();
      handler({ executionId: "exec-2", templateId: "source-template", status: "running" });
      await new Promise((r) => setTimeout(r, 10));

      expect(checkSpy).not.toHaveBeenCalled();
      await freshEngine.stop();
      vi.useFakeTimers({ shouldAdvanceTime: false });
    });
  });

  describe("executeTemplateExecution with goalIds", () => {
    // These tests call executeTemplateExecution directly to avoid relying on fake-timer-based cron firing.
    // TemplateExecutor is mocked to return Promise.resolve() so the async chain resolves.

    it("goalIds template runs through TemplateExecutor without cloning Goals", async () => {
      createGoal({
        id: "goal-source-1",
        name: "Weekly Review",
        description: "Review all completed tasks",
        roleId: "engineer",
        metricType: "count",
        targetValue: 1,
        currentValue: 0,
        deadline: Date.now() + 7 * 24 * 60 * 60 * 1000,
        budgetUsd: 0,
        status: "active",
        createdAt: Date.now(),
      });

      const template = {
        id: "t-goal-template",
        name: "Weekly review template",
        trigger: { type: "cron" as const, cron: "0 9 * * 1" },
        goalIds: ["goal-source-1"],
        steps: [{ id: "decompose", prompt: "Decompose weekly review", autoSelectRole: true, requirements: {} }],
        enabled: true,
        createdAt: Date.now(),
      };
      createTaskTemplate(template);

      // Call executeTemplateExecution directly (TemplateExecutor is mocked to return Promise.resolve)
      const tmpl = getTaskTemplate("t-goal-template");
      await (engine as any).executeTemplateExecution(tmpl!, "exec-goal-1");

      const allGoals = listGoals();
      expect(allGoals).toHaveLength(1);
      expect(allGoals[0]!.id).toBe("goal-source-1");
      expect(listTasks()).toHaveLength(0);
      expect(mockTemplateExecute).toHaveBeenCalledWith(expect.objectContaining({
        id: "t-goal-template",
        goalIds: ["goal-source-1"],
      }), "exec-goal-1");
    });

    it("goalIds template preserves one TemplateExecution ID for the normal path", async () => {
      // Admission requires an active role; seed one matching the goal's owning role
      seedRole("analyst", "Analyst");
      createGoal({
        id: "goal-source-2",
        name: "Daily Standup",
        description: "Generate daily standup notes",
        roleId: "analyst",
        metricType: "count",
        targetValue: 1,
        currentValue: 0,
        deadline: Date.now() + 86400000,
        budgetUsd: 0,
        status: "active",
        createdAt: Date.now(),
      });

      const template = {
        id: "t-goal-template-2",
        name: "Daily standup template",
        trigger: { type: "manual" as const },
        goalIds: ["goal-source-2"],
        steps: [{ id: "decompose", prompt: "Decompose daily standup", autoSelectRole: true, requirements: {} }],
        enabled: true,
        createdAt: Date.now(),
      };
      createTaskTemplate(template);

      const tmpl = getTaskTemplate("t-goal-template-2");
      await (engine as any).executeTemplateExecution(tmpl!, "exec-goal-2");

      expect(listGoals().map((goal) => goal.id)).toEqual(["goal-source-2"]);
      expect(listTasks()).toHaveLength(0);
      expect(mockTemplateExecute).toHaveBeenCalledWith(expect.objectContaining({
        id: "t-goal-template-2",
        goalIds: ["goal-source-2"],
      }), "exec-goal-2");
    });

    it("does not pre-admit Goal tasks in BreeEngine; TemplateExecutor owns Goal step admission", async () => {
      createGoal({
        id: "goal-admission-fail",
        name: "Bad-role goal",
        description: "goal with a missing role",
        roleId: "role-does-not-exist",
        metricType: "count",
        targetValue: 1,
        currentValue: 0,
        deadline: Date.now() + 86400000,
        budgetUsd: 0,
        status: "active",
        createdAt: Date.now(),
      });

      const template = {
        id: "t-goal-admission-fail",
        name: "Admission failure template",
        trigger: { type: "manual" as const },
        goalIds: ["goal-admission-fail"],
        steps: [{ id: "decompose", prompt: "Decompose bad-role goal", autoSelectRole: true, requirements: {} }],
        enabled: true,
        createdAt: Date.now(),
      };
      createTaskTemplate(template);

      const tasksBefore = listTasks().length;

      const tmpl = getTaskTemplate("t-goal-admission-fail");
      await (engine as any).executeTemplateExecution(tmpl!, "exec-admission-fail");

      const tasksAfter = listTasks();
      expect(tasksAfter.length).toBe(tasksBefore);
      expect(listGoals().map((goal) => goal.id)).toEqual(["goal-admission-fail"]);
      expect(mockTemplateExecute).toHaveBeenCalledWith(expect.objectContaining({
        id: "t-goal-admission-fail",
        goalIds: ["goal-admission-fail"],
      }), "exec-admission-fail");
    });

    it("checkTemplateCompleteTriggers fires template_complete:<id> when a TemplateExecution's templateId matches", async () => {
      // Use real timers to allow async operations to complete without the test timing out.
      vi.useRealTimers();

      const syncTemplate = {
        id: "t-sync",
        name: "OmniFocus sync",
        trigger: { type: "template_complete" as const, event: "template_complete:pkos-inbox" },
        steps: [{ id: "s1", prompt: "sync to OmniFocus" }],
        rolePreference: "role-test-seed",
        enabled: true,
        createdAt: Date.now(),
      };
      createTaskTemplate(syncTemplate);

      const executeSpy = vi.spyOn(engine as any, "executeTemplateExecution");
      await engine.checkTemplateCompleteTriggers("pkos-inbox");

      // The trigger template for pkos-inbox should have been executed
      expect(executeSpy).toHaveBeenCalled();
      const call = executeSpy.mock.calls.find(([t]: any[]) => t.id === "t-sync");
      expect(call).toBeDefined();

      vi.useFakeTimers({ shouldAdvanceTime: false });
    });
  });
});
