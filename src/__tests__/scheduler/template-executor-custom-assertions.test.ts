/**
 * Layer C (customAssertions) integration tests for template-executor.
 *
 * TDD test-first: this file must FAIL (non-zero exit) before Task 5-impl integrates Layer C.
 *
 * Mocking strategy:
 * - runCustomAssertionsCheck: vi.mock("../../audit/assertion-judge.js") — standard module mock
 * - retryStepWithFeedback: vi.spyOn(executor as any, "retryStepWithFeedback") — spy on private method
 * - All other infrastructure follows the same vi.hoisted() + vi.mock() pattern used by
 *   template-executor-length-retry.test.ts
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
const testRuntimeRoot = mkdtempSync(tmpdir() + sep + "adam-layer-c-test-");

// ---------------------------------------------------------------------------
// vi.hoisted(): register mocks that need to be accessible before import hoisting
// ---------------------------------------------------------------------------
const { _mockRunLayerA, _mockRunLayerB, _mockCreateTaskWithAdmission, _mockWaitForTaskCompletion, _mockUpdateTaskConfig } =
  vi.hoisted(() => ({
    _mockRunLayerA: vi.fn(),
    _mockRunLayerB: vi.fn(),
    _mockCreateTaskWithAdmission: vi.fn().mockResolvedValue({ ok: true, taskId: "task-done", reason: "" }),
    _mockWaitForTaskCompletion: vi.fn().mockResolvedValue("completed" as const),
    _mockUpdateTaskConfig: vi.fn(),
  }));

// ---------------------------------------------------------------------------
// Module mocks — must come before any dynamic imports of the mocked modules
// ---------------------------------------------------------------------------

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn(() => ({ type: "sdk" as const, name: "test" })),
  tool: vi.fn(() => ({ name: "test" })),
}));

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/index.js", () => ({
  getDefaults: () => ({
    timeout: 600, maxTurns: 100, maxBudgetUsd: 5, effort: "high" as const,
    model: "claude-sonnet-4-6", settingSources: ["project"] as string[],
    allowedTools: [], disallowedTools: [], approvalRequired: [], approvalTimeout: 300, env: {},
  }),
}));

vi.mock("../../store/role-workspace.js", () => ({
  ensureRoleWorkspace: vi.fn(() => `/tmp/adam-test-roles/test`),
  getRoleWorkspacePath: vi.fn(() => `/tmp/adam-test-roles/test`),
  writeRoleCLAUDEmd: vi.fn(),
  syncRoleSettings: vi.fn(),
}));

vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn(() => []),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  },
}));

vi.mock("../../scheduler/wait-for-task.js", () => ({
  waitForTaskCompletion: (..._args: unknown[]) => _mockWaitForTaskCompletion(),
}));

vi.mock("../../lib/task-dispatch.js", () => ({
  createTaskWithAdmission: (...args: unknown[]) => _mockCreateTaskWithAdmission(...args),
}));

vi.mock("../../audit/contract-verifier.js", () => ({
  runLayerA: (...args: unknown[]) => _mockRunLayerA(...args),
  runLayerB: (...args: unknown[]) => _mockRunLayerB(...args),
}));

vi.mock("../../store/tasks.js", () => ({
  getTask: vi.fn((id: string) => ({
    id,
    status: "completed",
    result: "mocked task result for assertions check",
    config: {},
  })),
  updateTaskConfig: (...args: unknown[]) => _mockUpdateTaskConfig(...args),
}));

// Layer C assertion judge mock — the critical mock for this test suite
vi.mock("../../audit/assertion-judge.js", () => ({
  runCustomAssertionsCheck: vi.fn(),
}));

import { runCustomAssertionsCheck } from "../../audit/assertion-judge.js";
import { TemplateExecutor } from "../../scheduler/template-executor.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { createRole } from "../../store/roles.js";
import type { TaskTemplate } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function seedRole(id: string): void {
  createRole({
    id, name: id, cagPrompt: "test",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `ms-${id}`,
    status: "active", preferences: {}, createdAt: Date.now(),
  });
}

function make1StepTemplate(step: TaskTemplate["steps"][0]): TaskTemplate {
  const id = `tmpl-layer-c-${step.id}`;
  const tmpl: TaskTemplate = {
    id,
    name: "layer-c-test",
    trigger: { type: "manual" },
    steps: [{ ...step, roleId: step.roleId ?? "role-test" }],
    enabled: true,
    createdAt: Date.now(),
  };
  createTaskTemplate(tmpl);
  return tmpl;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(() => {
  rmSync(testRuntimeRoot, { recursive: true, force: true });
  cleanup();
});

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------

describe("template-executor Layer C (customAssertions)", () => {
  let executor: TemplateExecutor;

  beforeEach(() => {
    clearTestDb();
    vi.clearAllMocks();
    // Reset ALL mock implementations (including once-queues) to prevent test-order contamination.
    // vi.clearAllMocks() only clears call history; vi.resetAllMocks() also resets implementation queues.
    vi.resetAllMocks();
    process.env.ADAM_TEST_DIR = testRuntimeRoot;
    executor = new TemplateExecutor({ maxRetries: 1, baseDelayMs: 10 });
    seedRole("role-test");

    // Default: task dispatches/completes successfully, Layer A+B pass
    _mockCreateTaskWithAdmission.mockResolvedValue({ ok: true, taskId: "task-done", reason: "" });
    _mockWaitForTaskCompletion.mockResolvedValue("completed" as const);
    _mockRunLayerA.mockReturnValue({ passed: true, violations: [] });
    _mockRunLayerB.mockResolvedValue({
      passed: true, failed: false, verifierTaskId: "verifier-ok",
      identityCoherent: true, upstreamGrounded: true, confidence: 0.95, issues: [],
    });
  });

  // ---------------------------------------------------------------------------
  // Case 1: No customAssertions — Layer C judge NOT invoked
  // ---------------------------------------------------------------------------
  it("does not invoke judge when step has no customAssertions", async () => {
    const tmpl = make1StepTemplate({
      id: "step-no-ca",
      prompt: "Write a podcast script",
      outputContract: { contractRules: [{ kind: "lengthTarget", min: 100, max: 200, unit: "characters" }] },
    });

    _mockCreateTaskWithAdmission.mockResolvedValueOnce({ ok: true, taskId: "task-no-ca", reason: "" });

    await executor.execute(tmpl, "exec-no-ca");

    expect(runCustomAssertionsCheck).not.toHaveBeenCalled();

    const db = getTestDb();
    const violations = db.prepare("SELECT * FROM audit_violations WHERE execution_id = ?").all("exec-no-ca");
    expect(violations).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Case 2: Layer A failed → Layer C NOT invoked
  // ---------------------------------------------------------------------------
  it("does not invoke judge when Layer A failed", async () => {
    const tmpl = make1StepTemplate({
      id: "step-layer-a-fail",
      prompt: "Write a podcast script",
      outputContract: {
        contractRules: [{ kind: "format", value: "markdown" }],
        customAssertions: ["thesis must be falsifiable"],
      },
    });

    _mockCreateTaskWithAdmission.mockResolvedValueOnce({ ok: true, taskId: "task-layer-a-fail", reason: "" });
    // Pure design: any Layer A failure is an immediate fail-A (no post-hoc retry). The step fails
    // and Layer C never becomes eligible. Layer A emits presence-gate (outputAs) + persona violations.
    _mockRunLayerA.mockReturnValueOnce({
      passed: false,
      violations: [{ contractField: "outputAs", message: "no artifact published under the declared key" }],
    });

    const result = await executor.execute(tmpl, "exec-layer-a-fail");

    expect(runCustomAssertionsCheck).not.toHaveBeenCalled();
    expect(result.stepResults.get("step-layer-a-fail")?.status).toBe("failed");
  });

  // ---------------------------------------------------------------------------
  // Case 3: All assertions pass on first judge call — no retry, step completes
  // ---------------------------------------------------------------------------
  it("step completes when all assertions pass on first call", async () => {
    const tmpl = make1StepTemplate({
      id: "step-all-pass",
      prompt: "Write a podcast script",
      outputContract: {
        customAssertions: ["thesis must be falsifiable", "must cite a source"],
      },
    });

    _mockCreateTaskWithAdmission.mockResolvedValueOnce({ ok: true, taskId: "task-all-pass", reason: "" });

    vi.mocked(runCustomAssertionsCheck).mockResolvedValueOnce({
      passed: true,
      results: [
        { assertion: "thesis must be falsifiable", passed: true, reason: "stated in para 1" },
        { assertion: "must cite a source", passed: true, reason: "cites Smith 2020" },
      ],
    });

    const result = await executor.execute(tmpl, "exec-all-pass");

    expect(runCustomAssertionsCheck).toHaveBeenCalledTimes(1);
    expect(result.stepResults.get("step-all-pass")?.status).toBe("completed");

    const db = getTestDb();
    const violations = db.prepare("SELECT * FROM audit_violations WHERE execution_id = ?").all("exec-all-pass");
    expect(violations).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Case 4: First judge call fails; retryStepWithFeedback called; second judge call passes
  // ---------------------------------------------------------------------------
  it("retries up to 2 times when assertions fail then pass", async () => {
    const tmpl = make1StepTemplate({
      id: "step-retry-pass",
      prompt: "Write a podcast script",
      outputContract: {
        customAssertions: ["thesis must be falsifiable"],
      },
    });

    _mockCreateTaskWithAdmission
      .mockResolvedValueOnce({ ok: true, taskId: "task-original", reason: "" })
      .mockResolvedValueOnce({ ok: true, taskId: "task-retry-1", reason: "" });

    // First judge call: fails; second judge call: passes (after retry)
    vi.mocked(runCustomAssertionsCheck)
      .mockResolvedValueOnce({
        passed: false,
        results: [{ assertion: "thesis must be falsifiable", passed: false, reason: "no clear falsifiable claim found" }],
      })
      .mockResolvedValueOnce({
        passed: true,
        results: [{ assertion: "thesis must be falsifiable", passed: true, reason: "clearly stated in revision" }],
      });

    const retryStepSpy = vi.spyOn(executor as unknown as { retryStepWithFeedback: (...args: unknown[]) => unknown }, "retryStepWithFeedback");
    retryStepSpy.mockResolvedValueOnce({
      layerAPassed: true,
      taskId: "task-retry-1",
      finalTask: { id: "task-retry-1", status: "completed", result: "revised mocked result", config: {} },
      layerAViolations: undefined,
    });

    const result = await executor.execute(tmpl, "exec-retry-pass");

    expect(runCustomAssertionsCheck).toHaveBeenCalledTimes(2);
    expect(retryStepSpy).toHaveBeenCalledTimes(1);
    expect(result.stepResults.get("step-retry-pass")?.status).toBe("completed");

    const db = getTestDb();
    const violations = db.prepare("SELECT * FROM audit_violations WHERE execution_id = ?").all("exec-retry-pass");
    expect(violations).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Case 5: Assertions fail after 2 retries → audit_violations recorded (severity=warning, layer=C),
  //         step status still "completed" (D-004 "violation 不死锁，仍交付")
  // ---------------------------------------------------------------------------
  it("records audit_violations and keeps step completed when assertions still fail after 2 retries", async () => {
    const tmpl = make1StepTemplate({
      id: "step-all-fail",
      prompt: "Write a podcast script",
      outputContract: {
        customAssertions: ["thesis must be falsifiable", "must cite a source"],
      },
    });

    _mockCreateTaskWithAdmission
      .mockResolvedValueOnce({ ok: true, taskId: "task-original-fail", reason: "" })
      .mockResolvedValue({ ok: true, taskId: "task-retry-fail", reason: "" });

    const failResult = {
      passed: false,
      results: [
        { assertion: "thesis must be falsifiable", passed: false, reason: "no falsifiable claim" },
        { assertion: "must cite a source", passed: false, reason: "no citation found" },
      ],
    };

    // All 3 judge calls (original + 2 retries) return failed
    vi.mocked(runCustomAssertionsCheck)
      .mockResolvedValue(failResult);

    const retryStepSpy = vi.spyOn(executor as unknown as { retryStepWithFeedback: (...args: unknown[]) => unknown }, "retryStepWithFeedback");
    retryStepSpy.mockResolvedValue({
      layerAPassed: true,
      taskId: "task-retry-fail",
      finalTask: { id: "task-retry-fail", status: "completed", result: "retried result still fails", config: {} },
      layerAViolations: undefined,
    });

    const result = await executor.execute(tmpl, "exec-all-fail");

    // Judge called 3 times: original + 2 retries
    expect(runCustomAssertionsCheck).toHaveBeenCalledTimes(3);
    expect(retryStepSpy).toHaveBeenCalledTimes(2);

    // Step still completed despite violations — D-004
    expect(result.stepResults.get("step-all-fail")?.status).toBe("completed");

    const db = getTestDb();
    const violations = db.prepare("SELECT * FROM audit_violations WHERE execution_id = ?").all("exec-all-fail") as Array<{
      contract_field: string;
      layer: string;
      severity: string;
      step_task_id: string;
    }>;

    // 2 failed assertions → 2 audit_violations rows
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.contract_field === "customAssertions")).toBe(true);
    expect(violations.every((v) => v.layer === "C")).toBe(true);
    expect(violations.every((v) => v.severity === "warning")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Case 6: Retry's Layer A fails → fall back to original output, record violations on
  //         ORIGINAL taskId, step stays completed (D-004 fallback path)
  // ---------------------------------------------------------------------------
  it("falls back to original output when retry's Layer A fails, records customAssertions violations on original taskId, step stays completed", async () => {
    const ORIGINAL_TASK_ID = "task-original-layerc-fallback";
    const RETRY_TASK_ID = "task-retry-layerc-broken";

    const tmpl = make1StepTemplate({
      id: "step-fallback",
      prompt: "Write a podcast script",
      outputContract: {
        customAssertions: ["thesis must be falsifiable"],
      },
    });

    _mockCreateTaskWithAdmission.mockResolvedValueOnce({ ok: true, taskId: ORIGINAL_TASK_ID, reason: "" });

    // First judge call: fails (triggers retry)
    vi.mocked(runCustomAssertionsCheck)
      .mockResolvedValueOnce({
        passed: false,
        results: [{ assertion: "thesis must be falsifiable", passed: false, reason: "no falsifiable claim in original" }],
      });

    const retryStepSpy = vi.spyOn(executor as unknown as { retryStepWithFeedback: (...args: unknown[]) => unknown }, "retryStepWithFeedback");
    // retryStepWithFeedback: Layer A fails on retry (length drift)
    retryStepSpy.mockResolvedValueOnce({
      layerAPassed: false,
      taskId: RETRY_TASK_ID,
      finalTask: { id: RETRY_TASK_ID, status: "completed", result: "retry result broke layer a", config: {} },
      layerAViolations: {
        passed: false,
        violations: [{ contractField: "lengthTarget", message: "retry drifted length" }],
      },
    });

    const result = await executor.execute(tmpl, "exec-fallback");

    // Judge called once (original — triggers retry which has layerA fail, no second judge call)
    expect(runCustomAssertionsCheck).toHaveBeenCalledTimes(1);
    expect(retryStepSpy).toHaveBeenCalledTimes(1);

    // Step still completed — D-004, fallback to original output
    expect(result.stepResults.get("step-fallback")?.status).toBe("completed");

    const db = getTestDb();
    const violations = db.prepare("SELECT * FROM audit_violations WHERE execution_id = ?").all("exec-fallback") as Array<{
      contract_field: string;
      layer: string;
      severity: string;
      step_task_id: string;
    }>;

    // 1 customAssertions violation recorded
    expect(violations).toHaveLength(1);
    expect(violations[0]!.contract_field).toBe("customAssertions");
    expect(violations[0]!.layer).toBe("C");
    expect(violations[0]!.severity).toBe("warning");
    // Violation recorded against ORIGINAL taskId (not the broken retry's taskId)
    expect(violations[0]!.step_task_id).toBe(ORIGINAL_TASK_ID);

    // The broken retry's Layer A violation must NOT appear as a Layer A error in audit_violations
    const layerAViolations = db.prepare(
      "SELECT * FROM audit_violations WHERE execution_id = ? AND layer = 'A'",
    ).all("exec-fallback");
    expect(layerAViolations).toHaveLength(0);
  });
});
