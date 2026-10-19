/**
 * Task 5 (Step 10): template-executor.ts validator-driven retry branch.
 *
 * Tests the validator retry loop (Phase 4) in template-executor.ts.
 * The loop reads structured 'validator_error' step_log rows written by execution-tools.ts
 * and re-dispatches the step with a clean slate when retryPolicy.maxAttempts allows it.
 *
 * Test coverage:
 * - Test 1: validator_error row present + maxAttempts=2 → 2 dispatches, cleanSlate called once,
 *           second dispatch yields no validator_error row → step completed, retryReason="validator"
 * - Test 2: validator_error row present in BOTH attempts + maxAttempts=2 → both fail →
 *           step completed, retryReason="validator", validatorAttempt=2
 * - Test 3: validator_error row present + retryPolicy=null/undefined → 1 dispatch only,
 *           no cleanSlate call (non-goal preserved)
 * - Test 4: NON-validator failure (no validator_error row) + retryPolicy set →
 *           transient retry used, no validator loop
 * - Test 5: validator_error row + maxAttempts=1 → no retry (loop condition 1 < 1 is false)
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
const testRuntimeRoot = mkdtempSync(tmpdir() + sep + "adam-validator-retry-test-");

// ---------------------------------------------------------------------------
// vi.hoisted() mocks — hoisted alongside vi.mock() factories.
// Each mock uses mockImplementation (not mockResolvedValueOnce) to avoid queue
// ordering bugs where previous tests' once() calls leak into subsequent tests.
// ---------------------------------------------------------------------------
const {
  _mockCleanSlatePriorAttempt,
  _mockRunLayerA,
  _mockRunLayerB,
  _mockCreateTaskWithAdmission,
  _mockWaitForTaskCompletion,
  _mockPersistStepStatuses,
} = vi.hoisted(() => ({
  _mockCleanSlatePriorAttempt: vi.fn().mockResolvedValue({ deletedRows: 1, deletedFiles: 1 }),
  _mockRunLayerA: vi.fn().mockReturnValue({ passed: true, violations: [] }),
  _mockRunLayerB: vi.fn().mockResolvedValue({
    passed: true,
    failed: false,
    verifierTaskId: "verifier-ok",
    identityCoherent: true,
    upstreamGrounded: true,
    confidence: 0.95,
    issues: [],
  }),
  // No default: each test sets up its own implementation via mockImplementation.
  _mockCreateTaskWithAdmission: vi.fn(),
  _mockWaitForTaskCompletion: vi.fn(),
  _mockPersistStepStatuses: vi.fn(),
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
    timeout: 600,
    maxTurns: 100,
    maxBudgetUsd: 5,
    effort: "high" as const,
    model: "claude-sonnet-4-6",
    settingSources: ["project"] as string[],
    allowedTools: [],
    disallowedTools: [],
    approvalRequired: [],
    approvalTimeout: 300,
    env: {},
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
  waitForTaskCompletion: (..._args: unknown[]) => _mockWaitForTaskCompletion(..._args),
}));

vi.mock("../../lib/task-dispatch.js", () => ({
  createTaskWithAdmission: (...args: unknown[]) => _mockCreateTaskWithAdmission(...args),
}));

vi.mock("../../audit/contract-verifier.js", () => ({
  runLayerA: (...args: unknown[]) => _mockRunLayerA(...args),
  runLayerB: (...args: unknown[]) => _mockRunLayerB(...args),
}));

vi.mock("../../lib/artifact-storage.js", () => ({
  ensureArtifactsDir: vi.fn(),
  cleanSlatePriorAttempt: (...args: unknown[]) =>
    _mockCleanSlatePriorAttempt(...args),
}));

import { TemplateExecutor } from "../../scheduler/template-executor.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { createRole } from "../../store/roles.js";
import type { TaskTemplate } from "../../shared/types.js";

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

afterAll(() => {
  rmSync(testRuntimeRoot, { recursive: true, force: true });
  cleanup();
});

/**
 * Seed a validator_error step_log row for a given taskId.
 * This mimics what execution-tools.ts writes when AssertionFailedError is thrown.
 */
