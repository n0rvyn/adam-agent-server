/**
 * Task 1-tests: N-of-M dependency semantics.
 *
 * Tests `shouldSkip(step, context)` behavior:
 * - Without minDependencies: strict-AND (any failed/skipped dep → skip)
 * - With minDependencies=N: skip only if fewer than N deps succeeded
 * - no_content always gates downstream (DP-002 Chosen A)
 * - cancelled always gates downstream (DP-002 strict-AND)
 *
 * Pre-impl: shouldSkip uses `.some()` — returns true on first failed dep.
 * Post-impl: shouldSkip counts successes vs threshold.
 *
 * Cases 1 PASSES pre-impl (preserves current behavior).
 * Cases 2-6 FAIL pre-impl.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { createRole } from "../../store/roles.js";
import type { TaskStep, StepResult } from "../../shared/types.js";

const { cleanup } = setupTestDb();
const testRuntimeRoot = mkdtempSync(tmpdir() + sep + "adam-min-dep-test-");

// ---------------------------------------------------------------------------
// Shared mock state
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
  getArtifact: vi.fn(() => undefined),
  createArtifact: vi.fn(),
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

interface ShouldSkipContext {
  failedStepIds: Set<string>;
  stepResults: Map<string, StepResult>;
}

function seedRole(): void {
  createRole({
    id: "role-min-dep-test",
    name: "role-min-dep-test",
    cagPrompt: "test",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "ms-min-dep-test",
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  });
}

/**
 * Probe shouldSkip by casting the executor to expose the private method.
 */
