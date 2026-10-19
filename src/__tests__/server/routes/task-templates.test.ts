import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { existsSync } from "node:fs";
import { v4 as uuidv4 } from "uuid";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import Fastify from "fastify";
import { taskTemplateRoutes } from "../../../server/routes/task-templates.js";
import { createTaskTemplate, getTaskTemplate } from "../../../store/task-templates.js";
import { ensureArtifactsDir, getArtifactsDir } from "../../../lib/artifact-storage.js";
import { createRole } from "../../../store/roles.js";
import type { TaskTemplate, Role } from "../../../shared/types.js";

const LEGACY_COMPLETE_TRIGGER = ["work", "flow_complete"].join("");

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function createMockBreeEngine() {
  return {
    scheduleJob: vi.fn().mockResolvedValue(undefined),
    unscheduleJob: vi.fn().mockResolvedValue(undefined),
    scheduleOnceJob: vi.fn(),
    runNow: vi.fn().mockResolvedValue("exec-123"),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTemplate(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    id: `tmpl-${Math.random().toString(36).slice(2)}`,
    name: "Test Template",
    trigger: { type: "manual" },
    steps: [{ id: "s1", prompt: "Do it" }],
    rolePreference: "role-test-seed",
      enabled: true,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: `role-${Math.random().toString(36).slice(2)}`,
    name: "Template Route Role",
    cagPrompt: "Route role prompt",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `mem-${Math.random().toString(36).slice(2)}`,
    status: "active",
    preferences: {},
    createdAt: Date.now(),
    ...overrides,
  };
}

async function buildApp() {
  const breeEngine = createMockBreeEngine();
  const app = Fastify();
  await app.register(async (instance) => {
    await taskTemplateRoutes(instance, breeEngine as any);
  });
  await app.ready();
  return { app, breeEngine };
}

describe("server/routes/task-templates", () => {
  describe("POST /task-templates", () => {
    it("should create a template and return 201", async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/task-templates",
        payload: {
          name: "Daily Report",
          trigger: { type: "cron", cron: "0 9 * * *" },
          steps: [{ id: "step-1", prompt: "Generate report" }],
          rolePreference: "role-test-seed",
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().templateId).toBeDefined();
      await app.close();
    });

    it("should return 400 for invalid body", async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/task-templates",
        payload: { name: "" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("should schedule cron job when enabled", async () => {
      const { app, breeEngine } = await buildApp();
      await app.inject({
        method: "POST",
        url: "/task-templates",
        payload: {
          name: "Cron Job",
          trigger: { type: "cron", cron: "0 0 * * *" },
          steps: [{ id: "s1", prompt: "run" }],
          rolePreference: "role-test-seed",
      enabled: true,
        },
      });
      expect(breeEngine.scheduleJob).toHaveBeenCalled();
      await app.close();
    });
  });

  describe("GET /task-templates", () => {
    it("should list all templates", async () => {
      createTaskTemplate(makeTemplate({ id: "t1", name: "Template One" }));
      createTaskTemplate(makeTemplate({ id: "t2", name: "Template Two" }));

      const { app } = await buildApp();
      const res = await app.inject({ method: "GET", url: "/task-templates" });
      expect(res.statusCode).toBe(200);
      expect(res.json().templates.length).toBe(2);
      await app.close();
    });

    it("should filter enabled templates", async () => {
      createTaskTemplate(makeTemplate({ id: "t-on", enabled: true }));
      createTaskTemplate(makeTemplate({ id: "t-off", enabled: false }));

      const { app } = await buildApp();
      const res = await app.inject({ method: "GET", url: "/task-templates?enabled=true" });
      expect(res.statusCode).toBe(200);
      expect(res.json().templates.length).toBe(1);
      await app.close();
    });
  });

  describe("GET /task-templates/:id", () => {
    it("should return a specific template", async () => {
      createTaskTemplate(makeTemplate({ id: "t-get", name: "Specific" }));

      const { app } = await buildApp();
      const res = await app.inject({ method: "GET", url: "/task-templates/t-get" });
      expect(res.statusCode).toBe(200);
      expect(res.json().template.name).toBe("Specific");
      await app.close();
    });

    it("should return 404 for non-existent template", async () => {
      const { app } = await buildApp();
      const res = await app.inject({ method: "GET", url: "/task-templates/nope" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  describe("GET /task-templates — response completeness", () => {
    it("should return all template fields including steps and trigger", async () => {
      createTaskTemplate(makeTemplate({
        id: "t-full",
        name: "Full Template",
        description: "A complete template",
        trigger: { type: "cron", cron: "0 9 * * *" },
        steps: [{ id: "s1", prompt: "Step one" }, { id: "s2", prompt: "Step two" }],
        rolePreference: "role-test-seed",
      enabled: true,
        tags: ["test", "full"],
      }));

      const { app } = await buildApp();
      const res = await app.inject({ method: "GET", url: "/task-templates" });
      const tmpl = res.json().templates[0];

      // Core fields
      expect(tmpl.id).toBe("t-full");
      expect(tmpl.name).toBe("Full Template");
      expect(tmpl.description).toBe("A complete template");
      expect(tmpl.enabled).toBe(true);
      expect(tmpl.createdAt).toBeTypeOf("number");

      // Trigger — the field that caused pad() crash when missing
      expect(tmpl.trigger).toBeDefined();
      expect(tmpl.trigger.type).toBe("cron");
      expect(tmpl.trigger.cron).toBe("0 9 * * *");

      // Steps — the field stripped by fast-json-stringify causing handleEdit crash
      expect(tmpl.steps).toBeDefined();
      expect(tmpl.steps).toHaveLength(2);
      expect(tmpl.steps[0].prompt).toBe("Step one");

      // Optional fields
      expect(tmpl.tags).toEqual(["test", "full"]);

      await app.close();
    });

    it("should return complete template on GET by ID", async () => {
      createTaskTemplate(makeTemplate({
        id: "t-byid",
        steps: [{ id: "s1", prompt: "Do something" }],
        trigger: { type: "manual" },
      }));

      const { app } = await buildApp();
      const res = await app.inject({ method: "GET", url: "/task-templates/t-byid" });
      const tmpl = res.json().template;

      expect(tmpl.steps).toBeDefined();
      expect(tmpl.steps).toHaveLength(1);
      expect(tmpl.trigger.type).toBe("manual");

      await app.close();
    });
  });

  describe("PATCH /task-templates/:id", () => {
    it("should update a template", async () => {
      createTaskTemplate(makeTemplate({ id: "t-patch", name: "Before" }));

      const { app } = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/task-templates/t-patch",
        payload: { name: "After" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().templateId).toBe("t-patch");
      await app.close();
    });

    it("should return 404 for non-existent template", async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/task-templates/nope",
        payload: { name: "X" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("should reschedule cron job when enabled state changes", async () => {
      createTaskTemplate(makeTemplate({
        id: "t-toggle",
        trigger: { type: "cron", cron: "0 9 * * *" },
        enabled: true,
      }));

      const { app, breeEngine } = await buildApp();

      // Disable
      const disableRes = await app.inject({
        method: "PATCH",
        url: "/task-templates/t-toggle",
        payload: { enabled: false },
      });
      expect(disableRes.statusCode).toBe(200);
      expect(breeEngine.unscheduleJob).toHaveBeenCalledWith("t-toggle");
      // scheduleJob should NOT be called since enabled is now false
      expect(breeEngine.scheduleJob).not.toHaveBeenCalled();

      vi.clearAllMocks();

      // Re-enable
      const enableRes = await app.inject({
        method: "PATCH",
        url: "/task-templates/t-toggle",
        payload: { enabled: true },
      });
      expect(enableRes.statusCode).toBe(200);
      expect(breeEngine.unscheduleJob).toHaveBeenCalledWith("t-toggle");
      expect(breeEngine.scheduleJob).toHaveBeenCalledWith("t-toggle");

      await app.close();
    });

    it("returns STEP_AUTOSELECT_NEEDS_REQUIREMENTS when autoSelectRole=true omits requirements", async () => {
      createTaskTemplate(makeTemplate({ id: "t-auto-req" }));

      const { app } = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/task-templates/t-auto-req",
        payload: {
          steps: [{ id: "s1", prompt: "Run", autoSelectRole: true }],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: "STEP_AUTOSELECT_NEEDS_REQUIREMENTS",
        failingStepIds: ["s1"],
      });
      await app.close();
    });

    it("returns STEP_ROLE_NOT_FOUND when an explicit roleId does not exist", async () => {
      createTaskTemplate(makeTemplate({ id: "t-role-missing" }));

      const { app } = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/task-templates/t-role-missing",
        payload: {
          steps: [{ id: "s1", prompt: "Run", roleId: "missing-role" }],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: "STEP_ROLE_NOT_FOUND",
        failingStepIds: ["s1"],
      });
      await app.close();
    });

    it("returns STEP_ROLE_NOT_FOUND when an explicit roleId is retired", async () => {
      createRole(makeRole({ id: "role-retired", status: "retired" }));
      createTaskTemplate(makeTemplate({ id: "t-role-retired" }));

      const { app } = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/task-templates/t-role-retired",
        payload: {
          steps: [{ id: "s1", prompt: "Run", roleId: "role-retired" }],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: "STEP_ROLE_NOT_FOUND",
        failingStepIds: ["s1"],
      });
      await app.close();
    });

    it("keeps disable-only PATCH as a validation bypass for already-broken templates", async () => {
      const db = getTestDb();
      createTaskTemplate(makeTemplate({ id: "t-disable-only" }));
      db.prepare("UPDATE task_templates SET steps = ? WHERE id = ?").run(
        JSON.stringify([{ id: "s1", prompt: "Broken", autoSelectRole: true }]),
        "t-disable-only",
      );

      const { app } = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/task-templates/t-disable-only",
        payload: { enabled: false },
      });

      expect(res.statusCode).toBe(200);
      expect(getTaskTemplate("t-disable-only")?.enabled).toBe(false);
      await app.close();
    });
  });

  describe("POST /task-templates/:id/run", () => {
    it("should trigger a template execution", async () => {
      createTaskTemplate(makeTemplate({ id: "t-run" }));

      const { app, breeEngine } = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/task-templates/t-run/run",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().executionId).toBe("exec-123");
      expect(res.json().monitorUrl).toBe("/template-executions/exec-123");
      expect(res.json().warnings).toEqual(["manual-run-no-report-target"]);
      expect(breeEngine.runNow).toHaveBeenCalledWith("t-run", {
        originReportTo: undefined,
        triggerContext: { source: "manual-api", reason: undefined, rerunMode: undefined },
      });
      await app.close();
    });

    it("passes manual report target into run context", async () => {
      createTaskTemplate(makeTemplate({ id: "t-run-report" }));

      const { app, breeEngine } = await buildApp();
      const reportTo = [{ type: "channel", channelId: "wechat-1", chatId: "chat-1" }];
      const res = await app.inject({
        method: "POST",
        url: "/task-templates/t-run-report/run",
        payload: { reportTo, reason: "real daily check", rerunMode: "rerun" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().warnings).toEqual([]);
      expect(breeEngine.runNow).toHaveBeenCalledWith("t-run-report", {
        originReportTo: reportTo,
        triggerContext: { source: "manual-api", reason: "real daily check", rerunMode: "rerun" },
      });
      await app.close();
    });

    it("should return 404 for non-existent template", async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/task-templates/nope/run",
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  describe("DELETE /task-templates/:id", () => {
    it("should delete a template", async () => {
      createTaskTemplate(makeTemplate({ id: "t-del" }));

      const { app, breeEngine } = await buildApp();
      const res = await app.inject({ method: "DELETE", url: "/task-templates/t-del" });
      expect(res.statusCode).toBe(200);
      expect(res.json().deleted).toBe(true);
      expect(breeEngine.unscheduleJob).toHaveBeenCalledWith("t-del");

      // Verify deleted from DB
      expect(getTaskTemplate("t-del")).toBeUndefined();
      await app.close();
    });

    it("should return 404 when deleting non-existent template", async () => {
      const { app } = await buildApp();
      const res = await app.inject({ method: "DELETE", url: "/task-templates/no-such" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("should default to template_only mode (no query param)", async () => {
      const db = getTestDb();
      createTaskTemplate(makeTemplate({ id: "t-mode-default" }));
      db.prepare(
        "INSERT INTO tasks (id, status, prompt, config, template_id, created_at) VALUES (?, 'completed', 'p', '{}', ?, ?)",
      ).run("task-default", "t-mode-default", Date.now());

      const { app } = await buildApp();
      const res = await app.inject({ method: "DELETE", url: "/task-templates/t-mode-default" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.mode).toBe("template_only");
      expect(body.deletedCounts.tasks).toBe(0);
      expect(body.deletedCounts.template).toBe(1);
      expect(db.prepare("SELECT id FROM tasks WHERE id = ?").get("task-default")).toBeDefined();
      await app.close();
    });

    it("should cascade tasks with mode=with_tasks", async () => {
      const db = getTestDb();
      createTaskTemplate(makeTemplate({ id: "t-with-tasks" }));
      db.prepare(
        "INSERT INTO tasks (id, status, prompt, config, template_id, created_at) VALUES (?, 'completed', 'p', '{}', ?, ?)",
      ).run("task-a", "t-with-tasks", Date.now());
      db.prepare(
        "INSERT INTO template_executions (id, template_id, status, step_statuses, started_at) VALUES (?, ?, 'completed', '{}', ?)",
      ).run("we-a", "t-with-tasks", Date.now());

      const { app } = await buildApp();
      const res = await app.inject({ method: "DELETE", url: "/task-templates/t-with-tasks?mode=with_tasks" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.mode).toBe("with_tasks");
      expect(body.deletedCounts.tasks).toBe(1);
      expect(body.deletedCounts.templateExecutions).toBe(1);
      expect(db.prepare("SELECT id FROM tasks WHERE id = ?").get("task-a")).toBeUndefined();
      await app.close();
    });

    it("should remove TemplateExecution artifact directories when deleting through the API", async () => {
      const db = getTestDb();
      createTaskTemplate(makeTemplate({ id: "t-del-artifacts" }));
      db.prepare(
        "INSERT INTO template_executions (id, template_id, status, step_statuses, started_at) VALUES (?, ?, 'completed', '{}', ?)",
      ).run("exec-api-artifacts", "t-del-artifacts", Date.now());
      const artifactsDir = ensureArtifactsDir("exec-api-artifacts");
      expect(existsSync(artifactsDir)).toBe(true);

      const { app } = await buildApp();
      const res = await app.inject({ method: "DELETE", url: "/task-templates/t-del-artifacts" });

      expect(res.statusCode).toBe(200);
      expect((db.prepare("SELECT COUNT(*) AS n FROM template_executions WHERE template_id = ?").get("t-del-artifacts") as { n: number }).n).toBe(0);
      expect(existsSync(getArtifactsDir("exec-api-artifacts"))).toBe(false);
      await app.close();
    });

    it("should reject invalid mode with 400", async () => {
      createTaskTemplate(makeTemplate({ id: "t-bad-mode" }));
      const { app } = await buildApp();
      const res = await app.inject({ method: "DELETE", url: "/task-templates/t-bad-mode?mode=nuke_everything" });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("GET /task-templates/:id/dependents", () => {
    it("should return zero counts for a template with no dependents", async () => {
      createTaskTemplate(makeTemplate({ id: "t-deps-empty" }));
      const { app } = await buildApp();
      const res = await app.inject({ method: "GET", url: "/task-templates/t-deps-empty/dependents" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.dependents.executionCount).toBe(0);
      expect(body.dependents.taskCount).toBe(0);
      await app.close();
    });

    it("should return correct counts for a template with executions and tasks", async () => {
      const db = getTestDb();
      createTaskTemplate(makeTemplate({ id: "t-deps-full" }));
      db.prepare(
        "INSERT INTO template_executions (id, template_id, status, step_statuses, started_at) VALUES (?, ?, 'completed', '{}', ?)",
      ).run("we-deps-1", "t-deps-full", Date.now());
      db.prepare(
        "INSERT INTO template_executions (id, template_id, status, step_statuses, started_at) VALUES (?, ?, 'completed', '{}', ?)",
      ).run("we-deps-2", "t-deps-full", Date.now());
      db.prepare(
        "INSERT INTO tasks (id, status, prompt, config, template_id, created_at) VALUES (?, 'completed', 'p', '{}', ?, ?)",
      ).run("task-deps-1", "t-deps-full", Date.now());

      const { app } = await buildApp();
      const res = await app.inject({ method: "GET", url: "/task-templates/t-deps-full/dependents" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.dependents.executionCount).toBe(2);
      expect(body.dependents.taskCount).toBe(1);
      await app.close();
    });

    it("should return 404 for missing template", async () => {
      const { app } = await buildApp();
      const res = await app.inject({ method: "GET", url: "/task-templates/no-such/dependents" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  describe("trigger refine — trigger.type vs required fields", () => {
    // Import triggerSchema from the route module via the buildApp helper
    it.each([
      ["cron with cron string", { type: "cron", cron: "* * * * *" }, true],
      ["cron without cron string", { type: "cron" }, false],
      ["once with runAt", { type: "once", runAt: "2026-04-15T10:00:00Z" }, true],
      ["once without runAt", { type: "once" }, false],
      ["template_complete valid", { type: "template_complete", event: "template_complete:abc-123" }, true],
      ["template_complete missing event", { type: "template_complete" }, false],
      ["template_complete wrong prefix", { type: "template_complete", event: `${LEGACY_COMPLETE_TRIGGER}:abc` }, false],
      ["removed completion trigger type", { type: LEGACY_COMPLETE_TRIGGER, event: `${LEGACY_COMPLETE_TRIGGER}:abc-123` }, false],
      ["manual minimal", { type: "manual" }, true],
      ["valid type 'event' with eventDefId", { type: "event", eventDefId: uuidv4() }, true],
      ["invalid type 'event' missing eventDefId", { type: "event" }, false],
      ["invalid type (removed 'task_complete')", { type: "task_complete" }, false],
      // Note: discriminatedUnion strict field check rejects stray fields — these now fail as expected
      ["cron with stray event field (strict check)", { type: "cron", cron: "* * * * *", event: "bogus" }, false],
      ["event with stray cron field (strict check)", { type: "event", eventDefId: uuidv4(), cron: "0 0 * * *" }, false],
    ])("trigger refine — %s", async (_, trigger, valid) => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/task-templates",
        payload: { name: "refine-test", trigger, steps: [{ id: "s1", prompt: "test" }], rolePreference: "role-test-seed" },
      });
      expect(res.statusCode).toBe(valid ? 201 : 400);
    });
  });

  describe("Template step validation", () => {
    it.each([
      ["duplicate step IDs", [{ id: "same", prompt: "A" }, { id: "same", prompt: "B" }], "TEMPLATE_STEP_ID_DUPLICATE"],
      ["unknown dependency", [{ id: "a", prompt: "A" }, { id: "b", prompt: "B", dependsOn: ["missing"] }], "TEMPLATE_DEPENDENCY_UNKNOWN"],
      ["self dependency", [{ id: "a", prompt: "A", dependsOn: ["a"] }], "TEMPLATE_DEPENDENCY_SELF"],
      ["dependency cycle", [{ id: "a", prompt: "A", dependsOn: ["b"] }, { id: "b", prompt: "B", dependsOn: ["a"] }], "TEMPLATE_DEPENDENCY_CYCLE"],
    ])("rejects %s", async (_, steps, code) => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/task-templates",
        payload: {
          name: "invalid-template",
          trigger: { type: "manual" },
          steps,
          rolePreference: "role-test-seed",
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(code);
      await app.close();
    });
  });
});
