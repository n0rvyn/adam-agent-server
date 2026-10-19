/**
 * Task 5-tests: Universal content gate — outputAs artifact must be non-empty and not the sentinel.
 *
 * Tests the present-but-degenerate case: the role itself published an artifact into the DB
 * during execution (so `getArtifact` is truthy at validator-loop time), but the artifact
 * content is the internal sentinel or empty. The existing `hasMissingArtifact` check does NOT
 * catch this case (artifact IS present → hasMissingArtifact = false). Only the new
 * `isValidDeliverable` validity check (Task 5-impl) catches it.
 *
 * PRE-IMPL behavior: artifact present (even if sentinel/empty) → hasMissingArtifact=false →
 *   validator loop breaks immediately → step accepts degenerate artifact → WRONG.
 *
 * POST-IMPL behavior: `!getArtifact(...) || !isValidDeliverable(getArtifact(...))` replaces
 *   `!getArtifact(...)` at lines 800 and 852 → sentinel/empty artifact treated like missing →
 *   validator loop re-dispatches → step gets a second chance.
 *
 * Fixtures:
 *   1. Degenerate (sentinel) artifact present at loop time → loop re-dispatches (FAILS pre-impl)
 *   2. Real content artifact → loop does NOT re-dispatch (regression — passes pre-impl)
 *   3. {status:"no_content"} json marker → valid declared outcome, passes (regression)
 *
 * Required: templateRetryPolicy.maxAttempts = 2 — without it the while body never runs
 * and the validity assertion is vacuous.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
const testRuntimeRoot = mkdtempSync(tmpdir() + sep + "adam-content-gate-test-");

const SENTINEL = "ExecutionManager: SDK loop force-closed after activity timeout";

// ---------------------------------------------------------------------------
// vi.hoisted() mocks
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
import type { Artifact } from "../../store/artifacts.js";

afterAll(() => {
  rmSync(testRuntimeRoot, { recursive: true, force: true });
  cleanup();
});

function seedRole(): void {
  createRole({
    id: "role-content-gate",
    name: "role-content-gate",
    cagPrompt: "test",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "ms-content-gate",
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  });
}

/**
 * Build a minimal Artifact object representing a role-published degenerate JSON artifact.
 * kind="json" is used here because when a role calls write_artifact(value: "some string"),
 * the platform stores it as kind="json" (no format=markdown contract → stays JSON).
 * This means `isValidDeliverable` can inspect `value` directly without reading a blob file.
 * The sentinel case: role wrote `write_artifact(value: SENTINEL_STRING)` → kind="json",
 * value=SENTINEL_STRING. isValidDeliverable must reject it via isInternalSentinel(value).
 */
