import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

const { cleanup } = setupTestDb();

vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  createTemplateExecution,
  getTemplateExecution,
  updateTemplateExecution,
  listTemplateExecutions,
} from "../../../store/template-executions.js";
import { createTaskTemplate } from "../../../store/task-templates.js";
import { createTask } from "../../../store/tasks.js";
import { recordAuditViolation } from "../../../store/audit-violations.js";
import { createDeliveryLog } from "../../../store/delivery-log.js";
import { templateExecutionRoutes } from "../../../server/routes/template-executions.js";
import type { TaskTemplate } from "../../../shared/types.js";

afterAll(() => cleanup());

function seedTemplate(id = "tmpl-wf"): TaskTemplate {
  const template: TaskTemplate = {
    id,
    name: "Test TemplateExecution",
    trigger: { type: "manual" },
    steps: [{ id: "s1", prompt: "test" }],
    rolePreference: "role-test-seed",
    enabled: true,
    createdAt: Date.now(),
  };
  createTaskTemplate(template);
  return template;
}

describe("template-executions store", () => {
  beforeEach(() => clearTestDb());

  it("creates and retrieves a TemplateExecution", () => {
    seedTemplate();
    createTemplateExecution("wf-1", "tmpl-wf");

    const wf = getTemplateExecution("wf-1");
    expect(wf).toBeDefined();
    expect(wf!.id).toBe("wf-1");
    expect(wf!.templateId).toBe("tmpl-wf");
    expect(wf!.status).toBe("running");
    expect(wf!.stepStatuses).toEqual({});
    expect(wf!.startedAt).toBeGreaterThan(0);
  });

  it("updates status and step statuses", () => {
    seedTemplate();
    createTemplateExecution("wf-2", "tmpl-wf");

    updateTemplateExecution("wf-2", {
      status: "completed",
      stepStatuses: {
        s1: { taskId: "t1", status: "completed", result: "ok" },
      },
      completedAt: Date.now(),
    });

    const wf = getTemplateExecution("wf-2");
    expect(wf!.status).toBe("completed");
    expect(wf!.stepStatuses.s1?.status).toBe("completed");
    expect(wf!.completedAt).toBeGreaterThan(0);
  });

  it("lists executions with optional templateId filter", () => {
    seedTemplate("tmpl-a");
    seedTemplate("tmpl-b");
    createTemplateExecution("wf-a1", "tmpl-a");
    createTemplateExecution("wf-a2", "tmpl-a");
    createTemplateExecution("wf-b1", "tmpl-b");

    const all = listTemplateExecutions();
    expect(all).toHaveLength(3);

    const filtered = listTemplateExecutions("tmpl-a");
    expect(filtered).toHaveLength(2);
    expect(filtered.every(wf => wf.templateId === "tmpl-a")).toBe(true);
  });

  it("returns undefined for non-existent execution", () => {
    const wf = getTemplateExecution("nonexistent");
    expect(wf).toBeUndefined();
  });
});

describe("template-executions with tasks (cancel integration)", () => {
  beforeEach(() => clearTestDb());

  it("lists child tasks via parentId matching executionId", async () => {
    seedTemplate();
    createTemplateExecution("wf-cancel", "tmpl-wf");

    // Create step tasks with parentId = executionId
    createTask({
      id: "t1",
      status: "pending",
      prompt: "Step 1",
      config: { timeout: 300, approvalRequired: [], approvalTimeout: 60 },
      createdAt: Date.now(),
      parentId: "wf-cancel",
    });
    createTask({
      id: "t2",
      status: "running",
      prompt: "Step 2",
      config: { timeout: 300, approvalRequired: [], approvalTimeout: 60 },
      createdAt: Date.now(),
      parentId: "wf-cancel",
    });

    const { listTasksByParent } = await import("../../../store/tasks.js");
    const tasks = listTasksByParent("wf-cancel");
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.parentId).toBe("wf-cancel");
  });
});

