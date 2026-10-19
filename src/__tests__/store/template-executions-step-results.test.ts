/**
 * Unit tests for template_executions.step_results_json persistence helpers.
 * Phase 2 DP-001 Option C — setExecutionStepResults + round-trip via getTemplateExecution.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createTemplateExecution, getTemplateExecution, setExecutionStepResults } from "../../store/template-executions.js";
import type { StepResult } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

// Insert template directly so we bypass the steps-validator (not testing template creation here)
function seedTemplate(id: string) {
  getTestDb().prepare(`
    INSERT OR IGNORE INTO task_templates (
      id, name, description, trigger_type, trigger_cron, steps, config, enabled,
      created_at, is_preset, preset_id, deliver_to, report_to
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `Template ${id}`,
    null,
    "manual",
    null,
    "[]",
    "{}",
    1,
    Date.now(),
    0,
    null,
    null,
    null,
  );
}

describe("template_executions.step_results_json round-trip", () => {

  it("setExecutionStepResults writes Map as JSON array; getTemplateExecution returns it", () => {
    seedTemplate("tmpl-1");
    createTemplateExecution("exec-step-results-1", "tmpl-1");
    const stepResults = new Map<string, StepResult>([
      ["step-a", { stepId: "step-a", taskId: "task-a", status: "completed", result: "Result A", roleName: "RoleA" }],
      ["step-b", { stepId: "step-b", taskId: "task-b", status: "failed", error: "Step B failed" }],
      ["step-c", { stepId: "step-c", taskId: "task-c", status: "skipped", error: "Step C skipped" }],
    ]);

    setExecutionStepResults("exec-step-results-1", stepResults);
    const execution = getTemplateExecution("exec-step-results-1");

    expect(execution).toBeDefined();
    expect(execution!.stepResultsJson).toBeDefined();

    // Parse the stored JSON
    const parsed = JSON.parse(execution!.stepResultsJson!) as Array<[string, StepResult]>;
    const parsedMap = new Map(parsed);

    // Map order is preserved
    expect([...parsedMap.keys()]).toEqual(["step-a", "step-b", "step-c"]);
    expect(parsedMap.get("step-a")).toMatchObject({ status: "completed", result: "Result A", roleName: "RoleA" });
    expect(parsedMap.get("step-b")).toMatchObject({ status: "failed", error: "Step B failed" });
    expect(parsedMap.get("step-c")).toMatchObject({ status: "skipped", error: "Step C skipped" });
  });

  it("empty stepResults writes '[]' to step_results_json", () => {
    seedTemplate("tmpl-1");
    createTemplateExecution("exec-empty-results", "tmpl-1");
    setExecutionStepResults("exec-empty-results", new Map());
    const execution = getTemplateExecution("exec-empty-results");
    expect(execution!.stepResultsJson).toBe("[]");
  });

  it("overwrites previous step_results_json", () => {
    seedTemplate("tmpl-1");
    createTemplateExecution("exec-overwrite", "tmpl-1");
    setExecutionStepResults("exec-overwrite", new Map([["old-step", { stepId: "old-step", taskId: "old-task", status: "completed", result: "old" }]]));

    setExecutionStepResults("exec-overwrite", new Map([["new-step", { stepId: "new-step", taskId: "new-task", status: "completed", result: "new" }]]));
    const execution = getTemplateExecution("exec-overwrite");
    const parsed = JSON.parse(execution!.stepResultsJson!) as Array<[string, StepResult]>;
    expect(parsed.map(([k]) => k)).toEqual(["new-step"]);
  });

  it("preserves stepResults with admissionError sub-object", () => {
    seedTemplate("tmpl-1");
    createTemplateExecution("exec-admission", "tmpl-1");
    const stepResults = new Map<string, StepResult>([[
      "step-admission",
      {
        stepId: "step-admission",
        taskId: "task-admission",
        status: "failed",
        admissionError: {
          code: "ROLE_NOT_FOUND",
          reason: "No matching role",
          candidates: [{ roleId: "r1", name: "Engineer", fitScore: 0.1 }],
        },
      },
    ]]);

    setExecutionStepResults("exec-admission", stepResults);
    const execution = getTemplateExecution("exec-admission");
    const parsed = JSON.parse(execution!.stepResultsJson!) as Array<[string, StepResult]>;
    expect(parsed[0][1].admissionError).toEqual({
      code: "ROLE_NOT_FOUND",
      reason: "No matching role",
      candidates: [{ roleId: "r1", name: "Engineer", fitScore: 0.1 }],
    });
  });
});
