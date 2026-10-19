/**
 * Task 3-tests: Unit tests for execution-level `partial` flip when any gap exists.
 *
 * The execution final-status predicate (template-executor.ts) consults:
 *   - any step with status "no_content"                     → partial
 *   - chokepoint `checkDeliveryCompleteness` reports gaps     → partial
 *
 * `checkDeliveryCompleteness` is contract-aware (stepRequiresFileArtifact): a step whose
 * contract declares file-on-disk rules (fileSizeBytes / audioDurationMs / non-json mime)
 * MUST publish a real file; a content step (format=json/markdown/text or no contract) is
 * satisfied by a file blob OR a structured JSON value. A {status:"no_content"} marker is
 * always a gap.
 *
 * Tests call executor.execute() which internally calls checkDeliveryCompleteness via
 * vi.hoisted() mocks.
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
const testRuntimeRoot = mkdtempSync(tmpdir() + sep + "adam-completeness-gate-test-");

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
// Shared mock state — mutable array so tests can push artifacts BEFORE calling execute().
// This prevents the nudge path from firing (executor finds artifacts immediately on first check).
// ---------------------------------------------------------------------------

const _artifactRows = vi.hoisted<Array<{
  id: string; sourceKind: "template_step"; executionId: string; stepId: string;
  key: string; kind: "file" | "json"; value?: unknown; blobPath?: string;
  sizeBytes: number; createdAt: number; roleId: string;
}>>(() => []);

// Per-test mutable snapshot (assigned at test start, referenced by _mockListArtifactsByExecution).
let _testArtifactRows: typeof _artifactRows = [];

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
  getArtifact: vi.fn((execId: string, stepId: string, key: string) =>
    _testArtifactRows.find((a) => a.executionId === execId && a.stepId === stepId && a.key === key),
  ),
  createArtifact: vi.fn((row: typeof _testArtifactRows[number]) => {
    _artifactRows.push(row);
  }),
  listArtifactsByExecution: (..._args: unknown[]) => _testArtifactRows,
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
    id: "role-gate-test",
    name: "role-gate-test",
    cagPrompt: "test",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "ms-gate-test",
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  });
}

/**
 * Two-step template mirroring the morning podcast:
 *   定稿 (draft) — outputAs="draft-output", text/markdown deliverable
 *   jay (audio)  — outputAs="audio-files", file-deliverable; its contract declares a
 *                  Track-B fileSizeBytes rule, so stepRequiresFileArtifact(jay)=true and
 *                  a kind="json" value does NOT satisfy completeness (must be a real file).
 */
function makePodcastTemplate(): TaskTemplate {
  const tmpl: TaskTemplate = {
    id: "tmpl-gate-test",
    name: "gate-test-podcast",
    trigger: { type: "manual" },
    steps: [
      {
        id: "定稿",
        prompt: "Write the podcast draft.",
        outputAs: "draft-output",
        roleId: "role-gate-test",
      },
      {
        id: "jay",
        prompt: "Produce an mp3 audio file.",
        outputAs: "audio-files",
        roleId: "role-gate-test",
        outputContract: { contractRules: [{ kind: "fileSizeBytes", min: 1000 }] },
      },
    ],
    enabled: true,
    createdAt: Date.now(),
  };
  createTaskTemplate(tmpl);
  return tmpl;
}

/**
 * Two-step template exercising a structured-JSON deliverable (format=json contract):
 *   draft   — outputAs="draft-output", text/markdown deliverable
 *   scoring — outputAs="score", format=json contract; stepRequiresFileArtifact=false,
 *             so a kind="json" value is a first-class deliverable and counts as complete.
 */
function makeJsonDeliverableTemplate(): TaskTemplate {
  const tmpl: TaskTemplate = {
    id: "tmpl-gate-json",
    name: "gate-test-json",
    trigger: { type: "manual" },
    steps: [
      {
        id: "draft",
        prompt: "Write the draft.",
        outputAs: "draft-output",
        roleId: "role-gate-test",
      },
      {
        id: "scoring",
        prompt: "Emit a structured scoring JSON.",
        outputAs: "score",
        roleId: "role-gate-test",
        outputContract: { contractRules: [{ kind: "format", value: "json" }] },
      },
    ],
    enabled: true,
    createdAt: Date.now(),
  };
  createTaskTemplate(tmpl);
  return tmpl;
}

// ---------------------------------------------------------------------------
// Test cases (plan Task 3-tests)
// ---------------------------------------------------------------------------