function makeJsonArtifact(value: unknown, overrides?: Partial<Artifact>): Artifact {
  const serialized = JSON.stringify(value);
  return {
    id: `art-${Date.now()}`,
    executionId: "exec-content-gate",
    stepId: "step-cg",
    key: "output-key",
    kind: "json" as const,
    value,
    blobPath: undefined,
    mime: "application/json",
    originalFilename: undefined,
    roleId: "role-content-gate",
    sourceKind: "template_step" as const,
    sizeBytes: Buffer.byteLength(serialized, "utf8"),
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * Build a no_content json artifact (valid declared outcome).
 */
function makeNoContentArtifact(): Artifact {
  return makeJsonArtifact({ status: "no_content" });
}

function makeTemplateWithOutputAs(
  id: string,
  retryPolicy: { maxAttempts: number },
): TaskTemplate {
  const tmpl: TaskTemplate = {
    id: `tmpl-cg-${id}`,
    name: `content-gate-${id}`,
    trigger: { type: "manual" },
    steps: [{
      id: `step-${id}`,
      prompt: "Publish the required artifact",
      roleId: "role-content-gate",
      outputAs: "output-key",
      // No outputContract — ungated step, universal floor only
    }],
    enabled: true,
    createdAt: Date.now(),
    retryPolicy,
  };
  createTaskTemplate(tmpl);
  return tmpl;
}

describe("TemplateExecutor content gate: outputAs artifact must be non-degenerate (Task 5)", () => {
  let executor: TemplateExecutor;

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
    // maxRetries=1: keep transient loop to 1 dispatch so only the validator loop fires
    executor = new TemplateExecutor({ maxRetries: 1, baseDelayMs: 10 });
    seedRole();
    _mockCleanSlatePriorAttempt.mockResolvedValue({ deletedRows: 1, deletedFiles: 1 });
    _mockRunLayerA.mockReturnValue({ passed: true, violations: [] });
    _mockRunLayerB.mockResolvedValue({
      passed: true, failed: false, verifierTaskId: "verifier-ok",
      identityCoherent: true, upstreamGrounded: true, confidence: 0.95, issues: [],
    });
    _mockGetTask.mockImplementation((id: string) => ({
      id,
      status: "completed" as const,
      result: "Task result",
      config: {},
      createdAt: Date.now(),
      completedAt: Date.now(),
    }));
  });

  // ---------------------------------------------------------------------------
  // Fixture 1 (present-but-degenerate): The role published a sentinel artifact
  // into the DB at validator-loop time. `getArtifact` returns it (truthy), but
  // it is the internal sentinel — not a valid deliverable.
  //
  // PRE-IMPL: hasMissingArtifact=false (artifact present) → loop breaks → NO re-dispatch.
  // POST-IMPL: !isValidDeliverable(art) → treated like missing → loop RE-DISPATCHES.
  // ---------------------------------------------------------------------------
  it("(1) sentinel artifact present at loop time → validator loop re-dispatches (FAILS pre-impl)", async () => {
    const tmpl = makeTemplateWithOutputAs("sentinel", { maxAttempts: 2 });

    let dispatchCount = 0;
    _mockCreateTaskWithAdmission.mockImplementation(() => {
      dispatchCount++;
      return Promise.resolve({ ok: true, taskId: `task-sentinel-${dispatchCount}`, reason: "" });
    });

    _mockWaitForTaskCompletion.mockImplementation(() =>
      Promise.resolve("completed" as const),
    );

    // getArtifact returns a sentinel JSON artifact on FIRST validator-loop check
    // (lines 800 and 852), but returns a valid artifact on re-check after re-dispatch.
    // Using kind="json" + value=SENTINEL so isValidDeliverable can inspect value directly.
    let getArtifactCallCount = 0;
    _mockGetArtifact.mockImplementation((_execId: string, _stepId: string, _key: string) => {
      getArtifactCallCount++;
      // First 3 calls: return sentinel artifact (validator-loop initial checks + re-entry checks)
      // Later: return valid artifact (second dispatch succeeded)
      if (getArtifactCallCount <= 3) {
        return makeJsonArtifact(SENTINEL);
      }
      // Valid large artifact after re-dispatch
      return makeJsonArtifact("Real podcast content ".repeat(100));
    });

    await executor.execute(tmpl, "exec-content-gate-sentinel");

    // POST-IMPL ASSERTION:
    // cleanSlatePriorAttempt should have been called (validator loop re-dispatched)
    // PRE-IMPL: this fails because hasMissingArtifact=false with a present artifact → no re-dispatch
    expect(_mockCleanSlatePriorAttempt).toHaveBeenCalledTimes(1);

    // Total dispatches must be ≥ 2 (re-dispatch happened)
    expect(dispatchCount).toBeGreaterThanOrEqual(2);
  });

  // ---------------------------------------------------------------------------
  // Fixture 2 (regression): A real content artifact is present → loop does NOT retry.
  // ---------------------------------------------------------------------------
  it("(2) valid real-content artifact → loop does NOT re-dispatch (regression)", async () => {
    const tmpl = makeTemplateWithOutputAs("valid", { maxAttempts: 2 });

    let dispatchCount = 0;
    _mockCreateTaskWithAdmission.mockImplementation(() => {
      dispatchCount++;
      return Promise.resolve({ ok: true, taskId: `task-valid-${dispatchCount}`, reason: "" });
    });

    _mockWaitForTaskCompletion.mockImplementation(() =>
      Promise.resolve("completed" as const),
    );

    // Always return a valid real-content artifact (json kind, non-sentinel string value)
    _mockGetArtifact.mockReturnValue(makeJsonArtifact("Real podcast content, long enough to be valid. ".repeat(50)));

    await executor.execute(tmpl, "exec-content-gate-valid");

    // Loop should NOT re-dispatch — valid artifact passes immediately
    expect(_mockCleanSlatePriorAttempt).not.toHaveBeenCalled();
    expect(dispatchCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Fixture 3 (regression): A no_content json marker is a valid declared outcome.
  // isValidDeliverable must return true for it (kind=json, value.status="no_content").
  // ---------------------------------------------------------------------------
  it("(3) {status:no_content} json marker → valid declared outcome, not treated as degenerate", async () => {
    const tmpl = makeTemplateWithOutputAs("no-content", { maxAttempts: 2 });

    let dispatchCount = 0;
    _mockCreateTaskWithAdmission.mockImplementation(() => {
      dispatchCount++;
      return Promise.resolve({ ok: true, taskId: `task-nc-${dispatchCount}`, reason: "" });
    });

    _mockWaitForTaskCompletion.mockImplementation(() =>
      Promise.resolve("completed" as const),
    );

    // Return a no_content artifact — valid declared outcome
    _mockGetArtifact.mockReturnValue(makeNoContentArtifact());

    await executor.execute(tmpl, "exec-content-gate-nc");

    // no_content is valid → loop does NOT re-dispatch
    expect(_mockCleanSlatePriorAttempt).not.toHaveBeenCalled();
    expect(dispatchCount).toBe(1);
  });
});