function probeShouldSkip(
  executor: TemplateExecutor,
  step: TaskStep,
  context: ShouldSkipContext,
): boolean {
  const shouldSkip = (executor as unknown as {
    shouldSkip: (step: TaskStep, context: ShouldSkipContext) => boolean;
  }).shouldSkip;
  return shouldSkip.call(executor, step, context);
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe("shouldSkip — N-of-M dependency semantics", () => {
  let executor: TemplateExecutor;

  beforeEach(() => {
    clearTestDb();
    _mockCreateTaskWithAdmission.mockClear();
    _mockWaitForTaskCompletion.mockClear();
    _mockRunLayerA.mockClear();
    _mockRunLayerB.mockClear();
    process.env.ADAM_TEST_DIR = testRuntimeRoot;
    executor = new TemplateExecutor({ maxRetries: 0, baseDelayMs: 10 });
    seedRole();
  });

  /**
   * Case 1 — PASSES pre-impl: strict-AND without minDependencies.
   * dependsOn=[A,B,C], no minDependencies, B failed → skip.
   */
  it("(case 1) no minDependencies + one failed dep → skip (strict-AND preserved)", () => {
    const step: TaskStep = {
      id: "step-X",
      prompt: "test",
      dependsOn: ["dep-A", "dep-B", "dep-C"],
    };
    const context: ShouldSkipContext = {
      failedStepIds: new Set(["dep-B"]),
      stepResults: new Map(),
    };
    // Should return true — strict-AND means any single failure gates downstream
    expect(probeShouldSkip(executor, step, context)).toBe(true);
  });

  /**
   * Case 2 — FAILS pre-impl: minDependencies=2, only B failed (2 of 3 succeed).
   * Expected: shouldSkip = false (above threshold).
   * Pre-impl: `.some()` returns true on B → shouldSkip = true → FAILS.
   */
  it("(case 2) minDependencies=2 + only one dep failed → run (2 of 3 succeeded)", () => {
    const step: TaskStep = {
      id: "step-X",
      prompt: "test",
      dependsOn: ["dep-A", "dep-B", "dep-C"],
      minDependencies: 2,
    };
    const context: ShouldSkipContext = {
      failedStepIds: new Set(["dep-B"]),
      stepResults: new Map([
        ["dep-A", { status: "completed", consumed: {}, stepId: "dep-A", taskId: "dep-A" }],
        // dep-B is in failedStepIds
        ["dep-C", { status: "completed", consumed: {}, stepId: "dep-C", taskId: "dep-C" }],
      ]),
    };
    // 2 of 3 succeeded >= minDependencies=2 → should NOT skip
    expect(probeShouldSkip(executor, step, context)).toBe(false);
  });

  /**
   * Case 3 — FAILS pre-impl: minDependencies=2, B and C failed (only 1 of 3 succeeds).
   * Expected: shouldSkip = true (below threshold).
   * Pre-impl: `.some()` returns true → shouldSkip = true → passes but for wrong reason.
   */
  it("(case 3) minDependencies=2 + two deps failed → skip (only 1 of 3 succeeded)", () => {
    const step: TaskStep = {
      id: "step-X",
      prompt: "test",
      dependsOn: ["dep-A", "dep-B", "dep-C"],
      minDependencies: 2,
    };
    const context: ShouldSkipContext = {
      failedStepIds: new Set(["dep-B", "dep-C"]),
      stepResults: new Map([
        ["dep-A", { status: "completed", consumed: {}, stepId: "dep-A", taskId: "dep-A" }],
      ]),
    };
    // 1 of 3 succeeded < minDependencies=2 → skip
    expect(probeShouldSkip(executor, step, context)).toBe(true);
  });

  /**
   * Case 4 — FAILS pre-impl: minDependencies=1, all three deps failed (0 succeed).
   * Expected: shouldSkip = true (0 < 1).
   * Pre-impl: `.some()` returns true → shouldSkip = true → passes but for wrong reason.
   */
  it("(case 4) minDependencies=1 + all deps failed → skip (0 of 3 succeeded)", () => {
    const step: TaskStep = {
      id: "step-X",
      prompt: "test",
      dependsOn: ["dep-A", "dep-B", "dep-C"],
      minDependencies: 1,
    };
    const context: ShouldSkipContext = {
      failedStepIds: new Set(["dep-A", "dep-B", "dep-C"]),
      stepResults: new Map(),
    };
    // 0 of 3 succeeded < minDependencies=1 → skip
    expect(probeShouldSkip(executor, step, context)).toBe(true);
  });

  /**
   * Case 5 — FAILS pre-impl: no minDependencies, dep has no_content status (DP-002 A).
   * Expected: shouldSkip = true (no_content always gates).
   * Pre-impl: only checks failedStepIds + skipped → no_content not gated → returns false → FAILS.
   */
  it("(case 5) no minDependencies + dep has no_content status → skip (DP-002 gating)", () => {
    const step: TaskStep = {
      id: "step-X",
      prompt: "test",
      dependsOn: ["dep-A"],
    };
    const context: ShouldSkipContext = {
      failedStepIds: new Set(),
      stepResults: new Map([
        ["dep-A", { status: "no_content", consumed: {}, stepId: "dep-A", taskId: "dep-A" }],
      ]),
    };
    // no_content always gates downstream regardless of mode
    expect(probeShouldSkip(executor, step, context)).toBe(true);
  });

  /**
   * Case 6 — FAILS pre-impl: no minDependencies, dep has cancelled status.
   * Expected: shouldSkip = true (cancelled always gates in strict-AND mode).
   * Pre-impl: only checks failedStepIds + skipped → cancelled not gated → returns false → FAILS.
   */
  it("(case 6) no minDependencies + dep has cancelled status → skip (cancelled gates)", () => {
    const step: TaskStep = {
      id: "step-X",
      prompt: "test",
      dependsOn: ["dep-A"],
    };
    const context: ShouldSkipContext = {
      failedStepIds: new Set(),
      stepResults: new Map([
        ["dep-A", { status: "cancelled", consumed: {}, stepId: "dep-A", taskId: "dep-A" }],
      ]),
    };
    // cancelled deps always gate downstream in strict-AND mode
    expect(probeShouldSkip(executor, step, context)).toBe(true);
  });
});

afterAll(() => {
  rmSync(testRuntimeRoot, { recursive: true, force: true });
  cleanup();
});
