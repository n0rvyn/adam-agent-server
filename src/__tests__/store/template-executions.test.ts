import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createEventDef } from "../../store/event-defs.js";
import { createEvent } from "../../store/events.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import {
  createTemplateExecution,
  listDispatchesByEventDef,
  updateTemplateExecution,
} from "../../store/template-executions.js";
import type { TaskTemplate } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedTemplate(id: string, name: string): TaskTemplate {
  const template: TaskTemplate = {
    id,
    name,
    trigger: { type: "manual" },
    steps: [{ id: "step-1", prompt: "run" }],
    rolePreference: "role-test-seed",
    enabled: true,
    createdAt: Date.now(),
  };
  createTaskTemplate(template);
  return template;
}

describe("store/template-executions dispatch listing", () => {
  it("lists TemplateExecutions triggered by an event def newest first", () => {
    createEventDef({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Incoming event",
      sourceType: "webhook",
      sourceConfig: {},
      enabled: true,
    });
    seedTemplate("tmpl-dispatch", "Dispatch Template");

    createEvent({
      id: "22222222-2222-4222-8222-222222222222",
      eventDefId: "11111111-1111-4111-8111-111111111111",
      type: "webhook.event",
      source: "test",
      dedupKey: "event-old",
      payload: { order: "old" },
      occurredAt: "2026-05-01T00:00:00.000Z",
    });
    createEvent({
      id: "33333333-3333-4333-8333-333333333333",
      eventDefId: "11111111-1111-4111-8111-111111111111",
      type: "webhook.event",
      source: "test",
      dedupKey: "event-new",
      payload: { order: "new" },
      occurredAt: "2026-05-01T00:01:00.000Z",
    });

    createTemplateExecution("exec-old", "tmpl-dispatch", "22222222-2222-4222-8222-222222222222");
    createTemplateExecution("exec-new", "tmpl-dispatch", "33333333-3333-4333-8333-333333333333");
    updateTemplateExecution("exec-old", { status: "completed", completedAt: 1000 });
    updateTemplateExecution("exec-new", { status: "completed", completedAt: 2000 });
    getTestDb().prepare("UPDATE template_executions SET started_at = ? WHERE id = ?").run(1000, "exec-old");
    getTestDb().prepare("UPDATE template_executions SET started_at = ? WHERE id = ?").run(2000, "exec-new");

    const dispatches = listDispatchesByEventDef("11111111-1111-4111-8111-111111111111");

    expect(dispatches.map((dispatch) => dispatch.executionId)).toEqual(["exec-new", "exec-old"]);
    expect(dispatches[0]).toMatchObject({
      templateId: "tmpl-dispatch",
      templateName: "Dispatch Template",
      status: "completed",
      eventId: "33333333-3333-4333-8333-333333333333",
      eventPayload: { order: "new" },
    });
  });
});
