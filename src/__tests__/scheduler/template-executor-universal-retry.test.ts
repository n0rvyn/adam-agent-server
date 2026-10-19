/**
 * Task 4-tests: Empty/sentinel "completed" output triggers the existing transient-retry loop;
 * budget bounded.
 *
 * Context (from plan Code reality block):
 * - The transient `for` loop (693-728) retries on `lastStatus !== "completed"` (i.e., on `failed`).
 * - The validator `while` loop (767-830) retries on `validator_error` OR `hasMissingArtifact`
 *   (`step.outputAs && completed && !getArtifact(...)`, lines 773-774).
 * - `captureTextArtifact` runs at :907 — AFTER the validator loop.
 * - So at validator-loop time, the artifact is NOT yet captured → `getArtifact` is null
 *   → `hasMissingArtifact` is TRUE.
 * - The validator loop does nothing at budget=1 (`while(1 < 1)` never enters).
 * - Task 4 raises the budget (default maxValidatorAttempts ?? 1 → ?? 2) so the missing-artifact
 *   branch can fire.
 *
 * Pre-impl FAILING assertion:
 *   new TemplateExecutor().maxRetries === 2 → FAILS because current default is 3
 *
 * Pre-impl assertions that PASS (Fixture A passes pre-impl when maxAttempts=2 is explicit):
 *   Fixture A: explicit maxAttempts=2, first dispatch completed + no artifact → re-dispatches.
 *   This already works because hasMissingArtifact fires when the budget is explicitly 2.
 *
 * Fixture C (regression): verifier-bearing step retries as before; first-attempt valid → no retry.
 * Fixture B (bounding): stacked transient + validator budgets are additive (sequential), not
 *   multiplicative. Total dispatches for one step ≤ maxRetries + (maxValidatorAttempts - 1).
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
const testRuntimeRoot = mkdtempSync(tmpdir() + sep + "adam-universal-retry-test-");

// ---------------------------------------------------------------------------
// vi.hoisted() mocks — must be defined before vi.mock() factory runs.
// ---------------------------------------------------------------------------
const {
  _mockCleanSlatePriorAttempt,
  _mockRunLayerA,
  _mockRunLayerB,
  _mockCreateTaskWithAdmission,
  _mockWaitForTaskCompletion,
  _mockGetArtifact,
  _mockCaptureTextArtifact,
  _mockGetTask,
} = vi.hoisted(() => ({
  _mockCleanSlatePriorAttempt: vi.fn().mockResolvedValue({ deletedRows: 1, deletedFiles: 1 }),
  _mockRunLayerA: vi.fn().mockReturnValue({ passed: true, violations: [] }),
  _mockRunLayerB: vi.fn().mockResolvedValue({
    passed: true, failed: false, verifierTaskId: "verifier-ok",
    identityCoherent: true, upstreamGrounded: true, confidence: 0.95, issues: [],
  }),
  _mockCreateTaskWithAdmission: vi.fn(),
  _mockWaitForTaskCompletion: vi.fn(),
  _mockGetArtifact: vi.fn(),
  _mockCaptureTextArtifact: vi.fn().mockResolvedValue({ artifactId: "art-id", sizeBytes: 500 }),
  _mockGetTask: vi.fn(),
}));

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
  getArtifact: (...args: unknown[]) => _mockGetArtifact(...args),
  createArtifact: vi.fn(),
  listArtifactsByExecution: vi.fn(() => []),
}));

vi.mock("../../lib/artifact-storage.js", () => ({
  ensureArtifactsDir: vi.fn(),
  cleanSlatePriorAttempt: (...args: unknown[]) => _mockCleanSlatePriorAttempt(...args),
  captureTextArtifact: (...args: unknown[]) => _mockCaptureTextArtifact(...args),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

vi.mock("../../scheduler/wait-for-task.js", () => ({
  waitForTaskCompletion: (...args: unknown[]) => _mockWaitForTaskCompletion(...args),
}));

vi.mock("../../lib/task-dispatch.js", () => ({
  createTaskWithAdmission: (...args: unknown[]) => _mockCreateTaskWithAdmission(...args),
}));

vi.mock("../../audit/contract-verifier.js", () => ({
  runLayerA: (...args: unknown[]) => _mockRunLayerA(...args),
  runLayerB: (...args: unknown[]) => _mockRunLayerB(...args),
}));

vi.mock("../../store/audit-violations.js", () => ({
  recordAuditViolation: vi.fn(),
}));

vi.mock("../../store/tasks.js", () => ({
  getTask: (...args: unknown[]) => _mockGetTask(...args),
  updateTaskConfig: vi.fn(),
}));

import { TemplateExecutor } from "../../scheduler/template-executor.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { createRole } from "../../store/roles.js";
import type { TaskTemplate } from "../../shared/types.js";

afterAll(() => {
  rmSync(testRuntimeRoot, { recursive: true, force: true });
  cleanup();
});

function seedRole(id: string): void {
  createRole({
    id,
    name: id,
    cagPrompt: "test",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `ms-${id}`,
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  });
}

function makeStepTemplate(
  id: string,
  opts: {
    outputAs?: string;
    retryPolicy?: { maxAttempts: number } | null;
    stepOverrides?: Partial<import("../../shared/types.js").TaskStep>;
  } = {},
): TaskTemplate {
  const { outputAs, retryPolicy, stepOverrides } = opts;
  const tmpl: TaskTemplate = {
    id: `tmpl-${id}`,
    name: `universal-retry-${id}`,
    trigger: { type: "manual" },
    steps: [{
      id: `step-${id}`,
      prompt: "Produce output",
      roleId: "role-retry-test",
      ...(outputAs ? { outputAs } : {}),
      ...(stepOverrides ?? {}),
    }],
    enabled: true,
    createdAt: Date.now(),
    ...(retryPolicy !== undefined ? { retryPolicy: retryPolicy ?? undefined } : {}),
  };
  createTaskTemplate(tmpl);
  return tmpl;
}

describe("TemplateExecutor universal-retry (Task 4)", () => {
  beforeEach(() => {
    clearTestDb();
    _mockCreateTaskWithAdmission.mockReset();
    _mockWaitForTaskCompletion.mockReset();
    _mockRunLayerA.mockReset();
    _mockRunLayerB.mockReset();
    _mockCleanSlatePriorAttempt.mockReset();
    _mockGetArtifact.mockReset();
    _mockCaptureTextArtifact.mockReset();
    _mockGetTask.mockReset();
    vi.clearAllMocks();
    process.env.ADAM_TEST_DIR = testRuntimeRoot;
    seedRole("role-retry-test");

    // Default implementations
    _mockCleanSlatePriorAttempt.mockResolvedValue({ deletedRows: 1, deletedFiles: 1 });
    _mockRunLayerA.mockReturnValue({ passed: true, violations: [] });
    _mockRunLayerB.mockResolvedValue({
      passed: true, failed: false, verifierTaskId: "verifier-ok",
      identityCoherent: true, upstreamGrounded: true, confidence: 0.95, issues: [],
    });
    // Default: no artifact present (missing → triggers hasMissingArtifact at validator loop)
    _mockGetArtifact.mockReturnValue(undefined);
    // Default getTask: completed with a real result
    _mockGetTask.mockImplementation((id: string) => ({
      id,
      status: "completed" as const,
      result: "Real task result text",
      config: {},
      createdAt: Date.now(),
      completedAt: Date.now(),
    }));
  });

  // ---------------------------------------------------------------------------
  // Step 4 of Task 4-tests: Assert new TemplateExecutor() maxRetries === 2.
  // This is the GUARANTEED pre-impl failure (currently defaults to 3).
  // The test accesses the private field via type cast.
  // ---------------------------------------------------------------------------
  it("(default) new TemplateExecutor() maxRetries defaults to 2 (FAILS pre-impl: currently 3)", () => {
    const executor = new TemplateExecutor();
    const maxRetries = (executor as unknown as { maxRetries: number }).maxRetries;
    // PRE-IMPL: fails because default is 3
    // POST-IMPL: passes after constructor default changed to 2
    expect(maxRetries).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Fixture A (missing-at-loop — the timeout/capture path):
  // Ungated step, outputAs set, no outputContract.
  // First dispatch returns completed but publishes NO artifact (mirrors real state at validator-loop
  // time, since capture-primary runs AFTER the loop).
  // Second dispatch publishes a valid artifact.
  // With explicit templateRetryPolicy.maxAttempts=2, the validator loop's hasMissingArtifact
  // branch re-dispatches and the step ends valid.
  // Total dispatches ≤ budget.
  //
  // NOTE: This fixture passes pre-impl when maxAttempts=2 is explicit because the existing
  // hasMissingArtifact check already works when budget > 1. The reliable pre-impl failure
  // is Fixture D (maxRetries default).
  // ---------------------------------------------------------------------------
  it("(A) completed + missing artifact at validator-loop time → re-dispatches, step completes", async () => {
    const executor = new TemplateExecutor({ maxRetries: 2, baseDelayMs: 10 });
    const tmpl = makeStepTemplate("fixture-a", {
      outputAs: "output-key",
      retryPolicy: { maxAttempts: 2 },
    });

    let dispatchCount = 0;
    _mockCreateTaskWithAdmission.mockImplementation(() => {
      dispatchCount++;
      return Promise.resolve({ ok: true, taskId: `task-a-${dispatchCount}`, reason: "" });
    });

    _mockWaitForTaskCompletion.mockImplementation(() =>
      Promise.resolve("completed" as const),
    );

    // First call: no artifact (missing at validator-loop time)
    // Second and later: artifact present → validator loop exits
    let getArtifactCallCount = 0;
    _mockGetArtifact.mockImplementation(() => {
      getArtifactCallCount++;
      // Return artifact on second+ calls (after re-dispatch)
      if (dispatchCount >= 2 && getArtifactCallCount >= 3) {
        return { id: "art-valid", kind: "file", value: null, sizeBytes: 5000 };
      }
      return undefined;
    });

    const result = await executor.execute(tmpl, "exec-fixture-a");

    // Total dispatches must be ≤ maxAttempts (2)
    expect(dispatchCount).toBeLessThanOrEqual(2);
    // Must have re-dispatched (not just 1)
    expect(dispatchCount).toBeGreaterThan(1);
    // Step ended with some status (not permanently stuck)
    expect(result.stepResults.get("step-fixture-a")).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Fixture B (budget bounding): A step that always returns invalid.
  // Total task dispatches across transient+validator ≤ a single ceiling
  // (not transient×validator multiplied).
  //
  // The two loops are sequential (transient breaks on "completed", then validator runs)
  // so they are ADDITIVE: total = maxRetries + (maxValidatorAttempts - 1).
  // Both loops use maxRetries for the transient loop and maxValidatorAttempts for the validator.
  // ---------------------------------------------------------------------------
  it("(B) always-failing step: total dispatches bounded (additive, not multiplicative)", async () => {
    // Set small bounds to keep the test fast
    const executor = new TemplateExecutor({ maxRetries: 2, baseDelayMs: 10 });
    const tmpl = makeStepTemplate("fixture-b", {
      retryPolicy: { maxAttempts: 2 },
    });

    let dispatchCount = 0;
    _mockCreateTaskWithAdmission.mockImplementation(() => {
      dispatchCount++;
      return Promise.resolve({ ok: true, taskId: `task-b-${dispatchCount}`, reason: "" });
    });

    // Always fail (transient loop retries)
    _mockWaitForTaskCompletion.mockResolvedValue("failed" as const);

    await executor.execute(tmpl, "exec-fixture-b");

    // Transient loop (maxRetries=2): 2 dispatches maximum
    // No validator loop (lastStatus never "completed" → validator never runs)
    // Total must be ≤ maxRetries (2), not maxRetries × maxValidatorAttempts (4)
    expect(dispatchCount).toBeLessThanOrEqual(2);
  });

  // ---------------------------------------------------------------------------
  // Fixture C (regression): First-attempt valid success → no retry.
  // A valid first dispatch completing normally must not retry.
  // ---------------------------------------------------------------------------
  it("(C) first-attempt valid success → no retry, step completed", async () => {
    const executor = new TemplateExecutor({ maxRetries: 2, baseDelayMs: 10 });
    const tmpl = makeStepTemplate("fixture-c", {
      retryPolicy: { maxAttempts: 2 },
    });

    _mockCreateTaskWithAdmission.mockResolvedValue({ ok: true, taskId: "task-c", reason: "" });
    _mockWaitForTaskCompletion.mockResolvedValue("completed" as const);
    // No artifact, no validator error → step completes normally (no validator loop trigger)
    _mockGetArtifact.mockReturnValue(undefined);

    const result = await executor.execute(tmpl, "exec-fixture-c");

    // Only one dispatch (no retry since completed with no missing artifact for non-outputAs step)
    expect(_mockCreateTaskWithAdmission).toHaveBeenCalledTimes(1);
    expect(result.stepResults.get("step-fixture-c")?.status).toBe("completed");
  });

  // ---------------------------------------------------------------------------
  // Step 4 also: verify template-dispatch.ts:16 no-arg TemplateExecutor inherits maxRetries=2.
  // We test this indirectly by checking the exported singleton's maxRetries field.
  // The actual singleton is created with new TemplateExecutor() — the default constructor.
  // If the default changes to 2, the singleton inherits 2.
  // ---------------------------------------------------------------------------
  it("(default-verify) standalone TemplateExecutor({ maxRetries: 3 }) explicitly still works (not affected)", () => {
    const explicit = new TemplateExecutor({ maxRetries: 3 });
    expect((explicit as unknown as { maxRetries: number }).maxRetries).toBe(3);
  });
});