describe("server/routes/template-executions", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    clearTestDb();
    app = Fastify();
    await app.register(async (instance) => {
      await templateExecutionRoutes(instance);
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("lists recent TemplateExecutions", async () => {
    seedTemplate();
    createTemplateExecution("wf-list-1", "tmpl-wf");
    createTemplateExecution("wf-list-2", "tmpl-wf");

    const response = await app.inject({
      method: "GET",
      url: "/template-executions?templateId=tmpl-wf&limit=5",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { executions: Array<{ id: string }> };
    expect(body.executions).toHaveLength(2);
    expect(body.executions.map((execution) => execution.id).sort()).toEqual(["wf-list-1", "wf-list-2"]);
  });

  it("returns TemplateExecution details with step tasks", async () => {
    seedTemplate();
    createTemplateExecution("wf-detail", "tmpl-wf");
    updateTemplateExecution("wf-detail", {
      stepStatuses: {
        s1: { taskId: "task-detail-1", status: "running", roleId: "role-1" },
      },
    });
    createTask({
      id: "task-detail-1",
      status: "running",
      prompt: "Step 1",
      config: {
        timeout: 300,
        approvalRequired: [],
        approvalTimeout: 60,
        env: { API_TOKEN: "step-secret" },
        executionProfile: {
          id: "role-1",
          name: "role",
          cagPrompt: "prompt",
          learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
          memoryStreamId: "mem-role-1",
          status: "active",
          preferences: {},
          createdAt: Date.now(),
          envVars: { PRIVATE_TOKEN: "step-secret" },
        },
      },
      createdAt: Date.now(),
      parentId: "wf-detail",
      stepId: "s1",
      roleId: "role-1",
    });
    createDeliveryLog({
      id: "delivery-wf-detail",
      taskId: "wf-detail",
      status: "delivered",
      target: { type: "channel", channelId: "chan-1" },
      content: "done",
      attempts: 1,
      createdAt: Date.now(),
      deliveredAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      source: "direct",
      messageType: "result_delivery",
    });

    const response = await app.inject({
      method: "GET",
      url: "/template-executions/wf-detail",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      execution: { id: string; stepStatuses: Record<string, { taskId: string }> };
      runView: { id: string; warnings: unknown[]; retries: unknown[] };
      stepTasks: Array<{ id: string; stepId?: string; config?: Record<string, unknown> }>;
      deliveryLog: Array<{ id: string; status: string; target: { type: string; channelId?: string } }>;
    };
    expect(body.execution.id).toBe("wf-detail");
    expect(body.execution.stepStatuses.s1.taskId).toBe("task-detail-1");
    expect(body.runView.id).toBe("wf-detail");
    expect(body.stepTasks).toHaveLength(1);
    expect(body.deliveryLog).toHaveLength(1);
    expect(body.deliveryLog[0]).toMatchObject({
      id: "delivery-wf-detail",
      status: "delivered",
      target: { type: "channel", channelId: "chan-1" },
    });
    expect(body.stepTasks[0]?.stepId).toBe("s1");
    expect(JSON.stringify(body)).not.toContain("step-secret");
    expect(body.stepTasks[0]?.config).not.toHaveProperty("executionProfile");
    expect(body.stepTasks[0]?.config).not.toHaveProperty("env");
  });

  it("returns a run view with root error, retries, and explicit warnings", async () => {
    seedTemplate();
    createTemplateExecution("wf-run-view", "tmpl-wf");
    updateTemplateExecution("wf-run-view", {
      status: "failed",
      error: "契约校验失败（length retry）：actual 2111 characters / target 2200-2800 characters",
      stepStatuses: {
        collect: {
          taskId: "task-collect",
          status: "completed",
          result: "WARNING: WebSearch API unavailable; used local archive.",
          warnings: ["WARNING: WebSearch API unavailable; used local archive."],
        },
        write: {
          taskId: "task-write-retry",
          status: "failed",
          error: "契约校验失败（length retry）：actual 2111 characters / target 2200-2800 characters",
          contractRetried: true,
          retryReason: "length",
          attempt: 2,
          maxAttempts: 2,
          originalTaskId: "task-write",
          retryTaskId: "task-write-retry",
        },
      },
      completedAt: Date.now(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/template-executions/wf-run-view",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      runView: {
        rootError?: string;
        failedStepId?: string;
        retries: Array<{ stepId: string; retryReason?: string; originalTaskId?: string; retryTaskId?: string }>;
        warnings: Array<{ stepId: string; message: string }>;
      };
    };
    expect(body.runView.rootError).toContain("length retry");
    expect(body.runView.failedStepId).toBe("write");
    expect(body.runView.retries[0]).toMatchObject({
      stepId: "write",
      retryReason: "length",
      originalTaskId: "task-write",
      retryTaskId: "task-write-retry",
    });
    expect(body.runView.warnings[0]).toMatchObject({
      stepId: "collect",
      message: "WARNING: WebSearch API unavailable; used local archive.",
    });
  });

  it("exposes outputAs contract failures even when outputContractCheckCount is unset", async () => {
    seedTemplate();
    const error = 'Step "快刀润色" declares outputAs="最终逐字稿" but no artifact was published with that key.';
    createTemplateExecution("wf-outputas", "tmpl-wf");
    updateTemplateExecution("wf-outputas", {
      status: "failed",
      error,
      stepStatuses: {
        polish: { taskId: "task-polish", status: "failed", roleId: "role-polish", error },
      },
      completedAt: Date.now(),
    });
    createTask({
      id: "task-polish",
      status: "completed",
      prompt: "润色逐字稿",
      result: "Wrote /Users/example/.adam/roles/快刀青衣/播客逐字稿_2026-05-09.md",
      config: { timeout: 300, approvalRequired: [], approvalTimeout: 60 },
      createdAt: Date.now(),
      completedAt: Date.now(),
      parentId: "wf-outputas",
      templateId: "tmpl-wf",
      stepId: "polish",
      roleId: "role-polish",
    });
    recordAuditViolation({
      id: "viol-outputas",
      stepTaskId: "task-polish",
      executionId: "wf-outputas",
      roleId: "role-polish",
      contractField: "outputAs",
      layer: "A",
      severity: "error",
      message: error,
      createdAt: Date.now(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/template-executions/wf-outputas",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      execution: {
        error?: string;
        stepStatuses: Record<string, {
          error?: string;
          contract?: { violations: Array<{ contractField: string; message: string }> };
        }>;
      };
    };
    expect(body.execution.error).toContain("outputAs");
    expect(body.execution.stepStatuses.polish.error).toContain("outputAs");
    expect(body.execution.stepStatuses.polish.contract?.violations[0]).toMatchObject({
      contractField: "outputAs",
      message: error,
    });
  });

  it("cancels child tasks and marks TemplateExecution cancelled", async () => {
    seedTemplate();
    createTemplateExecution("wf-cancel-route", "tmpl-wf");
    createTask({
      id: "cancel-task-1",
      status: "pending",
      prompt: "Step 1",
      config: { timeout: 300, approvalRequired: [], approvalTimeout: 60 },
      createdAt: Date.now(),
      parentId: "wf-cancel-route",
    });
    createTask({
      id: "cancel-task-2",
      status: "running",
      prompt: "Step 2",
      config: { timeout: 300, approvalRequired: [], approvalTimeout: 60 },
      createdAt: Date.now(),
      parentId: "wf-cancel-route",
    });

    const response = await app.inject({
      method: "POST",
      url: "/template-executions/wf-cancel-route/cancel",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { executionId: string; cancelled: number; total: number };
    expect(body).toEqual({
      executionId: "wf-cancel-route",
      cancelled: 2,
      total: 2,
    });

    const { getTask } = await import("../../../store/tasks.js");
    expect(getTemplateExecution("wf-cancel-route")?.status).toBe("cancelled");
    expect(getTask("cancel-task-1")?.status).toBe("cancelled");
    expect(getTask("cancel-task-2")?.status).toBe("cancelled");
  });

  it("marks a TemplateExecution step skipped and cancels its task", async () => {
    seedTemplate();
    createTemplateExecution("wf-skip-route", "tmpl-wf");
    updateTemplateExecution("wf-skip-route", {
      stepStatuses: {
        s1: { taskId: "skip-task-1", status: "running", roleId: "role-1" },
      },
    });
    createTask({
      id: "skip-task-1",
      status: "running",
      prompt: "Step 1",
      config: { timeout: 300, approvalRequired: [], approvalTimeout: 60 },
      createdAt: Date.now(),
      parentId: "wf-skip-route",
      stepId: "s1",
      roleId: "role-1",
    });

    const response = await app.inject({
      method: "POST",
      url: "/template-executions/wf-skip-route/steps/s1/skip",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { executionId: string; stepId: string; status: string };
    expect(body).toEqual({
      executionId: "wf-skip-route",
      stepId: "s1",
      status: "skipped",
    });

    const { getTask } = await import("../../../store/tasks.js");
    expect(getTemplateExecution("wf-skip-route")?.stepStatuses.s1?.status).toBe("skipped");
    expect(getTask("skip-task-1")?.status).toBe("cancelled");
  });

  it("does not register the old execution route", async () => {
    const oldRoute = `/${["work", "flow"].join("")}-executions`;
    const response = await app.inject({
      method: "GET",
      url: oldRoute,
    });

    expect(response.statusCode).toBe(404);
  });

  describe("layerCPassed field (Task 7)", () => {
    function seedTemplateWithContract(templateId: string, hasCustomAssertions: boolean) {
      const template = {
        id: templateId,
        name: "Layer C Test Template",
        trigger: { type: "manual" as const },
        steps: [{
          id: "step-c1",
          prompt: "do thing",
          outputContract: {
            lengthTarget: { min: 100, max: 500, unit: "characters" as const },
            ...(hasCustomAssertions ? { customAssertions: ["thesis must be falsifiable", "must cite a source"] } : {}),
          },
        }],
        rolePreference: "role-layer-c",
        enabled: true,
        createdAt: Date.now(),
      };
      createTaskTemplate(template);
      return template;
    }

    function seedStepTask(taskId: string, executionId: string) {
      createTask({
        id: taskId,
        status: "completed",
        prompt: "test",
        config: {
          timeout: 300,
          approvalRequired: [],
          approvalTimeout: 60,
          outputContractCheckCount: 2,
        },
        createdAt: Date.now(),
        parentId: executionId,
        stepId: "step-c1",
        roleId: "role-layer-c",
      });
    }

    it("layerCPassed is null when step has no customAssertions (Layer C did not run)", async () => {
      seedTemplateWithContract("tmpl-no-ca", false);
      createTemplateExecution("wf-no-ca", "tmpl-no-ca");
      updateTemplateExecution("wf-no-ca", {
        stepStatuses: { "step-c1": { taskId: "task-no-ca", status: "completed", roleId: "role-layer-c" } },
      });
      seedStepTask("task-no-ca", "wf-no-ca");

      const response = await app.inject({ method: "GET", url: "/template-executions/wf-no-ca" });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        execution: { stepStatuses: Record<string, { contract?: { layerAPassed: boolean; layerBPassed: boolean | null; layerCPassed: boolean | null } }> };
      };
      expect(body.execution.stepStatuses["step-c1"]?.contract?.layerCPassed).toBeNull();
    });

    it("layerCPassed is true when customAssertions present and no Layer C violations", async () => {
      seedTemplateWithContract("tmpl-ca-pass", true);
      createTemplateExecution("wf-ca-pass", "tmpl-ca-pass");
      updateTemplateExecution("wf-ca-pass", {
        stepStatuses: { "step-c1": { taskId: "task-ca-pass", status: "completed", roleId: "role-layer-c" } },
      });
      seedStepTask("task-ca-pass", "wf-ca-pass");
      // No Layer C violations recorded → layerCPassed should be true

      const response = await app.inject({ method: "GET", url: "/template-executions/wf-ca-pass" });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        execution: { stepStatuses: Record<string, { contract?: { layerCPassed: boolean | null } }> };
      };
      expect(body.execution.stepStatuses["step-c1"]?.contract?.layerCPassed).toBe(true);
    });

    it("layerCPassed is false when customAssertions present and Layer C violations exist", async () => {
      seedTemplateWithContract("tmpl-ca-fail", true);
      createTemplateExecution("wf-ca-fail", "tmpl-ca-fail");
      updateTemplateExecution("wf-ca-fail", {
        stepStatuses: { "step-c1": { taskId: "task-ca-fail", status: "completed", roleId: "role-layer-c" } },
      });
      seedStepTask("task-ca-fail", "wf-ca-fail");
      recordAuditViolation({
        id: "viol-layerc-1",
        stepTaskId: "task-ca-fail",
        executionId: "wf-ca-fail",
        roleId: "role-layer-c",
        contractField: "customAssertions",
        layer: "C",
        severity: "warning",
        message: "Assertion failed: thesis must be falsifiable — no falsifiable claim found",
        createdAt: Date.now(),
      });

      const response = await app.inject({ method: "GET", url: "/template-executions/wf-ca-fail" });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        execution: { stepStatuses: Record<string, { contract?: { layerCPassed: boolean | null } }> };
      };
      expect(body.execution.stepStatuses["step-c1"]?.contract?.layerCPassed).toBe(false);
    });

    it("regression: layerAPassed and layerBPassed are unchanged by Task 7 changes", async () => {
      seedTemplateWithContract("tmpl-layer-ab-reg", true);
      createTemplateExecution("wf-layer-ab-reg", "tmpl-layer-ab-reg");
      updateTemplateExecution("wf-layer-ab-reg", {
        stepStatuses: { "step-c1": { taskId: "task-layer-ab-reg", status: "completed", roleId: "role-layer-c" } },
      });
      seedStepTask("task-layer-ab-reg", "wf-layer-ab-reg");
      // Record a Layer A violation to verify layerAPassed=false, layerBPassed=null
      recordAuditViolation({
        id: "viol-layera-reg",
        stepTaskId: "task-layer-ab-reg",
        executionId: "wf-layer-ab-reg",
        roleId: "role-layer-c",
        contractField: "lengthTarget",
        layer: "A",
        severity: "error",
        message: "Length violation",
        createdAt: Date.now(),
      });

      const response = await app.inject({ method: "GET", url: "/template-executions/wf-layer-ab-reg" });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        execution: { stepStatuses: Record<string, { contract?: { layerAPassed: boolean; layerBPassed: boolean | null; layerCPassed: boolean | null } }> };
      };
      const contract = body.execution.stepStatuses["step-c1"]?.contract;
      expect(contract?.layerAPassed).toBe(false);
      expect(contract?.layerBPassed).toBeNull(); // Layer A failed → Layer B never ran
      expect(contract?.layerCPassed).toBe(true); // No Layer C violations
    });
  });
});