describe("execution-level completeness gate — partial flip", () => {
  let executor: TemplateExecutor;

  beforeEach(() => {
    clearTestDb();
    _mockCreateTaskWithAdmission.mockClear();
    _mockWaitForTaskCompletion.mockClear();
    _mockRunLayerA.mockClear();
    _mockRunLayerB.mockClear();
    _testArtifactRows = _artifactRows;  // reset shared mutable array
    _artifactRows.length = 0;           // clear from previous test
    process.env.ADAM_TEST_DIR = testRuntimeRoot;
    executor = new TemplateExecutor({ maxRetries: 0, baseDelayMs: 10 });
    seedRole();
    _mockCreateTaskWithAdmission.mockResolvedValue({ ok: true, taskId: "task-done", reason: "" });
    _mockWaitForTaskCompletion.mockResolvedValue("completed" as const);
    _mockRunLayerA.mockReturnValue({ passed: true, violations: [] });
    _mockRunLayerB.mockResolvedValue({
      passed: true, failed: false, verifierTaskId: "verifier-ok",
      identityCoherent: true, upstreamGrounded: true, confidence: 0.95, issues: [],
    });
  });

  /**
   * (a) Complete execution: both steps produce real file artifacts.
   * After Task 3-impl, execution status should be "completed".
   * This is the regression shield: existing behavior must not change.
   */
  it("(a) all steps have real file artifacts → execution status 'completed' (regression)", async () => {
    const tmpl = makePodcastTemplate();

    // Populate artifacts BEFORE execute() — this prevents the nudge path from firing.
    // The executor checks for artifacts on its first call; finding them means the
    // step is considered "already published" and skips the nudge dispatch.
    _artifactRows.push(
      {
        id: "art-draft",
        sourceKind: "template_step" as const,
        executionId: "exec-complete",
        stepId: "定稿",
        key: "draft-output",
        kind: "file" as const,
        value: undefined,
        blobPath: "/tmp/draft.md",
        sizeBytes: 512,
        createdAt: Date.now(),
        roleId: "role-gate-test",
      },
      {
        id: "art-mp3",
        sourceKind: "template_step" as const,
        executionId: "exec-complete",
        stepId: "jay",
        key: "audio-files",
        kind: "file" as const,
        value: undefined,
        blobPath: "/tmp/podcast.mp3",
        sizeBytes: 2048,
        createdAt: Date.now(),
        roleId: "role-gate-test",
      },
    );

    const result = await executor.execute(tmpl, "exec-complete");

    expect(result.status).toBe("completed");
  });

  /**
   * (b) jay step's artifact is a {status:"no_content"} JSON marker.
   * After Tasks 2-impl, step result status = "no_content".
   * After Task 3-impl, execution status must be "partial" (not "completed").
   * Pre-impl: only checks failedStepIds | hasSkipped → status = "completed" → FAILS.
   */
  it("(b) jay step artifact is no_content marker → execution status 'partial'", async () => {
    const tmpl = makePodcastTemplate();

    _artifactRows.push(
      {
        id: "art-draft-ok",
        sourceKind: "template_step" as const,
        executionId: "exec-nocontent",
        stepId: "定稿",
        key: "draft-output",
        kind: "file" as const,
        value: undefined,
        blobPath: "/tmp/draft.md",
        sizeBytes: 512,
        createdAt: Date.now(),
        roleId: "role-gate-test",
      },
      {
        id: "art-nocontent",
        sourceKind: "template_step" as const,
        executionId: "exec-nocontent",
        stepId: "jay",
        key: "audio-files",
        kind: "json" as const,
        value: { status: "no_content", reason: "quota exceeded before any files written" },
        blobPath: undefined,
        sizeBytes: 0,
        createdAt: Date.now(),
        roleId: "role-gate-test",
      },
    );

    const result = await executor.execute(tmpl, "exec-nocontent");

    // After Task 3-impl: hasNoContent = true OR completeness.complete = false → partial
    // Pre-impl: only failedStepIds | hasSkipped checked → returns "completed" → FAILS
    expect(result.status).toBe("partial");
  });

  /**
   * (c) jay step produced no artifact at all (missing gap).
   * With continueOnError=true, the nudge fails but the executor continues to finalize.
   * At finalize: hasFailures=true → partial. This validates that the completeness
   * gate at finalize is reached even when the step failure path was taken.
   */
  it("(c) jay step has no artifact + continueOnError → partial (hasFailures gate)", async () => {
    const tmpl: TaskTemplate = {
      ...makePodcastTemplate(),
      config: { ...makePodcastTemplate().config, continueOnError: true },
    };
    // Template must be re-seeded in DB since we modified steps
    getTestDb().prepare(`
      INSERT OR REPLACE INTO task_templates (
        id, name, description, trigger_type, trigger_cron, steps, config, enabled,
        created_at, is_preset, preset_id, deliver_to, report_to
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tmpl.id,
      tmpl.name,
      tmpl.description ?? null,
      tmpl.trigger.type,
      tmpl.trigger.cron ?? null,
      JSON.stringify(tmpl.steps),
      JSON.stringify(tmpl.config),
      tmpl.enabled ? 1 : 0,
      tmpl.createdAt ?? Date.now(),
      tmpl.isPreset ? 1 : 0,
      tmpl.presetId ?? null,
      tmpl.deliverTo ? JSON.stringify(tmpl.deliverTo) : null,
      tmpl.reportTo ? JSON.stringify(tmpl.reportTo) : null,
    );

    _artifactRows.push(
      {
        id: "art-draft-only",
        sourceKind: "template_step" as const,
        executionId: "exec-missing",
        stepId: "定稿",
        key: "draft-output",
        kind: "file" as const,
        value: undefined,
        blobPath: "/tmp/draft.md",
        sizeBytes: 512,
        createdAt: Date.now(),
        roleId: "role-gate-test",
      },
      // no artifact for jay/audio-files — nudge will fail, but continueOnError keeps execution alive
    );

    const result = await executor.execute(tmpl, "exec-missing");

    // hasFailures=true (nudge failed, artifact missing) → partial
    expect(result.status).toBe("partial");
  });

  /**
   * (d) jay declares a file contract (fileSizeBytes) but published a kind=json data
   * object instead of a real file. stepRequiresFileArtifact(jay)=true, so the JSON does
   * NOT satisfy completeness → gap → partial. This preserves the file guarantee for
   * audio/image/binary steps.
   */
  it("(d) file-contract step (jay) delivers kind=json non-no_content → execution status 'partial'", async () => {
    const tmpl = makePodcastTemplate();

    _artifactRows.push(
      {
        id: "art-draft-ok",
        sourceKind: "template_step" as const,
        executionId: "exec-json-gap",
        stepId: "定稿",
        key: "draft-output",
        kind: "file" as const,
        value: undefined,
        blobPath: "/tmp/draft.md",
        sizeBytes: 512,
        createdAt: Date.now(),
        roleId: "role-gate-test",
      },
      {
        id: "art-json-data",
        sourceKind: "template_step" as const,
        executionId: "exec-json-gap",
        stepId: "jay",
        key: "audio-files",
        kind: "json" as const,
        value: { someData: "not a no_content marker" },
        blobPath: undefined,
        sizeBytes: 32,
        createdAt: Date.now(),
        roleId: "role-gate-test",
      },
    );

    const result = await executor.execute(tmpl, "exec-json-gap");

    // file-contract step + kind=json → does not satisfy the file requirement → partial
    expect(result.status).toBe("partial");
  });

  /**
   * (e) A format=json step (stepRequiresFileArtifact=false) publishes a real structured
   * JSON value. This is a first-class deliverable — completeness must NOT flag it as a
   * gap. Regression guard for the general multi-step bug where structured-JSON handoff
   * steps (critique/scoring) forced a fully-successful execution to 'partial'.
   */
  it("(e) format=json step delivers kind=json non-no_content → execution status 'completed'", async () => {
    const tmpl = makeJsonDeliverableTemplate();

    _artifactRows.push(
      {
        id: "art-draft-json-ok",
        sourceKind: "template_step" as const,
        executionId: "exec-json-ok",
        stepId: "draft",
        key: "draft-output",
        kind: "file" as const,
        value: undefined,
        blobPath: "/tmp/draft.md",
        sizeBytes: 512,
        createdAt: Date.now(),
        roleId: "role-gate-test",
      },
      {
        id: "art-score-json",
        sourceKind: "template_step" as const,
        executionId: "exec-json-ok",
        stepId: "scoring",
        key: "score",
        kind: "json" as const,
        value: { scores: [{ candidate_id: "C", selected: true }], 推荐: "C" },
        blobPath: undefined,
        sizeBytes: 64,
        createdAt: Date.now(),
        roleId: "role-gate-test",
      },
    );

    const result = await executor.execute(tmpl, "exec-json-ok");

    // format=json deliverable is first-class → no gap → completed
    expect(result.status).toBe("completed");
  });
});

afterAll(() => {
  rmSync(testRuntimeRoot, { recursive: true, force: true });
  cleanup();
});
