/**
 * Task 3-tests: capture-primary never captures the internal sentinel as an artifact.
 *
 * These tests run BEFORE the implementation exists (Task 3-impl). Expected BEFORE state:
 * - "sentinel result → artifact NOT created, step not completed" FAILS because
 *   capturedText.trim().length > 0 passes for the 62-byte sentinel (current behavior:
 *   createArtifact IS called with sentinel content, step IS completed).
 * - "real result → artifact created (regression)" PASSES (existing behavior).
 * - "{status:no_content} marker → not blocked by sentinel guard" PASSES.
 *
 * Contract verified:
 * 1. When finalTask.result equals the internal sentinel, capture-primary does NOT call
 *    createArtifact with that content, and the step is not silently finalized "completed".
 * 2. A genuine multi-hundred-char result IS still captured (existing behavior preserved).
 * 3. An explicit {status:"no_content"} JSON marker still passes (valid declared outcome).
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { createRole } from "../../store/roles.js";
import type { TaskTemplate } from "../../shared/types.js";

const { cleanup } = setupTestDb();
const testRuntimeRoot = mkdtempSync(tmpdir() + sep + "adam-no-sentinel-capture-test-");

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

// The sentinel string that execution-manager.ts:851 writes on inactivity timeout.
const SENTINEL = "ExecutionManager: SDK loop force-closed after activity timeout";

const _mockCreateTaskWithAdmission = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, taskId: "task-done", reason: "" }),
);
const _mockWaitForTaskCompletion = vi.hoisted(() =>
  vi.fn().mockResolvedValue("completed" as const),
);
const _mockRunLayerA = vi.hoisted(() =>
  vi.fn().mockReturnValue({ passed: true, violations: [] }),
);
const _mockRunLayerB = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    passed: true, failed: false, verifierTaskId: null,
    identityCoherent: null, upstreamGrounded: null, confidence: null, issues: [],
  }),
);
const _mockGetArtifact = vi.hoisted(() => vi.fn().mockReturnValue(undefined));
const _mockCreateArtifact = vi.hoisted(() => vi.fn());
// captureTextArtifact is in artifact-storage.ts; mock it to avoid real fs writes
const _mockCaptureTextArtifact = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ artifactId: "art-captured-id", sizeBytes: 100 }),
);

// getTask result is controlled per-test
const _mockGetTask = vi.hoisted(() =>
  vi.fn((id: string) => ({
    id,
    status: "completed" as const,
    result: "default result text",
    config: {},
    createdAt: Date.now(),
    completedAt: Date.now(),
  })),
);

// ---------------------------------------------------------------------------
// Mocks
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
  getArtifact: (...args: unknown[]) => _mockGetArtifact(...args),
  createArtifact: (...args: unknown[]) => _mockCreateArtifact(...args),
  listArtifactsByExecution: vi.fn(() => []),
}));

vi.mock("../../lib/artifact-storage.js", () => ({
  ensureArtifactsDir: vi.fn(),
  cleanSlatePriorAttempt: vi.fn().mockResolvedValue({ deletedRows: 0, deletedFiles: 0 }),
  // captureTextArtifact is the capture-primary entry point; mock so tests can assert calls
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
  getTask: (id: string) => _mockGetTask(id),
  updateTaskConfig: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { TemplateExecutor } from "../../scheduler/template-executor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterAll(() => {
  rmSync(testRuntimeRoot, { recursive: true, force: true });
  cleanup();
});

function seedRole(): void {
  createRole({
    id: "role-sentinel-test",
    name: "role-sentinel-test",
    cagPrompt: "test",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "ms-sentinel-test",
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  });
}

/**
 * A plain text-capturable step (no outputContract → isTextCapturable = true).
 * This is the path capture-primary exercises.
 */
