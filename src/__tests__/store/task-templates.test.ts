import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { existsSync } from "node:fs";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  createTaskTemplate,
  getTaskTemplate,
  listTaskTemplates,
  updateTaskTemplate,
  deleteTaskTemplate,
  enableTaskTemplate,
  disableTaskTemplate,
  getTaskTemplateDependents,
} from "../../store/task-templates.js";
import { ensureArtifactsDir, getArtifactsDir } from "../../lib/artifact-storage.js";
import type { TaskTemplate } from "../../shared/types.js";

const LEGACY_COMPLETE_TRIGGER = ["work", "flow_complete"].join("");

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function makeTemplate(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    id: overrides.id ?? `tmpl-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? "Test Template",
    description: overrides.description,
    trigger: overrides.trigger ?? { type: "manual" },
    steps: overrides.steps ?? [{ id: "s1", prompt: "Do something" }],
    rolePreference: overrides.rolePreference ?? "role-test-seed",
    config: overrides.config,
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt,
  };
}

describe("store/task-templates", () => {
  describe("createTaskTemplate + getTaskTemplate", () => {
    it("should create and retrieve a template", () => {
      const tmpl = makeTemplate({ id: "tmpl-1", name: "My Template" });
      createTaskTemplate(tmpl);

      const retrieved = getTaskTemplate("tmpl-1");
      expect(retrieved).toBeDefined();
      expect(retrieved!.name).toBe("My Template");
      expect(retrieved!.enabled).toBe(true);
      expect(retrieved!.steps).toEqual([{ id: "s1", prompt: "Do something" }]);
    });

    it("should return undefined for non-existent template", () => {
      expect(getTaskTemplate("nonexistent")).toBeUndefined();
    });

    it("should store cron trigger details", () => {
      const tmpl = makeTemplate({
        id: "tmpl-cron",
        trigger: { type: "cron", cron: "0 */6 * * *" },
      });
      createTaskTemplate(tmpl);

      const retrieved = getTaskTemplate("tmpl-cron");
      expect(retrieved!.trigger.type).toBe("cron");
      expect(retrieved!.trigger.cron).toBe("0 */6 * * *");
    });

    it("should store and retrieve event trigger with eventDefId", () => {
      const eventDefId = "550e8400-e29b-41d4-a716-446655440000";
      const tmpl = makeTemplate({
        id: "tmpl-event",
        trigger: { type: "event", eventDefId },
      });
      createTaskTemplate(tmpl);

      const retrieved = getTaskTemplate("tmpl-event");
      expect(retrieved!.trigger.type).toBe("event");
      expect(retrieved!.trigger.eventDefId).toBe(eventDefId);
      expect(retrieved!.trigger.event).toBeUndefined();
    });

    it("creates a valid Template with one step", () => {
      const tmpl = makeTemplate({
        id: "tmpl-one-step",
        steps: [{ id: "extract", prompt: "Extract data" }],
      });

      createTaskTemplate(tmpl);

      expect(getTaskTemplate("tmpl-one-step")!.steps).toEqual([
        { id: "extract", prompt: "Extract data" },
      ]);
    });

    it("creates a valid Template with multiple dependent steps", () => {
      const tmpl = makeTemplate({
        id: "tmpl-many-steps",
        steps: [
          { id: "extract", prompt: "Extract data" },
          { id: "summarize", prompt: "Summarize data", dependsOn: ["extract"] },
        ],
      });

      createTaskTemplate(tmpl);

      expect(getTaskTemplate("tmpl-many-steps")!.steps).toHaveLength(2);
    });

    it("rejects a Template with duplicate step IDs", () => {
      const tmpl = makeTemplate({
        steps: [
          { id: "same", prompt: "First" },
          { id: "same", prompt: "Second" },
        ],
      });

      expect(() => createTaskTemplate(tmpl)).toThrow(/duplicate step id/);
    });

    it("rejects a Template with an unknown dependency", () => {
      const tmpl = makeTemplate({
        steps: [
          { id: "extract", prompt: "Extract" },
          { id: "summarize", prompt: "Summarize", dependsOn: ["missing"] },
        ],
      });

      expect(() => createTaskTemplate(tmpl)).toThrow(/depends on unknown step/);
    });

    it("rejects a Template with a self dependency", () => {
      const tmpl = makeTemplate({
        steps: [{ id: "extract", prompt: "Extract", dependsOn: ["extract"] }],
      });

      expect(() => createTaskTemplate(tmpl)).toThrow(/cannot depend on itself/);
    });

    it("rejects a Template with a dependency cycle", () => {
      const tmpl = makeTemplate({
        steps: [
          { id: "a", prompt: "A", dependsOn: ["b"] },
          { id: "b", prompt: "B", dependsOn: ["a"] },
        ],
      });

      expect(() => createTaskTemplate(tmpl)).toThrow(/dependencies contain a cycle/);
    });

    it("rejects a Template with removed completion trigger input", () => {
      const tmpl = makeTemplate({
        trigger: { type: LEGACY_COMPLETE_TRIGGER, event: `${LEGACY_COMPLETE_TRIGGER}:tmpl-old` } as any,
      });

      expect(() => createTaskTemplate(tmpl)).toThrow(/trigger type is not supported/);
    });
  });

  describe("listTaskTemplates", () => {
    it("should list all templates", () => {
      createTaskTemplate(makeTemplate({ id: "t1", enabled: true }));
      createTaskTemplate(makeTemplate({ id: "t2", enabled: false }));

      const all = listTaskTemplates();
      expect(all.length).toBe(2);
    });

    it("should filter enabled only", () => {
      createTaskTemplate(makeTemplate({ id: "t1", enabled: true }));
      createTaskTemplate(makeTemplate({ id: "t2", enabled: false }));

      const enabled = listTaskTemplates(true);
      expect(enabled.length).toBe(1);
      expect(enabled[0].id).toBe("t1");
    });

    it("should respect limit and offset", () => {
      for (let i = 0; i < 5; i++) {
        createTaskTemplate(makeTemplate({ id: `t-${i}`, createdAt: Date.now() + i }));
      }
      const page = listTaskTemplates(false, 2, 1);
      expect(page.length).toBe(2);
    });
  });

  describe("updateTaskTemplate", () => {
    it("should update name", () => {
      createTaskTemplate(makeTemplate({ id: "upd-1", name: "Original" }));
      updateTaskTemplate("upd-1", { name: "Updated" });

      const retrieved = getTaskTemplate("upd-1");
      expect(retrieved!.name).toBe("Updated");
      expect(retrieved!.updatedAt).toBeDefined();
    });

    it("should update trigger", () => {
      createTaskTemplate(makeTemplate({ id: "upd-2" }));
      updateTaskTemplate("upd-2", { trigger: { type: "cron", cron: "0 0 * * *" } });

      const retrieved = getTaskTemplate("upd-2");
      expect(retrieved!.trigger.type).toBe("cron");
      expect(retrieved!.trigger.cron).toBe("0 0 * * *");
    });

    it("should update enabled flag", () => {
      createTaskTemplate(makeTemplate({ id: "upd-3", enabled: true }));
      updateTaskTemplate("upd-3", { enabled: false });

      const retrieved = getTaskTemplate("upd-3");
      expect(retrieved!.enabled).toBe(false);
    });
  });

  describe("enableTaskTemplate / disableTaskTemplate", () => {
    it("should enable a disabled template", () => {
      createTaskTemplate(makeTemplate({ id: "tog-1", enabled: false }));
      enableTaskTemplate("tog-1");

      const retrieved = getTaskTemplate("tog-1");
      expect(retrieved!.enabled).toBe(true);
    });

    it("should disable an enabled template", () => {
      createTaskTemplate(makeTemplate({ id: "tog-2", enabled: true }));
      disableTaskTemplate("tog-2");

      const retrieved = getTaskTemplate("tog-2");
      expect(retrieved!.enabled).toBe(false);
    });
  });

  describe("deleteTaskTemplate", () => {
    it("should delete a template", () => {
      createTaskTemplate(makeTemplate({ id: "del-1" }));
      expect(getTaskTemplate("del-1")).toBeDefined();

      deleteTaskTemplate("del-1");
      expect(getTaskTemplate("del-1")).toBeUndefined();
    });

    it("should return dependents counts for a template with executions and tasks", () => {
      const db = getTestDb();
      createTaskTemplate(makeTemplate({ id: "dep-1" }));
      db.prepare(
        "INSERT INTO template_executions (id, template_id, status, step_statuses, started_at) VALUES (?, ?, 'completed', '{}', ?)",
      ).run("we-1", "dep-1", Date.now());
      db.prepare(
        "INSERT INTO tasks (id, status, prompt, config, template_id, created_at) VALUES (?, 'completed', 'p', '{}', ?, ?)",
      ).run("t-1", "dep-1", Date.now());

      const deps = getTaskTemplateDependents("dep-1");
      expect(deps.executionCount).toBe(1);
      expect(deps.taskCount).toBe(1);
    });

    it("template_only mode: deletes template + executions, keeps tasks as orphans", () => {
      const db = getTestDb();
      createTaskTemplate(makeTemplate({ id: "del-2" }));
      db.prepare(
        "INSERT INTO template_executions (id, template_id, status, step_statuses, started_at) VALUES (?, ?, 'completed', '{}', ?)",
      ).run("we-2", "del-2", Date.now());
      db.prepare(
        "INSERT INTO tasks (id, status, prompt, config, template_id, created_at) VALUES (?, 'completed', 'p', '{}', ?, ?)",
      ).run("t-2", "del-2", Date.now());

      deleteTaskTemplate("del-2", "template_only");

      expect(getTaskTemplate("del-2")).toBeUndefined();
      const execCount = (db.prepare("SELECT COUNT(*) AS n FROM template_executions WHERE template_id = ?").get("del-2") as { n: number }).n;
      expect(execCount).toBe(0);
      const taskRow = db.prepare("SELECT id, template_id FROM tasks WHERE id = ?").get("t-2") as { id: string; template_id: string } | undefined;
      expect(taskRow).toBeDefined();
      expect(taskRow!.template_id).toBe("del-2");
    });

    it("template_only mode removes TemplateExecution artifact directories after DB deletion", () => {
      const db = getTestDb();
      createTaskTemplate(makeTemplate({ id: "del-artifacts" }));
      db.prepare(
        "INSERT INTO template_executions (id, template_id, status, step_statuses, started_at) VALUES (?, ?, 'completed', '{}', ?)",
      ).run("exec-del-artifacts", "del-artifacts", Date.now());
      const artifactsDir = ensureArtifactsDir("exec-del-artifacts");
      expect(existsSync(artifactsDir)).toBe(true);

      deleteTaskTemplate("del-artifacts");

      expect(getTaskTemplate("del-artifacts")).toBeUndefined();
      expect((db.prepare("SELECT COUNT(*) AS n FROM template_executions WHERE template_id = ?").get("del-artifacts") as { n: number }).n).toBe(0);
      expect(existsSync(getArtifactsDir("exec-del-artifacts"))).toBe(false);
    });

    it("with_tasks mode: full cascade — deletes template/executions/tasks/role_scores/manager_decisions; nulls approval_rules/chat_messages", () => {
      const db = getTestDb();
      createTaskTemplate(makeTemplate({ id: "del-3" }));
      db.prepare(
        "INSERT INTO template_executions (id, template_id, status, step_statuses, started_at) VALUES (?, ?, 'completed', '{}', ?)",
      ).run("we-3", "del-3", Date.now());
      db.prepare(
        "INSERT INTO tasks (id, status, prompt, config, template_id, created_at) VALUES (?, 'completed', 'p', '{}', ?, ?)",
      ).run("t-3", "del-3", Date.now());
      db.prepare(
        "INSERT INTO role_scores (id, role_id, task_id, score_json, ema_score, created_at) VALUES (?, ?, ?, '{}', 0.5, ?)",
      ).run("rs-3", "role-x", "t-3", Date.now());
      db.prepare(
        "INSERT INTO approval_rules (id, task_pattern, max_risk_level, created_at, created_by_task_id) VALUES (?, 'p', 'low', ?, ?)",
      ).run("ar-3", Date.now(), "t-3");
      const now = Date.now();
      db.prepare(
        "INSERT INTO chat_sessions (id, status, source_type, title, created_at, last_active_at) VALUES (?, 'active', 'web', 't', ?, ?)",
      ).run("cs-3", now, now);
      db.prepare(
        "INSERT INTO chat_messages (id, session_id, role, content, source_type, task_id, created_at) VALUES (?, ?, 'assistant', 'hi', 'web', ?, ?)",
      ).run("cm-3", "cs-3", "t-3", Date.now());
      db.prepare(
        "INSERT INTO manager_decisions (id, task_id, decision_type, created_at) VALUES (?, ?, 'dispatch', ?)",
      ).run("md-3", "t-3", Date.now());

      deleteTaskTemplate("del-3", "with_tasks");

      expect(getTaskTemplate("del-3")).toBeUndefined();
      expect((db.prepare("SELECT COUNT(*) AS n FROM template_executions WHERE template_id = ?").get("del-3") as { n: number }).n).toBe(0);
      expect(db.prepare("SELECT id FROM tasks WHERE id = ?").get("t-3")).toBeUndefined();
      expect(db.prepare("SELECT id FROM role_scores WHERE task_id = ?").get("t-3")).toBeUndefined();
      expect(db.prepare("SELECT id FROM manager_decisions WHERE id = ?").get("md-3")).toBeUndefined();
      const rule = db.prepare("SELECT id, created_by_task_id FROM approval_rules WHERE id = ?").get("ar-3") as { id: string; created_by_task_id: string | null };
      expect(rule).toBeDefined();
      expect(rule.created_by_task_id).toBeNull();
      const msg = db.prepare("SELECT id, task_id FROM chat_messages WHERE id = ?").get("cm-3") as { id: string; task_id: string | null };
      expect(msg).toBeDefined();
      expect(msg.task_id).toBeNull();
    });

    it("default mode is template_only (backward compat)", () => {
      const db = getTestDb();
      createTaskTemplate(makeTemplate({ id: "del-4" }));
      db.prepare(
        "INSERT INTO tasks (id, status, prompt, config, template_id, created_at) VALUES (?, 'completed', 'p', '{}', ?, ?)",
      ).run("t-4", "del-4", Date.now());

      deleteTaskTemplate("del-4");

      expect(getTaskTemplate("del-4")).toBeUndefined();
      expect(db.prepare("SELECT id FROM tasks WHERE id = ?").get("t-4")).toBeDefined();
    });
  });
});
