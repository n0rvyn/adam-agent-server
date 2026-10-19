/**
 * Task 5 test: template-executor contract hook.
 * Tests the 7 cases (a)-(g) from the plan's Task 5 step 6.
 *
 * Key insight: execute() creates its own internal context and returns it as
 * TemplateExecutionResult.stepResults — the context parameter passed to execute()
 * is IGNORED. Use the return value's stepResults Map.
 *
 * vi.mock hoisting: the mock factory body runs after the module's import phase.
 * Therefore mock factories CANNOT reference module-scope variables declared AFTER
 * vi.mock() in source order. Use vi.hoisted() so variables are registered for
 * hoisting alongside vi.mock() — the hoisted callback runs before the module
 * import phase, ensuring module-scope variables are ready.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
const testRuntimeRoot = mkdtempSync(tmpdir() + "/adam-contract-hook-test-");

// ---------------------------------------------------------------------------
// vi.hoisted() pattern: registers variables for hoisting alongside vi.mock().
// This ensures _mockCreateTaskWithAdmission is in scope when the factory body
// evaluates (factory body runs after import phase, hoisted variables are ready).
// ---------------------------------------------------------------------------
const { _mockRunLayerA, _mockRunLayerB, _mockCreateTaskWithAdmission, _mockWaitForTaskCompletion, _mockUpdateTaskConfig, _mockGetArtifact, _mockPersistClaims } =
  vi.hoisted(() => ({
    _mockRunLayerA: vi.fn(),
    _mockRunLayerB: vi.fn(),
    _mockCreateTaskWithAdmission: vi.fn().mockResolvedValue({ ok: true, taskId: "task-done", reason: "" }),
    _mockWaitForTaskCompletion: vi.fn().mockResolvedValue("completed" as const),
    _mockUpdateTaskConfig: vi.fn(),
    _mockGetArtifact: vi.fn(),
    _mockPersistClaims: vi.fn(),
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
  listArtifactsByExecution: vi.fn(() => []),
  getArtifact: (...args: unknown[]) => _mockGetArtifact(...args),
  createArtifact: vi.fn(),
}));

vi.mock("../../agent/belief-ledger.js", () => ({
  persistClaimsFromArtifactValue: (...args: unknown[]) => _mockPersistClaims(...args),
  settlePredictionsFromArtifactValue: vi.fn(() => ({ settled: 0, skipped: 0, reason: undefined })),
  findDuePredictions: vi.fn(() => []),
  checkSettlementCompleteness: vi.fn(() => ({ complete: true, shortfall: 0 })),
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
    result: "mocked task result",
    config: {},
  })),
  updateTaskConfig: (...args: unknown[]) => _mockUpdateTaskConfig(...args),
}));

import { TemplateExecutor } from "../../scheduler/template-executor.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { createRole } from "../../store/roles.js";
import { updateTask } from "../../store/tasks.js";
import type { TaskTemplate } from "../../shared/types.js";

function seedRole(id: string): void {
  createRole({
    id, name: id, cagPrompt: "test", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: `ms-${id}`,
    status: "active", preferences: {}, createdAt: Date.now(),
  });
}

afterAll(() => {
  rmSync(testRuntimeRoot, { recursive: true, force: true });
  cleanup();
});

describe("TemplateExecutor executeStep contract hook", () => {
  let executor: TemplateExecutor;

  beforeEach(() => {
    clearTestDb();
    vi.clearAllMocks();
    process.env.ADAM_TEST_DIR = testRuntimeRoot;
    executor = new TemplateExecutor({ maxRetries: 1, baseDelayMs: 10 });
    seedRole("role-test");
    // Default: task completes, Layer A+B pass
    _mockCreateTaskWithAdmission.mockResolvedValue({ ok: true, taskId: "task-done", reason: "" });
    _mockWaitForTaskCompletion.mockResolvedValue("completed" as const);
    _mockRunLayerA.mockReturnValue({ passed: true, violations: [] });
    _mockRunLayerB.mockResolvedValue({ passed: true, failed: false, verifierTaskId: "verifier-ok", identityCoherent: true, upstreamGrounded: true, confidence: 0.95, issues: [] });
    // Fix 1b: a valid json claims artifact + a spyable persist; tests assert call/no-call by contract outcome
    _mockGetArtifact.mockReturnValue({ kind: "json", value: [{ claim: "c", confidence: 0.7, falsifyCondition: "f", date: "2026-06-06" }] });
    _mockPersistClaims.mockReturnValue({ persisted: 1, skipped: 0, reason: undefined });
  });

  // ---------------------------------------------------------------------------
  // Helper: create a 1-step template and persist to DB
  // ---------------------------------------------------------------------------
  function make1StepTemplate(step: TaskTemplate["steps"][0]): TaskTemplate {
    const tmpl: TaskTemplate = {
      id: "tmpl-contract-hook",
      name: "contract-hook-test",
      trigger: { type: "manual" },
      steps: [{ ...step, roleId: step.roleId ?? "role-test" }],
      enabled: true,
      createdAt: Date.now(),
    };
    createTaskTemplate(tmpl);
    return tmpl;
  }

  // ---------------------------------------------------------------------------
  // (a) Step completes, no outputContract/persona → no verifier called, status completed
  // ---------------------------------------------------------------------------
  it("(a) no contract — step completes normally, no verifier called", async () => {
    const tmpl = make1StepTemplate({ id: "step-a", prompt: "Do something" });

    const result = await executor.execute(tmpl, "exec-contract-a");

    expect(_mockRunLayerA).not.toHaveBeenCalled();
    expect(_mockRunLayerB).not.toHaveBeenCalled();
    expect(result.stepResults.get("step-a")?.status).toBe("completed");
  });

  // ---------------------------------------------------------------------------
  // (b) Layer A fails → status failed, error contains Layer A message
  // ---------------------------------------------------------------------------
  // (b) Pure design: ANY Layer A failure → immediate fail (no retry), Layer B skipped. Post-hoc
  // content retry was removed; content correction now happens in-session at the PreToolUse boundary
  // hook (Track A). Layer A emits only presence-gate (outputAs) + persona violations.
  // ---------------------------------------------------------------------------
  it("(b) Layer A violation → immediate fail, no retry, Layer B skipped, violations recorded", async () => {
    const tmpl = make1StepTemplate({
      id: "step-b",
      prompt: "Write something short",
      outputContract: { contractRules: [{ kind: "lengthTarget", min: 100, max: 200, unit: "characters" }] },
      persona: { speakAs: "卞旸" },
    });

    _mockRunLayerA.mockReturnValueOnce({
      passed: false,
      violations: [
        { contractField: "outputAs", message: "no artifact published under key 终稿" },
        { contractField: "persona.speakAs", message: "expected first-person as 卞旸, but output self-identifies as 达芬奇" },
      ],
    });

    const result = await executor.execute(tmpl, "exec-contract-b");

    expect(_mockRunLayerA).toHaveBeenCalled();
    expect(_mockRunLayerB).not.toHaveBeenCalled(); // Layer B skipped when Layer A fails
    expect(result.stepResults.get("step-b")?.status).toBe("failed");
    expect(result.stepResults.get("step-b")?.error).toContain("契约校验失败（Layer A）");
    // Violations surface in the error message
    expect(result.stepResults.get("step-b")?.error).toContain("no artifact published under key 终稿");
    // Single dispatch (no post-hoc retry)
    expect(_mockCreateTaskWithAdmission).toHaveBeenCalledTimes(1);

    // CG-001 regression guard: outputContractCheckCount must be persisted to task config.
    // Step declares one lengthTarget contractRule + persona.speakAs → check count = 2.
    expect(_mockUpdateTaskConfig).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ outputContractCheckCount: 2 }),
    );
  });

  // ---------------------------------------------------------------------------
  // (c) Layer A pass, Layer B pass → status completed
  // ---------------------------------------------------------------------------
  it("(c) Layer A pass + Layer B pass → step status completed", async () => {
    const tmpl = make1StepTemplate({
      id: "step-c",
      prompt: "Write a good script",
      outputContract: { contractRules: [{ kind: "lengthTarget", min: 100, max: 200, unit: "characters" }] },
    });

    _mockRunLayerA.mockReturnValueOnce({ passed: true, violations: [] });
    _mockRunLayerB.mockResolvedValueOnce({
      passed: true, failed: false, verifierTaskId: "verifier-1",
      identityCoherent: true, upstreamGrounded: true, confidence: 0.95, issues: [],
    });

    const result = await executor.execute(tmpl, "exec-contract-c");

    expect(_mockRunLayerA).toHaveBeenCalled();
    expect(_mockRunLayerB).toHaveBeenCalled();
    expect(result.stepResults.get("step-c")?.status).toBe("completed");
    expect(result.stepResults.get("step-c")?.error).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // (d) Layer A pass, Layer B fail confidence 0.85 → retry once; retry passes Layer A → status completed, contractRetried: true
  // ---------------------------------------------------------------------------
  it("(d) Layer B high-confidence fail → retry dispatched once; retry passes Layer A → status completed, contractRetried=true", async () => {
    const tmpl = make1StepTemplate({
      id: "step-d",
      prompt: "Write as 卞旸",
      outputContract: { contractRules: [{ kind: "lengthTarget", min: 100, max: 200, unit: "characters" }] },
      persona: { speakAs: "卞旸" },
    });

    // First dispatch: producer task completes
    _mockCreateTaskWithAdmission
      .mockResolvedValueOnce({ ok: true, taskId: "task-d-first", reason: "" })
      // Retry dispatch: producer task completes (no verifier dispatch on retry)
      .mockResolvedValueOnce({ ok: true, taskId: "task-d-retry", reason: "" });

    // Layer A: first pass → Layer B fails → retry → retry Layer A passes
    _mockRunLayerA
      .mockReturnValueOnce({ passed: true, violations: [] })   // first: pass
      .mockReturnValueOnce({ passed: true, violations: [] }); // retry: pass
    _mockRunLayerB.mockResolvedValueOnce({
      passed: false, failed: false, verifierTaskId: "verifier-d",
      identityCoherent: false, upstreamGrounded: true, confidence: 0.85,
      issues: ["self-identifies as 达芬奇"],
    });

    const result = await executor.execute(tmpl, "exec-contract-d");

    // 2 dispatches: original + retry
    expect(_mockCreateTaskWithAdmission).toHaveBeenCalledTimes(2);
    // Layer A called twice (original + retry); Layer B called once
    expect(_mockRunLayerA).toHaveBeenCalledTimes(2);
    expect(_mockRunLayerB).toHaveBeenCalledTimes(1);

    expect(result.stepResults.get("step-d")?.status).toBe("completed");

    // contractRetried is stored in DB step_statuses JSON
    const db = getTestDb();
    const execRow = db.prepare("SELECT step_statuses FROM template_executions WHERE id = ?").get("exec-contract-d") as { step_statuses: string } | undefined;
    const statuses = JSON.parse(execRow?.step_statuses ?? "{}") as Record<string, { contractRetried?: boolean }>;
    expect(statuses["step-d"]?.contractRetried).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // (e) Retry fails Layer A → status failed, error contains "契约重试后仍失败"
  // ---------------------------------------------------------------------------
  it("(e) Retry fails Layer A → status failed, error contains '契约重试后仍失败'", async () => {
    const tmpl = make1StepTemplate({
      id: "step-e",
      prompt: "Write as 卞旸",
      outputContract: { contractRules: [{ kind: "lengthTarget", min: 100, max: 200, unit: "characters" }] },
      persona: { speakAs: "卞旸" },
    });

    _mockCreateTaskWithAdmission
      .mockResolvedValueOnce({ ok: true, taskId: "task-e-first", reason: "" })
      .mockResolvedValueOnce({ ok: true, taskId: "task-e-retry", reason: "" });

    _mockRunLayerA
      .mockReturnValueOnce({ passed: true, violations: [] })   // first: pass
      .mockReturnValueOnce({
        passed: false,
        violations: [{ contractField: "lengthTarget", message: "actual 20 characters / target 100-200 characters" }],
      }); // retry: fail
    _mockRunLayerB.mockResolvedValueOnce({
      passed: false, failed: false, verifierTaskId: "verifier-e",
      identityCoherent: false, upstreamGrounded: true, confidence: 0.88,
      issues: ["self-identifies as 达芬奇"],
    });

    const result = await executor.execute(tmpl, "exec-contract-e");

    expect(result.stepResults.get("step-e")?.status).toBe("failed");
    expect(result.stepResults.get("step-e")?.error).toContain("契约校验失败（verifier retry）");
  });

  // ---------------------------------------------------------------------------
  // (f) Layer B confidence 0.65 → no retry; status failed, error contains "Layer B 信心不足"
  // ---------------------------------------------------------------------------
  it("(f) Layer B confidence 0.65 → no retry; status failed, error contains 'Layer B 信心不足'", async () => {
    const tmpl = make1StepTemplate({
      id: "step-f",
      prompt: "Write as 卞旸",
      outputContract: { contractRules: [{ kind: "lengthTarget", min: 100, max: 200, unit: "characters" }] },
      persona: { speakAs: "卞旸" },
    });

    _mockCreateTaskWithAdmission.mockResolvedValueOnce({ ok: true, taskId: "task-f", reason: "" });
    _mockRunLayerA.mockReturnValueOnce({ passed: true, violations: [] });
    _mockRunLayerB.mockResolvedValueOnce({
      passed: false, failed: false, verifierTaskId: "verifier-f",
      identityCoherent: false, upstreamGrounded: true, confidence: 0.65,
      issues: ["some issue"],
    });

    const result = await executor.execute(tmpl, "exec-contract-f");

    // Only one dispatch (no retry because confidence <= 0.7)
    expect(_mockCreateTaskWithAdmission).toHaveBeenCalledTimes(1);
    expect(_mockRunLayerA).toHaveBeenCalledTimes(1);
    expect(_mockRunLayerB).toHaveBeenCalledTimes(1);

    expect(result.stepResults.get("step-f")?.status).toBe("failed");
    expect(result.stepResults.get("step-f")?.error).toContain("Layer B 信心不足");
  });

  // ---------------------------------------------------------------------------
  // (g) Layer B fail with confidence 0.85 → retry's admission returns ok:false → status failed, error contains "契约重试派发失败"
  // ---------------------------------------------------------------------------
  it("(g) Retry admission failure → status failed, error contains '契约重试派发失败'", async () => {
    const tmpl = make1StepTemplate({
      id: "step-g",
      prompt: "Write as 卞旸",
      outputContract: { contractRules: [{ kind: "lengthTarget", min: 100, max: 200, unit: "characters" }] },
      persona: { speakAs: "卞旸" },
    });

    // First dispatch succeeds
    _mockCreateTaskWithAdmission.mockResolvedValueOnce({ ok: true, taskId: "task-g-first", reason: "" });
    // Retry dispatch fails admission
    _mockCreateTaskWithAdmission.mockResolvedValueOnce({
      ok: false, taskId: "", reason: "Role temporarily unavailable",
    });

    _mockRunLayerA.mockReturnValueOnce({ passed: true, violations: [] });
    _mockRunLayerB.mockResolvedValueOnce({
      passed: false, failed: false, verifierTaskId: "verifier-g",
      identityCoherent: false, upstreamGrounded: true, confidence: 0.9,
      issues: ["self-identifies as 达芬奇"],
    });

    const result = await executor.execute(tmpl, "exec-contract-g");

    expect(_mockCreateTaskWithAdmission).toHaveBeenCalledTimes(2);

    expect(result.stepResults.get("step-g")?.status).toBe("failed");
    expect(result.stepResults.get("step-g")?.error).toContain("契约重试派发失败");
    expect(result.stepResults.get("step-g")?.error).toContain("Role temporarily unavailable");
  });

  // ---------------------------------------------------------------------------
  // (h) Layer B retry preserves feedback block content byte-for-byte (Task 4 regression guard)
  // ---------------------------------------------------------------------------
  it("(h) Layer B retry preserves feedback block content byte-for-byte after retryStepWithFeedback refactor", async () => {
    const tmpl = make1StepTemplate({
      id: "step-h",
      prompt: "Write as 卞旸",
      outputContract: { contractRules: [{ kind: "lengthTarget", min: 100, max: 200, unit: "characters" }] },
      persona: { speakAs: "卞旸" },
    });

    // Capture the retry dispatch's prompt
    let capturedRetryPrompt = "";
    _mockCreateTaskWithAdmission.mockImplementation(async (args: { prompt: string }) => {
      if (_mockCreateTaskWithAdmission.mock.calls.length === 1) {
        return { ok: true, taskId: "task-first-h" };
      }
      capturedRetryPrompt = args.prompt;
      return { ok: true, taskId: "task-retry-h" };
    });

    _mockRunLayerA
      .mockReturnValueOnce({ passed: true, violations: [] })
      .mockReturnValueOnce({ passed: true, violations: [] });

    _mockRunLayerB.mockResolvedValueOnce({
      passed: false, failed: false, verifierTaskId: "verifier-h",
      identityCoherent: false, upstreamGrounded: true, confidence: 0.9,
      issues: ["identity_inconsistent: speaks as 达芬奇 not 卞旸"],
    });

    await executor.execute(tmpl, "exec-contract-h");

    // The retry dispatch is the SECOND call to createTaskWithAdmission
    expect(_mockCreateTaskWithAdmission).toHaveBeenCalledTimes(2);

    // Assert the feedback block content is preserved byte-for-byte
    expect(capturedRetryPrompt).toContain("<verifier_feedback>");
    expect(capturedRetryPrompt).toContain("Your previous attempt was rejected by the contract verifier with these findings:");
    expect(capturedRetryPrompt).toContain("- identity_inconsistent: speaks as 达芬奇 not 卞旸");
    expect(capturedRetryPrompt).toContain("Please rewrite your output addressing each issue. Maintain persona");
    expect(capturedRetryPrompt).toContain("</verifier_feedback>");
    // The original prompt body must follow after the feedback block
    expect(capturedRetryPrompt.indexOf("</verifier_feedback>")).toBeLessThan(capturedRetryPrompt.indexOf("Write as 卞旸"));
  });

  // ---------------------------------------------------------------------------
  // (i) Retry gate at confidence EXACTLY 0.7 → retry IS dispatched (>= boundary).
  //     Mirrors (f) at 0.65 (no retry) — the boundary value flips behavior.
  // ---------------------------------------------------------------------------
  it("(i) Layer B fail at confidence=0.7 → retry dispatched (>= boundary, was no-retry under > 0.7)", async () => {
    const tmpl = make1StepTemplate({
      id: "step-i",
      prompt: "Write as 卞旸",
      outputContract: { contractRules: [{ kind: "lengthTarget", min: 100, max: 200, unit: "characters" }] },
      persona: { speakAs: "卞旸" },
    });

    _mockCreateTaskWithAdmission
      .mockResolvedValueOnce({ ok: true, taskId: "task-i-first", reason: "" })
      .mockResolvedValueOnce({ ok: true, taskId: "task-i-retry", reason: "" });
    _mockRunLayerA
      .mockReturnValueOnce({ passed: true, violations: [] })
      .mockReturnValueOnce({ passed: true, violations: [] });
    _mockRunLayerB.mockResolvedValueOnce({
      passed: false, failed: false, verifierTaskId: "verifier-i",
      identityCoherent: false, upstreamGrounded: true, confidence: 0.7,
      issues: ["borderline identity"],
    });

    const result = await executor.execute(tmpl, "exec-contract-i");

    // 0.7 now clears the retry gate → 2 dispatches (original + retry), retry passes Layer A
    expect(_mockCreateTaskWithAdmission).toHaveBeenCalledTimes(2);
    expect(_mockRunLayerB).toHaveBeenCalledTimes(1);
    expect(result.stepResults.get("step-i")?.status).toBe("completed");
  });

  // ---------------------------------------------------------------------------
  // (j) Fix A: pure data-JSON step (format=json, no persona, no mustRef) → Layer B SKIPPED
  // ---------------------------------------------------------------------------
  it("(j) format=json step with no persona → Layer B not called, step completed (本期下注/结算)", async () => {
    const tmpl = make1StepTemplate({
      id: "step-j",
      prompt: "Emit bets as a JSON array",
      outputContract: { contractRules: [{ kind: "format", value: "json" }] },
    });

    _mockRunLayerA.mockReturnValueOnce({ passed: true, violations: [] });

    const result = await executor.execute(tmpl, "exec-contract-j");

    expect(_mockRunLayerA).toHaveBeenCalledTimes(1); // Layer A still runs
    expect(_mockRunLayerB).not.toHaveBeenCalled();    // Layer B skipped for pure data JSON
    expect(result.stepResults.get("step-j")?.status).toBe("completed");
  });

  // ---------------------------------------------------------------------------
  // (k) Fix A regression: format=json WITH a persona (定稿) → Layer B STILL called
  // ---------------------------------------------------------------------------
  it("(k) format=json step WITH persona → Layer B still called (定稿 keeps identity check)", async () => {
    const tmpl = make1StepTemplate({
      id: "step-k",
      prompt: "Finalize the script",
      outputContract: { contractRules: [{ kind: "format", value: "json" }] },
      persona: { speakAs: "快刀青衣" },
    });

    _mockRunLayerA.mockReturnValueOnce({ passed: true, violations: [] });
    _mockRunLayerB.mockResolvedValueOnce({
      passed: true, failed: false, verifierTaskId: "verifier-k",
      identityCoherent: true, upstreamGrounded: true, confidence: 0.95, issues: [],
    });

    const result = await executor.execute(tmpl, "exec-contract-k");

    expect(_mockRunLayerB).toHaveBeenCalledTimes(1); // persona present → not skipped
    expect(result.stepResults.get("step-k")?.status).toBe("completed");
  });

  // ---------------------------------------------------------------------------
  // (l) Fix 1b: claim-publishing step PASSES contract → belief written (deferred after contract)
  // ---------------------------------------------------------------------------
  it("(l) publishesClaimsTo + contract pass → claims persisted (本期下注 happy path)", async () => {
    const tmpl = make1StepTemplate({
      id: "step-l",
      prompt: "Emit bets",
      outputAs: "本期下注",
      publishesClaimsTo: "podcast-show",
      outputContract: { contractRules: [{ kind: "format", value: "json" }] },
    });

    _mockRunLayerA.mockReturnValueOnce({ passed: true, violations: [] });

    const result = await executor.execute(tmpl, "exec-contract-l");

    expect(result.stepResults.get("step-l")?.status).toBe("completed");
    expect(_mockRunLayerB).not.toHaveBeenCalled();        // Fix A: pure json skips Layer B
    expect(_mockPersistClaims).toHaveBeenCalledTimes(1);  // Fix 1b: pass → written
  });

  // ---------------------------------------------------------------------------
  // (m) Fix 1b: claim-publishing step FAILS contract → belief NOT written (no orphan)
  // ---------------------------------------------------------------------------
  it("(m) publishesClaimsTo + Layer A fail → claims NOT persisted (no orphaned belief)", async () => {
    const tmpl = make1StepTemplate({
      id: "step-m",
      prompt: "Emit bets",
      outputAs: "本期下注",
      publishesClaimsTo: "podcast-show",
      outputContract: { contractRules: [{ kind: "format", value: "json" }] },
    });

    _mockRunLayerA.mockReturnValueOnce({
      passed: false,
      violations: [{ contractField: "outputAs", message: "no artifact published under key 本期下注" }],
    });

    const result = await executor.execute(tmpl, "exec-contract-m");

    expect(result.stepResults.get("step-m")?.status).toBe("failed");
    expect(_mockPersistClaims).not.toHaveBeenCalled();  // Fix 1b: contract failed → no ledger write
  });
});
