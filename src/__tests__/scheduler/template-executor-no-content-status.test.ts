/**
 * Task 2-tests: Unit tests for `no_content` step-status assignment after nudge retry.
 *
 * When a nudge retry's task produces only a {status:"no_content"} JSON artifact marker,
 * the executor must record step.status = "no_content" (not "completed").
 * Distinct from "failed" (crash/timeout) and from "completed" (real content delivered).
 *
 * Pattern: mirrors template-executor-length-retry.test.ts harness with vi.hoisted()
 * for mock functions. Tests call executor.execute() which internally calls dispatchNudge.
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
const testRuntimeRoot = mkdtempSync(tmpdir() + sep + "adam-no-content-retry-test-");

// ---------------------------------------------------------------------------
// Shared mock state (hoisted so vi.mock factories can close over them)
// ---------------------------------------------------------------------------

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
    passed: true, failed: false, verifierTaskId: "verifier-ok",
    identityCoherent: true, upstreamGrounded: true, confidence: 0.95, issues: [],
  }),
);
const _mockGetArtifact = vi.hoisted(() => vi.fn().mockReturnValue(undefined));
const _mockCreateArtifact = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Mocks (module-level)
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
  getTask: vi.fn((id: string) => ({
    id,
    status: "completed" as const,
    result: "mock reply",
    config: {},
    createdAt: Date.now(),
    completedAt: Date.now(),
  })),
}));

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

import { TemplateExecutor } from "../../scheduler/template-executor.js";

function seedRole(): void {
  createRole({
    id: "role-no-content-test",
    name: "role-no-content-test",
    cagPrompt: "test",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "ms-no-content-test",
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  });
}

function makeFileTemplate(stepId: string, outputAs: string): TaskTemplate {
  // A plain file-deliverable step (no outputChannel:"reply") so the nudge path is reachable.
  const tmpl: TaskTemplate = {
    id: "tmpl-no-content-test",
    name: "no-content-retry-test",
    trigger: { type: "manual" },
    steps: [{
      id: stepId,
      prompt: "Produce an mp3 audio file.",
      outputAs,
      // Binary (file) deliverable → presence-gate / nudge path is reachable. Text
      // deliverables are captured from the step response and never reach the nudge.
      outputContract: { contractRules: [{ kind: "fileSizeBytes", min: 1 }] },
      roleId: "role-no-content-test",
    }],
    enabled: true,
    createdAt: Date.now(),
  };
  createTaskTemplate(tmpl);
  return tmpl;
}

// ---------------------------------------------------------------------------
// Test cases (plan Task 2-tests)
// ---------------------------------------------------------------------------

describe("nudge retry step status — no_content artifact detection", () => {
  let executor: TemplateExecutor;

  beforeEach(() => {
    clearTestDb();
    _mockCreateTaskWithAdmission.mockClear();
    _mockWaitForTaskCompletion.mockClear();
    _mockGetArtifact.mockClear();
    _mockRunLayerA.mockClear();
    _mockRunLayerB.mockClear();
    process.env.ADAM_TEST_DIR = testRuntimeRoot;
    executor = new TemplateExecutor({ maxRetries: 1, baseDelayMs: 10 });
    seedRole();
    // Default: task completes, Layer A+B pass
    _mockCreateTaskWithAdmission.mockResolvedValue({ ok: true, taskId: "task-done", reason: "" });
    _mockWaitForTaskCompletion.mockResolvedValue("completed" as const);
    _mockRunLayerA.mockReturnValue({ passed: true, violations: [] });
    _mockRunLayerB.mockResolvedValue({
      passed: true, failed: false, verifierTaskId: "verifier-ok",
      identityCoherent: true, upstreamGrounded: true, confidence: 0.95, issues: [],
    });
    _mockGetArtifact.mockReturnValue(undefined);
  });

  /**
   * Regression case: nudge retry succeeds with a real kind=file artifact → step status "completed".
   * Pre-impl: this should already pass.
   */
  it("sets step.status='completed' when nudge retry produces a real kind=file artifact (regression)", async () => {
    const tmpl = makeFileTemplate("step-good", "audio-files");

    // First call to getArtifact (artifactAlreadyPublished check) → undefined → nudge fires
    // Second call to getArtifact (nudge post-dispatch lookup) → real file artifact
    _mockGetArtifact
      .mockReturnValueOnce(undefined)                          // artifactAlreadyPublished = false → nudge
      .mockReturnValueOnce({
        id: "art-good",
        sourceKind: "template_step" as const,
        executionId: "exec-good",
        stepId: "step-good",
        key: "audio-files",
        kind: "file" as const,
        value: undefined,
        blobPath: "/tmp/podcast.mp3",
        sizeBytes: 1024,
        createdAt: Date.now(),
        roleId: "role-no-content-test",
      });

    // Two dispatches: original + nudge retry
    _mockCreateTaskWithAdmission
      .mockResolvedValueOnce({ ok: true, taskId: "task-original", reason: "" })
      .mockResolvedValueOnce({ ok: true, taskId: "task-nudge", reason: "" });

    const result = await executor.execute(tmpl, "exec-no-content-good");

    // Nudge fired (see "Nudge dispatch: prior attempt missed artifact" log line),
    // but the nudge succeeded via the reply-channel auto-publish path (finalTask.result
    // auto-published as artifact at line 935), so no second dispatch is needed.
    // Step status should be "completed" (real file artifact delivered).
    expect(result.stepResults.get("step-good")?.status).toBe("completed");
  });

  /**
   * Core case: nudge succeeds but the published artifact is a no_content JSON marker.
   *
   * After Task 2-impl, the executor detects the marker and sets:
   *   stepStatuses['step-jay'].status = "no_content"
   *   stepStatuses['step-jay'].noContentReason = "quota exceeded before any files written"
   *
   * Pre-impl: executor sees nudgeArtifact is truthy, marks "completed".
   * This test FAILS until Task 2-impl lands.
   *
   * getArtifact call sequence in nudge path (template-executor.ts:887-980):
   *  1. artifactAlreadyPublished check at line 887 → undefined → nudge fires
   *  2. line 926 re-read after reply-channel check → still undefined
   *  3. nudge post-dispatch lookup at line 953 → return no_content artifact
   */
  it("sets step.status='no_content' when nudge retry produces only a {status:'no_content'} artifact marker", async () => {
    const tmpl = makeFileTemplate("step-jay", "audio-files");

    // getArtifact returns: undefined → nudge fires → no_content artifact
    _mockGetArtifact
      .mockReturnValueOnce(undefined)                          // artifactAlreadyPublished check
      .mockReturnValueOnce(undefined)                          // re-check after reply-channel bypass
      .mockReturnValueOnce({                                  // nudge post-dispatch lookup
        id: "art-nocontent",
        sourceKind: "template_step" as const,
        executionId: "exec-nocontent",
        stepId: "step-jay",
        key: "audio-files",
        kind: "json" as const,
        value: { status: "no_content", reason: "quota exceeded before any files written" },
        blobPath: undefined,
        sizeBytes: 0,
        createdAt: Date.now(),
        roleId: "role-no-content-test",
      });

    // Two dispatches: original + nudge retry
    _mockCreateTaskWithAdmission
      .mockResolvedValueOnce({ ok: true, taskId: "task-original", reason: "" })
      .mockResolvedValueOnce({ ok: true, taskId: "task-nudge", reason: "" });

    const result = await executor.execute(tmpl, "exec-no-content-test");

    // After Task 2-impl: nudge succeeded but artifact is no_content → status = "no_content"
    // Pre-impl: executor marks "completed" → assertion FAILS until Task 2-impl lands
    expect(result.stepResults.get("step-jay")?.status).toBe("no_content");
  });

  /**
   * Secondary case: nudge retry completes but no artifact exists at all (nudge also missed).
   * This path goes through the else branch at line 978 — status should be "failed".
   */
  it("sets step.status='failed' when nudge retry also misses artifact (no artifact published at all)", async () => {
    const tmpl = makeFileTemplate("step-missed", "audio-files");

    // getArtifact: all calls return undefined → no_content detection never triggers
    _mockGetArtifact.mockReturnValue(undefined);

    // Two dispatches: original + nudge retry
    _mockCreateTaskWithAdmission
      .mockResolvedValueOnce({ ok: true, taskId: "task-orig", reason: "" })
      .mockResolvedValueOnce({ ok: true, taskId: "task-nudge-missed", reason: "" });

    const result = await executor.execute(tmpl, "exec-nudge-missed");

    // Nudge fired but artifact still missing → status should be "failed"
    expect(result.stepResults.get("step-missed")?.status).toBe("failed");
  });
});

afterAll(() => {
  rmSync(testRuntimeRoot, { recursive: true, force: true });
  cleanup();
});