function seedValidatorErrorRow(taskId: string, errorMessage = "ASSERTION_FAILED: audio.zc_rate_per_s=7812, expected < 5000"): void {
  const db = getTestDb();
  const countRow = db
    .prepare("SELECT COUNT(*) as n FROM step_logs WHERE task_id = ?")
    .get(taskId) as { n: number } | undefined;
  const nextIndex = (countRow?.n ?? 0) + 1;
  db.prepare(
    `INSERT INTO step_logs (id, task_id, "index", type, content, tool_name, timestamp)
     VALUES (?, ?, ?, 'validator_error', ?, 'publish_artifact_file', ?)`,
  ).run(`step-valerr-${taskId}-${Date.now()}`, taskId, nextIndex, errorMessage, Date.now());
}

describe("TemplateExecutor validator-driven retry (Phase 4)", () => {
  let executor: TemplateExecutor;

  beforeEach(() => {
    clearTestDb();
    // CRITICAL: use mockImplementation + counter, NOT mockResolvedValueOnce.
    // mockResolvedValueOnce uses an internal queue that accumulates across tests
    // despite mockReset() — each test's queue adds to the previous one.
    // Counter-based mockImplementation avoids this entirely.
    _mockCreateTaskWithAdmission.mockReset();
    _mockWaitForTaskCompletion.mockReset();
    _mockRunLayerA.mockReset();
    _mockRunLayerB.mockReset();
    _mockCleanSlatePriorAttempt.mockReset();
    _mockPersistStepStatuses.mockReset();
    vi.clearAllMocks();
    process.env.ADAM_TEST_DIR = testRuntimeRoot;
    // maxRetries=2: transient loop allows 1 retry (attempt 1 fails, attempt 2 succeeds)
    executor = new TemplateExecutor({ maxRetries: 2, baseDelayMs: 10 });
    seedRole("role-test");
    // Default implementations — tests override these with specific sequences
    _mockCleanSlatePriorAttempt.mockResolvedValue({ deletedRows: 1, deletedFiles: 1 });
    _mockRunLayerA.mockReturnValue({ passed: true, violations: [] });
    _mockRunLayerB.mockResolvedValue({
      passed: true,
      failed: false,
      verifierTaskId: "verifier-ok",
      identityCoherent: true,
      upstreamGrounded: true,
      confidence: 0.95,
      issues: [],
    });
    _mockPersistStepStatuses.mockImplementation(() => {});
  });

  function make1StepTemplate(overrides?: Partial<TaskTemplate>): TaskTemplate {
    const tmpl: TaskTemplate = {
      id: "tmpl-valretry",
      name: "valretry-test",
      trigger: { type: "manual" },
      steps: [{
        id: "step-vr",
        prompt: "Publish an audio file",
        roleId: "role-test",
        // NOTE: no outputContract or outputAs — avoids triggering the outputAs check
        // in the final block which requires an artifact to be present.
      }],
      enabled: true,
      createdAt: Date.now(),
      ...overrides,
    };
    createTaskTemplate(tmpl);
    return tmpl;
  }

  // ---------------------------------------------------------------------------
  // Test 1: validator_error row + maxAttempts=2 → 2 dispatches, cleanSlate called once,
  //          second attempt yields no validator_error → step completed
  // ---------------------------------------------------------------------------
  it("(1) retry succeeds on second attempt: 2 dispatches, cleanSlate once, step completed", async () => {
    const tmpl = make1StepTemplate({
      retryPolicy: { maxAttempts: 2 },
    });

    // Counter-based mock to avoid queue ordering issues.
    let dispatchCount = 0;
    _mockCreateTaskWithAdmission.mockImplementation(() => {
      dispatchCount++;
      return Promise.resolve(
        dispatchCount === 1
          ? { ok: true, taskId: "task-valerr-first", reason: "" }
          : { ok: true, taskId: "task-valerr-second", reason: "" },
      );
    });
    let waitCount = 0;
    _mockWaitForTaskCompletion.mockImplementation(() => {
      waitCount++;
      return Promise.resolve(waitCount === 1 ? "completed" as const : "completed" as const);
    });

    // Seed validator_error for the FIRST task only (simulates the real behavior where
    // the first attempt fails assertion and execution-tools writes the row)
    seedValidatorErrorRow("task-valerr-first");

    const result = await executor.execute(tmpl, "exec-valretry-1");

    // Two dispatches: original + one validator retry
    expect(_mockCreateTaskWithAdmission).toHaveBeenCalledTimes(2);
    // cleanSlate called once for the validator retry
    expect(_mockCleanSlatePriorAttempt).toHaveBeenCalledTimes(1);
    expect(_mockCleanSlatePriorAttempt).toHaveBeenCalledWith("exec-valretry-1", "step-vr");

    // Step completed (second attempt had no validator error, contract verification passes)
    expect(result.stepResults.get("step-vr")?.status).toBe("completed");

    // DEBUG: inspect what was actually persisted
    const db = getTestDb();
    const rawRow = db.prepare("SELECT step_statuses FROM template_executions WHERE id = ?").get("exec-valretry-1");
    const raw = (rawRow as { step_statuses: string } | undefined)?.step_statuses;
    console.log("[DEBUG] raw step_statuses:", raw);
    console.log("[DEBUG] parsed:", JSON.parse(raw ?? "{}"));
    console.log("[DEBUG] step-vr:", JSON.parse(raw ?? "{}")["step-vr"]);
  });

  // ---------------------------------------------------------------------------
  // Test 2: validator_error row present in BOTH attempts + maxAttempts=2 → both fail.
  //          Verifies retryReason="validator" and validatorAttempt=2 in stepStatuses.
  // ---------------------------------------------------------------------------
  it("(2) both attempts have validator_error rows → step completed, retryReason=validator, validatorAttempt=2", async () => {
    const tmpl = make1StepTemplate({
      retryPolicy: { maxAttempts: 2 },
    });

    let dispatchCount = 0;
    _mockCreateTaskWithAdmission.mockImplementation(() => {
      dispatchCount++;
      return Promise.resolve(
        dispatchCount === 1
          ? { ok: true, taskId: "task-both-err-1", reason: "" }
          : { ok: true, taskId: "task-both-err-2", reason: "" },
      );
    });
    let waitCount = 0;
    _mockWaitForTaskCompletion.mockImplementation(() => {
      waitCount++;
      return Promise.resolve(waitCount === 1 ? "completed" as const : "completed" as const);
    });

    // Seed validator_error for BOTH attempts (loop exhausts budget, exits with both seeded)
    seedValidatorErrorRow("task-both-err-1");
    seedValidatorErrorRow("task-both-err-2");

    const result = await executor.execute(tmpl, "exec-valretry-2");

    // Two dispatches (original + one validator retry)
    expect(_mockCreateTaskWithAdmission).toHaveBeenCalledTimes(2);
    // cleanSlate called once for the retry attempt
    expect(_mockCleanSlatePriorAttempt).toHaveBeenCalledTimes(1);

    // Task completes (status:"completed" — the task itself finishes, validator errors are signals)
    expect(result.stepResults.get("step-vr")?.status).toBe("completed");

    // retryReason and validatorAttempt in stepStatuses
    const db = getTestDb();
    const execRow = db
      .prepare("SELECT step_statuses FROM template_executions WHERE id = ?")
      .get("exec-valretry-2") as { step_statuses: string } | undefined;
    const statuses = JSON.parse(execRow?.step_statuses ?? "{}") as Record<
      string,
      { validatorAttempt?: number; retryReason?: string }
    >;
    expect(statuses["step-vr"]?.retryReason).toBe("validator");
    expect(statuses["step-vr"]?.validatorAttempt).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Test 3: validator_error row present + retryPolicy=null/undefined → 1 dispatch only,
  //          no cleanSlate call. Validator loop condition (validatorAttempt < 1) is false.
  // ---------------------------------------------------------------------------
  it("(3) no retryPolicy → single dispatch, no cleanSlate call, validator loop skipped", async () => {
    const tmpl = make1StepTemplate({
      // No retryPolicy — maxValidatorAttempts defaults to 1, loop never enters
    });

    _mockCreateTaskWithAdmission.mockImplementation(() =>
      Promise.resolve({ ok: true, taskId: "task-nopolicy", reason: "" }),
    );
    _mockWaitForTaskCompletion.mockImplementation(() => Promise.resolve("completed" as const));

    // Validator error IS present in step_logs, but maxValidatorAttempts=1 (default),
    // so loop condition: validatorAttempt(1) < 1 → false → loop never entered.
    seedValidatorErrorRow("task-nopolicy");

    const result = await executor.execute(tmpl, "exec-valretry-3");

    // Only one dispatch (no retry)
    expect(_mockCreateTaskWithAdmission).toHaveBeenCalledTimes(1);
    // cleanSlate NOT called (loop condition 1 < 1 is false)
    expect(_mockCleanSlatePriorAttempt).not.toHaveBeenCalled();

    // Step completed (contract verification passes with no outputContract)
    expect(result.stepResults.get("step-vr")?.status).toBe("completed");
  });

  // ---------------------------------------------------------------------------
  // Test 4: NON-validator failure (no validator_error row) + retryPolicy set →
  //          transient retry used. Validator loop not entered because no validator_error row.
  // ---------------------------------------------------------------------------
  it("(4) non-validator failure with retryPolicy → transient retry used, validator loop skipped", async () => {
    const tmpl = make1StepTemplate({
      retryPolicy: { maxAttempts: 3 }, // would allow validator retries, but no validator_error row
    });

    let dispatchCount = 0;
    _mockCreateTaskWithAdmission.mockImplementation(() => {
      dispatchCount++;
      return Promise.resolve(
        dispatchCount === 1
          ? { ok: true, taskId: "task-nonval-fail", reason: "" }
          : { ok: true, taskId: "task-nonval-retry", reason: "" },
      );
    });
    let waitCount = 0;
    _mockWaitForTaskCompletion.mockImplementation(() => {
      waitCount++;
      // First: failed (non-validator). Second: completed (transient retry succeeded).
      return Promise.resolve(waitCount === 1 ? "failed" as const : "completed" as const);
    });

    // NO validator_error row seeded — this is a pure non-validator failure.
    // Transient retry (maxRetries=2) handles it.

    const result = await executor.execute(tmpl, "exec-valretry-4");

    // Transient retry: 2 dispatches (original failure + transient retry)
    expect(_mockCreateTaskWithAdmission).toHaveBeenCalledTimes(2);
    // cleanSlate NOT called (no validator_error signal → validator loop not entered)
    expect(_mockCleanSlatePriorAttempt).not.toHaveBeenCalled();

    // Transient retry succeeds → step completed
    expect(result.stepResults.get("step-vr")?.status).toBe("completed");
  });

  // ---------------------------------------------------------------------------
  // Test 5: validator_error row + maxAttempts=1 → validator loop condition
  //          (validatorAttempt(1) < 1) is false → loop never enters.
  // ---------------------------------------------------------------------------
  it("(5) maxAttempts=1 → loop never enters (1 < 1 is false), no retry, step completed", async () => {
    const tmpl = make1StepTemplate({
      retryPolicy: { maxAttempts: 1 },
    });

    _mockCreateTaskWithAdmission.mockImplementation(() =>
      Promise.resolve({ ok: true, taskId: "task-max1", reason: "" }),
    );
    _mockWaitForTaskCompletion.mockImplementation(() => Promise.resolve("completed" as const));

    // Validator error IS present, but maxAttempts=1 means loop never enters.
    seedValidatorErrorRow("task-max1");

    const result = await executor.execute(tmpl, "exec-valretry-5");

    // Only one dispatch (maxAttempts=1 → initial only, no retries)
    expect(_mockCreateTaskWithAdmission).toHaveBeenCalledTimes(1);
    // cleanSlate NOT called (loop condition 1 < 1 is false)
    expect(_mockCleanSlatePriorAttempt).not.toHaveBeenCalled();

    // Step completed (contract verification passes, validator signal not acted on)
    expect(result.stepResults.get("step-vr")?.status).toBe("completed");
  });
});
