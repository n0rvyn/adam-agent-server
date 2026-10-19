/**
 * Bundle B (#228 + #229) — L3 retry on missing-artifact + L4 nudge dispatch.
 *
 * Test pattern: vi.hoisted spy mocks (matching template-executor-length-retry.test.ts).
 * Assertions check spy call counts and call-arg dispatchSource discrimination.
 * Does NOT use DB-insert mocks — pure spies, no FK setup needed.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
const testRuntimeRoot = mkdtempSync(tmpdir() + sep + "adam-missing-artifact-test-");

// ---------------------------------------------------------------------------
// vi.hoisted() pattern: registers mocks for hoisting alongside vi.mock() factories.
// ---------------------------------------------------------------------------
const {
  _mockRunLayerA,
  _mockRunLayerB,
  _mockCreateTaskWithAdmission,
  _mockWaitForTaskCompletion,
  _mockUpdateTaskConfig,
  _mockGetArtifact,
  _mockCleanSlatePriorAttempt,
} = vi.hoisted(() => ({
  _mockRunLayerA: vi.fn(),
  _mockRunLayerB: vi.fn(),
  _mockCreateTaskWithAdmission: vi.fn().mockResolvedValue({ ok: true, taskId: "task-done", reason: "" }),
  _mockWaitForTaskCompletion: vi.fn().mockResolvedValue("completed" as const),
  _mockUpdateTaskConfig: vi.fn(),
  _mockGetArtifact: vi.fn((..._args: unknown[]): unknown => undefined),
  _mockCleanSlatePriorAttempt: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ deletedFiles: [] })),
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
  createArtifact: vi.fn(), // capture-primary path (text steps) calls this
}));

vi.mock("../../lib/artifact-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/artifact-storage.js")>();
  return {
    ...actual,
    cleanSlatePriorAttempt: (...args: unknown[]) => _mockCleanSlatePriorAttempt(...args),
  };
});

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

vi.mock("../../scheduler/wait-for-task.js", () => ({
  waitForTaskCompletion: () => _mockWaitForTaskCompletion(),
}));

vi.mock("../../lib/task-dispatch.js", () => ({
  createTaskWithAdmission: (...args: unknown[]) => _mockCreateTaskWithAdmission(...args),
}));

vi.mock("../../audit/contract-verifier.js", () => ({
  runLayerA: (...args: unknown[]) => _mockRunLayerA(...args),
  runLayerB: (...args: unknown[]) => _mockRunLayerB(...args),
}));

vi.mock("../../store/tasks.js", () => ({
  getTask: vi.fn((id: string) => ({ id, status: "completed", result: "mocked task result", config: {} })),
  updateTaskConfig: (...args: unknown[]) => _mockUpdateTaskConfig(...args),
}));

import { TemplateExecutor } from "../../scheduler/template-executor.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { createRole } from "../../store/roles.js";
import { getTemplateExecution } from "../../store/template-executions.js";
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

// ---------------------------------------------------------------------------
// L3 (#228) — missing-artifact triggers validator retry
// ---------------------------------------------------------------------------
describe("validator retry — missing-artifact gate (#228)", () => {
  let executor: TemplateExecutor;

  beforeEach(() => {
    clearTestDb();
    vi.clearAllMocks();
    process.env.ADAM_TEST_DIR = testRuntimeRoot;
    executor = new TemplateExecutor({ maxRetries: 1, baseDelayMs: 10 });
    seedRole("role-test");
    _mockCreateTaskWithAdmission.mockResolvedValue({ ok: true, taskId: "task-done", reason: "" });
    _mockWaitForTaskCompletion.mockResolvedValue("completed" as const);
    _mockRunLayerA.mockReturnValue({ passed: true, violations: [] });
    _mockRunLayerB.mockResolvedValue({ passed: true, failed: false, verifierTaskId: "verifier-ok", identityCoherent: true, upstreamGrounded: true, confidence: 0.95, issues: [] });
  });

  function makeTemplate(opts: { outputAs?: string; retryPolicy?: { maxAttempts: number } }): TaskTemplate {
    const tmpl: TaskTemplate = {
      id: `tmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: "missing-artifact-test",
      trigger: { type: "manual" },
      steps: [{
        id: "step-x",
        prompt: "do the thing",
        roleId: "role-test",
        ...(opts.outputAs ? { outputAs: opts.outputAs } : {}),
      }],
      ...(opts.retryPolicy ? { retryPolicy: opts.retryPolicy } : {}),
      enabled: true,
      createdAt: Date.now(),
    };
    createTaskTemplate(tmpl);
    return tmpl;
  }

  it("retries when step.outputAs declared, artifact absent, maxAttempts=2 (1 initial + 1 retry)", async () => {
    const tmpl = makeTemplate({ outputAs: "x", retryPolicy: { maxAttempts: 2 } });

    // Both attempts return null artifact — retry fires once, then nudge dispatches (counts as a 3rd call)
    // Note: nudge is L4, which fires when retries exhausted and artifact still missing.
    // For this L3-focused test, we count the retry separately by checking dispatchSource.
    _mockGetArtifact.mockReturnValue(undefined);

    await executor.execute(tmpl, "exec-retry-1");

    // Count non-nudge dispatches (template_step_dispatch source)
    const stepDispatches = _mockCreateTaskWithAdmission.mock.calls.filter(
      (call) => (call[0] as { dispatchSource?: string })?.dispatchSource === "template_step_dispatch",
    );
    expect(stepDispatches).toHaveLength(2); // initial + 1 validator retry
  });

  it("does not retry when artifact is present on first attempt", async () => {
    const tmpl = makeTemplate({ outputAs: "x", retryPolicy: { maxAttempts: 3 } });

    // Artifact present from the start
    _mockGetArtifact.mockReturnValue({ executionId: "exec-no-retry", stepId: "step-x", key: "x", kind: "json" });

    await executor.execute(tmpl, "exec-no-retry");

    const stepDispatches = _mockCreateTaskWithAdmission.mock.calls.filter(
      (call) => (call[0] as { dispatchSource?: string })?.dispatchSource === "template_step_dispatch",
    );
    expect(stepDispatches).toHaveLength(1); // no retry, no nudge
    // Nudge specifically not called
    const nudgeDispatches = _mockCreateTaskWithAdmission.mock.calls.filter(
      (call) => (call[0] as { dispatchSource?: string })?.dispatchSource === "template_step_nudge",
    );
    expect(nudgeDispatches).toHaveLength(0);
  });

  // NOTE: "validator_error path preservation" is verified by code structure (additive
  // `if (!hasValidatorErr && !hasMissingArtifact) break` — purely OR'd, never replaces),
  // not by a separate test. The existing template-executor-length-retry.test.ts and
  // template-executor-contract-hook.test.ts continue to exercise validator_error path
  // and still pass after Bundle B, proving the preservation.
});

// ---------------------------------------------------------------------------
// L4 (#229) — nudge dispatch when artifact missing after retries exhausted
// ---------------------------------------------------------------------------
describe("nudge dispatch — last-turn correction (#229)", () => {
  let executor: TemplateExecutor;

  beforeEach(() => {
    clearTestDb();
    vi.clearAllMocks();
    process.env.ADAM_TEST_DIR = testRuntimeRoot;
    executor = new TemplateExecutor({ maxRetries: 1, baseDelayMs: 10 });
    seedRole("role-test");
    _mockCreateTaskWithAdmission.mockResolvedValue({ ok: true, taskId: "task-done", reason: "" });
    _mockWaitForTaskCompletion.mockResolvedValue("completed" as const);
    _mockRunLayerA.mockReturnValue({ passed: true, violations: [] });
    _mockRunLayerB.mockResolvedValue({ passed: true, failed: false, verifierTaskId: "verifier-ok", identityCoherent: true, upstreamGrounded: true, confidence: 0.95, issues: [] });
  });

  function makeTemplate(opts: { outputAs?: string; retryPolicy?: { maxAttempts: number } }): TaskTemplate {
    const tmpl: TaskTemplate = {
      id: `tmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: "nudge-test",
      trigger: { type: "manual" },
      steps: [{
        id: "step-n",
        prompt: "produce x",
        roleId: "role-test",
        // Binary deliverable: the nudge / presence-gate path applies to file outputs.
        // (Text deliverables are captured from the step response, so they never nudge.)
        ...(opts.outputAs ? { outputAs: opts.outputAs, outputContract: { contractRules: [{ kind: "fileSizeBytes", min: 1 }] } } : {}),
      }],
      ...(opts.retryPolicy ? { retryPolicy: opts.retryPolicy } : {}),
      enabled: true,
      createdAt: Date.now(),
    };
    createTaskTemplate(tmpl);
    return tmpl;
  }

  it("fires nudge after maxAttempts=1 task ends with missing artifact, nudge succeeds → step completed", async () => {
    const tmpl = makeTemplate({ outputAs: "x", retryPolicy: { maxAttempts: 1 } });

    // template-executor calls getArtifact twice before the nudge runs (Fix A added an
    // up-front `artifactAlreadyPublished` check at line 670-area, in addition to the
    // existing nudge-entry check at line 688). Both must return undefined to trigger
    // nudge; the post-nudge lookup (line 693) returns the published artifact.
    _mockGetArtifact
      .mockReturnValueOnce(undefined) // artifactAlreadyPublished pre-check: not present
      .mockReturnValueOnce(undefined) // nudge-entry check: still missing → triggers nudge
      .mockReturnValue({ executionId: "exec-nudge-1", stepId: "step-n", key: "x", kind: "json" }); // post-nudge: published

    await executor.execute(tmpl, "exec-nudge-1");

    const dispatchCalls = _mockCreateTaskWithAdmission.mock.calls;
    expect(dispatchCalls).toHaveLength(2); // 1 original + 1 nudge
    expect((dispatchCalls[1][0] as { dispatchSource?: string }).dispatchSource).toBe("template_step_nudge");

    // No audit_violation recorded
    const db = getTestDb();
    const violations = db.prepare("SELECT * FROM audit_violations WHERE execution_id = ?").all("exec-nudge-1");
    expect(violations).toHaveLength(0);
  });

  it("nudge failure produces single audit_violation with metadata.nudgeAttempted=true", async () => {
    const tmpl = makeTemplate({ outputAs: "x", retryPolicy: { maxAttempts: 1 } });

    // Both original and nudge: no artifact
    _mockGetArtifact.mockReturnValue(undefined);

    await executor.execute(tmpl, "exec-nudge-fail");

    const dispatchCalls = _mockCreateTaskWithAdmission.mock.calls;
    expect(dispatchCalls).toHaveLength(2); // 1 original + 1 nudge

    const db = getTestDb();
    const violations = db.prepare("SELECT message, metadata_json FROM audit_violations WHERE execution_id = ?").all("exec-nudge-fail") as { message: string; metadata_json: string | null }[];
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toMatch(/outputAs="x"/);
    const meta = JSON.parse(violations[0].metadata_json ?? "{}");
    expect(meta.nudgeAttempted).toBe(true);
  });

  it("does NOT fire nudge when artifact is present (happy path)", async () => {
    const tmpl = makeTemplate({ outputAs: "x", retryPolicy: { maxAttempts: 1 } });

    _mockGetArtifact.mockReturnValue({ executionId: "exec-nudge-skip", stepId: "step-n", key: "x", kind: "json" });

    await executor.execute(tmpl, "exec-nudge-skip");

    const dispatchCalls = _mockCreateTaskWithAdmission.mock.calls;
    expect(dispatchCalls).toHaveLength(1); // only original, no nudge
    const nudgeCalls = dispatchCalls.filter(
      (call) => (call[0] as { dispatchSource?: string })?.dispatchSource === "template_step_nudge",
    );
    expect(nudgeCalls).toHaveLength(0);
  });

  it("nudge success: step status marked completed with retryReason='nudge' and nudgeAttempted=true", async () => {
    const tmpl = makeTemplate({ outputAs: "x", retryPolicy: { maxAttempts: 1 } });

    _mockGetArtifact
      .mockReturnValueOnce(undefined) // artifactAlreadyPublished pre-check: not present
      .mockReturnValueOnce(undefined) // nudge-entry check: still missing → triggers nudge
      .mockReturnValue({ executionId: "exec-nudge-state", stepId: "step-n", key: "x", kind: "json" }); // post-nudge: published

    await executor.execute(tmpl, "exec-nudge-state");

    const exec = getTemplateExecution("exec-nudge-state");
    expect(exec?.stepStatuses["step-n"]?.status).toBe("completed");
    expect(exec?.stepStatuses["step-n"]?.nudgeAttempted).toBe(true);
    expect(exec?.stepStatuses["step-n"]?.retryReason).toBe("nudge");
  });
});
