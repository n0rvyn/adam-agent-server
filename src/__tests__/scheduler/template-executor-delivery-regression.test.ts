/**
 * Regression test: concat-step-results output must be byte-for-byte identical to
 * the existing implementation.
 *
 * This is the acceptance criterion guard for:
 *   "concat-step-results 输出与现行实现 byte-for-byte 一致"
 *
 * Key invariant: skipped steps with explicit error text ("Skipped: dependency failed")
 * must NOT be replaced with "No output". The "No output" sentinel only appears when
 * both result AND error are undefined (i.e., a completed step that returned null).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
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
}));

vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn(() => []),
}));

vi.mock("../../store/role-workspace.js", () => ({
  ensureRoleWorkspace: vi.fn(),
  getRoleWorkspacePath: vi.fn(),
  writeRoleCLAUDEmd: vi.fn(),
  syncRoleSettings: vi.fn(),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

import { assembleSummary } from "../../scheduler/template-summary-assembler.js";
import type { TaskTemplate, TaskConfig, StepResult } from "../../shared/types.js";
import type { TemplateExecutionContext } from "../../scheduler/template-executor.js";
import type { TemplateExecutionStepStatus } from "../../store/template-executions.js";

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
});

function makeContext(
  templateOverrides: Partial<TaskTemplate> = {},
  stepResults?: Map<string, StepResult>,
): TemplateExecutionContext {
  return {
    templateId: templateOverrides.id ?? "tmpl-regression",
    templateName: "Regression Test Template",
    template: {
      id: "tmpl-regression",
      name: "Regression Test Template",
      config: {},
      steps: [],
      trigger: { type: "manual" as const },
      enabled: true,
      ...templateOverrides,
    } as TaskTemplate,
    executionId: "exec-regression",
    stepResults: stepResults,
    stepStatuses: {} as Record<string, TemplateExecutionStepStatus>,
    config: {} as TaskConfig,
    continueOnError: false,
    failedStepIds: new Set<string>(),
    deliverTo: [],
    reportTo: [],
    goalSteps: [],
  } as unknown as TemplateExecutionContext;
}

describe("concat-step-results regression — byte-for-byte output unchanged", () => {

  it("3-step execution (completed / skipped / failed) produces exact expected output", () => {
    const stepResults = new Map<string, StepResult>();
    // completed step with result + role
    stepResults.set("step-a", { stepId: "step-a", taskId: "task-a", status: "completed", result: "step-a result content", roleName: "RoleA" });
    // skipped step with explicit error text — NOT "No output"
    stepResults.set("step-b", { stepId: "step-b", taskId: "task-b", status: "skipped", error: "Skipped: dependency failed" });
    // failed step with error + role
    stepResults.set("step-c", { stepId: "step-c", taskId: "task-c", status: "failed", error: "step-c error message", roleName: "RoleC" });

    const context = makeContext({}, stepResults);
    const result = assembleSummary({ executionId: "exec-regression", template: context.template, stepResults: context.stepResults });

    // Frozen expected value — this must NEVER drift as Phase 4 adds new branches.
    // The "No output" sentinel must NOT appear here; step-b has explicit error text.
    const expected = `## [OK] Step: step-a (RoleA)

step-a result content

---

## [SKIP] Step: step-b

Skipped: dependency failed

---

## [FAIL] Step: step-c (RoleC)

step-c error message`;

    expect(result).toBe(expected);
  });

  it("completed-only step: result field used verbatim", () => {
    const stepResults = new Map<string, StepResult>();
    stepResults.set("step-1", { stepId: "step-1", taskId: "task-1", status: "completed", result: "Final output here", roleName: "Engineer" });

    const context = makeContext({}, stepResults);
    const result = assembleSummary({ executionId: "exec-regression", template: context.template, stepResults: context.stepResults });

    expect(result).toBe(`## [OK] Step: step-1 (Engineer)

Final output here`);
  });

  it("skipped-only step: error field used verbatim (not 'No output')", () => {
    const stepResults = new Map<string, StepResult>();
    stepResults.set("step-1", { stepId: "step-1", taskId: "task-1", status: "skipped", error: "Upstream dependency step-0 failed" });

    const context = makeContext({}, stepResults);
    const result = assembleSummary({ executionId: "exec-regression", template: context.template, stepResults: context.stepResults });

    expect(result).toBe(`## [SKIP] Step: step-1

Upstream dependency step-0 failed`);
    expect(result).not.toContain("No output");
  });

  it("failed-only step: error field used verbatim", () => {
    const stepResults = new Map<string, StepResult>();
    stepResults.set("step-1", { stepId: "step-1", taskId: "task-1", status: "failed", error: "Timeout: step exceeded 600s" });

    const context = makeContext({}, stepResults);
    const result = assembleSummary({ executionId: "exec-regression", template: context.template, stepResults: context.stepResults });

    expect(result).toBe(`## [FAIL] Step: step-1

Timeout: step exceeded 600s`);
  });

  it("step without roleName: no parentheses suffix", () => {
    const stepResults = new Map<string, StepResult>();
    stepResults.set("step-1", { stepId: "step-1", taskId: "task-1", status: "completed", result: "Some result" });

    const context = makeContext({}, stepResults);
    const result = assembleSummary({ executionId: "exec-regression", template: context.template, stepResults: context.stepResults });

    expect(result).toBe(`## [OK] Step: step-1

Some result`);
    expect(result).not.toContain("()");
  });

  it("delivery config absent: defaults to concat-step-results (implicit)", () => {
    const stepResults = new Map<string, StepResult>();
    stepResults.set("s1", { stepId: "s1", taskId: "t1", status: "completed", result: "output" });

    const context = makeContext({ config: {} }, stepResults);
    const result = assembleSummary({ executionId: "exec-regression", template: context.template, stepResults: context.stepResults });
    expect(result).toBe(`## [OK] Step: s1\n\noutput`);
  });

});