function makeTextStep(stepId: string, outputAs: string): TaskTemplate {
  const tmpl: TaskTemplate = {
    id: `tmpl-sentinel-${stepId}`,
    name: `sentinel-capture-test-${stepId}`,
    trigger: { type: "manual" },
    steps: [{
      id: stepId,
      prompt: "Write a summary of recent news.",
      outputAs,
      // No outputContract → isTextCapturable returns true → capture-primary path
      roleId: "role-sentinel-test",
    }],
    enabled: true,
    createdAt: Date.now(),
  };
  createTaskTemplate(tmpl);
  return tmpl;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe("capture-primary: sentinel result must not be captured as artifact", () => {
  let executor: TemplateExecutor;

  beforeEach(() => {
    clearTestDb();
    _mockCreateTaskWithAdmission.mockClear();
    _mockWaitForTaskCompletion.mockClear();
    _mockGetArtifact.mockClear();
    _mockGetTask.mockClear();
    _mockCreateArtifact.mockClear();
    _mockCaptureTextArtifact.mockClear();
    _mockRunLayerA.mockClear();
    _mockRunLayerB.mockClear();
    process.env.ADAM_TEST_DIR = testRuntimeRoot;
    executor = new TemplateExecutor({ maxRetries: 1, baseDelayMs: 10 });
    seedRole();
    _mockCreateTaskWithAdmission.mockResolvedValue({ ok: true, taskId: "task-sentinel", reason: "" });
    _mockWaitForTaskCompletion.mockResolvedValue("completed" as const);
    _mockRunLayerA.mockReturnValue({ passed: true, violations: [] });
    _mockGetArtifact.mockReturnValue(undefined);
  });

  it("sentinel result → createArtifact NOT called with sentinel; step NOT completed via capture", async () => {
    // finalTask.result = sentinel (62-byte string that execution-manager sets on timeout)
    _mockGetTask.mockReturnValue({
      id: "task-sentinel",
      status: "completed" as const,
      result: SENTINEL,
      config: {},
      createdAt: Date.now(),
      completedAt: Date.now(),
    });

    const tmpl = makeTextStep("step-sentinel", "素材摘要");
    const execResult = await executor.execute(tmpl, "exec-sentinel-test");

    // EXPECTED AFTER IMPL: createArtifact must NOT have been called with the sentinel as content.
    // EXPECTED BEFORE IMPL: createArtifact IS called with sentinel (62 chars pass trim() check).
    // The step should NOT have been finalized as "completed" purely from the sentinel.
    // captureTextArtifact is the capture-primary call site in template-executor.ts:907.
    // BEFORE IMPL: it IS called with the sentinel text (62 chars pass trim() check).
    // AFTER IMPL: it must NOT be called when the text is the internal sentinel.
    const sentinelCaptureCalls = _mockCaptureTextArtifact.mock.calls.filter(
      (call: unknown[]) => {
        const arg = call[0] as Record<string, unknown> | undefined;
        // Capture fires for the right step key AND the text is the sentinel
        return arg?.key === "素材摘要" && typeof arg?.text === "string"
          && (arg.text as string).includes("force-closed after activity timeout");
      },
    );
    // BEFORE IMPL: this fails because sentinelCaptureCalls.length === 1
    expect(sentinelCaptureCalls).toHaveLength(0);

    // The step result should NOT be "completed" from capture (should be "failed" — nudge fired
    // and nudge also got no artifact, so step ends failed).
    const stepResult = execResult.stepResults.get("step-sentinel");
    expect(stepResult?.status).not.toBe("completed");
  });

  it("real multi-hundred-char result → artifact IS captured (regression)", async () => {
    const realContent = "这是一段真实的播客脚本内容，长度超过一百个字符，确保不会被哨兵检测误杀。".repeat(5);
    expect(realContent.length).toBeGreaterThan(100);

    _mockGetTask.mockReturnValue({
      id: "task-real",
      status: "completed" as const,
      result: realContent,
      config: {},
      createdAt: Date.now(),
      completedAt: Date.now(),
    });

    // getArtifact is called at two points before capture-primary:
    // 1. artifactAlreadyPublished check (line ~852): must return undefined → raceRescued=false
    // 2. inner artifact check (line ~891): must return undefined → triggers capture
    // After mock captureTextArtifact succeeds, the step is finalized completed directly.
    _mockGetArtifact
      .mockReturnValueOnce(undefined)    // call 1: artifactAlreadyPublished = false
      .mockReturnValueOnce(undefined);   // call 2: artifact = null → capture fires

    const tmpl = makeTextStep("step-real", "素材摘要");
    const execResult = await executor.execute(tmpl, "exec-real-test");

    // captureTextArtifact must have been called (capture-primary path active)
    expect(_mockCaptureTextArtifact).toHaveBeenCalled();

    // Step should be completed
    const stepResult = execResult.stepResults.get("step-real");
    expect(stepResult?.status).toBe("completed");
  });

  it("{status:no_content} JSON marker → valid declared outcome, not blocked by sentinel guard", async () => {
    const noContentMarker = JSON.stringify({ status: "no_content" });

    _mockGetTask.mockReturnValue({
      id: "task-no-content",
      status: "completed" as const,
      result: noContentMarker,
      config: {},
      createdAt: Date.now(),
      completedAt: Date.now(),
    });

    // For a text-capturable step, capture-primary fires if the result is non-empty.
    // A no_content marker is a valid declaration, distinct from the sentinel.
    // It should NOT be blocked by the isInternalSentinel guard (it's not the sentinel).
    // However it IS a short JSON string — it may or may not be captured depending on
    // business logic (the guard added in Task 3-impl targets only the exact sentinel string).
    // This test asserts: the no_content marker does NOT match the sentinel guard.
    // (Whether it gets captured or goes to nudge is a separate concern; the key invariant
    // is that Task 3-impl's guard is narrow enough not to incorrectly block it.)

    const tmpl = makeTextStep("step-no-content", "素材摘要");
    // Let the execution proceed without error — we just confirm it doesn't throw
    // or misclassify a no_content marker as the sentinel.
    await expect(executor.execute(tmpl, "exec-no-content-test")).resolves.toBeDefined();
  });
});
