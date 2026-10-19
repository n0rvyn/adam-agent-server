/**
 * Task 3-tests: Corrective nudge re-injects upstream artifacts.
 *
 * When a step fails to publish its outputAs artifact, dispatchNudge builds a prompt
 * to re-run the step. Before Task 3-impl, buildNudgePrompt only includes the file list
 * from getTaskFiles + Option A/B instructions — the role gets no upstream artifact content.
 * After Task 3-impl, the nudge prompt includes upstream artifact bodies (draft content,
 * critique JSON) so the role can actually re-do the work fresh (instead of being forced
 * into Option B no_content when the original task wrote zero files).
 *
 * This test file verifies that the nudge prompt contains upstream artifact content
 * AND that corrective framing appears BEFORE the artifact block (DP-003 Chosen B).
 *
 * Expected: FAILS before Task 3-impl (prompt has no upstream content).
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import type { TaskStep } from "../../shared/types.js";

const { cleanup } = setupTestDb();
const testRuntimeRoot = mkdtempSync(tmpdir() + sep + "adam-nudge-reinject-test-");

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

// Artifact store: mutable array seeded per-test, read by listArtifactsByExecution mock
const _artifactRows = vi.hoisted<Array<{
  id: string; sourceKind: "template_step"; executionId: string; stepId: string;
  key: string; kind: "file" | "json"; value?: unknown; blobPath?: string;
  sizeBytes: number; createdAt: number; roleId: string;
}>>(() => []);

let _testArtifactRows: typeof _artifactRows = [];

// Task-files store: mutable array seeded per-test, read by getTaskFiles mock
const _taskFileRows = vi.hoisted<Array<{
  taskId: string; path: string; op: "created" | "modified"; size_bytes: number;
}>>(() => []);

let _testTaskFileRows: typeof _taskFileRows = [];

// Captured prompt from createTaskWithAdmission
const _capturedPrompts = vi.hoisted<Array<{ prompt: string }>>(() => []);

const _mockCreateTaskWithAdmission = vi.hoisted(() =>
  vi.fn().mockImplementation(async (opts: { prompt?: string; [key: string]: unknown }) => {
    _capturedPrompts.push({ prompt: opts.prompt ?? "" });
    return { ok: true, taskId: "nudge-task-1", reason: "" };
  }),
);
const _mockWaitForTaskCompletion = vi.hoisted(() =>
  vi.fn().mockResolvedValue("completed" as const),
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
  ensureRoleWorkspace: vi.fn(() => `${testRuntimeRoot}/roles/test`),
  getRoleWorkspacePath: vi.fn(() => `${testRuntimeRoot}/roles/test`),
  writeRoleCLAUDEmd: vi.fn(),
  syncRoleSettings: vi.fn(),
}));

vi.mock("../../store/artifacts.js", () => ({
  getArtifact: vi.fn().mockReturnValue(undefined),
  listArtifactsByExecution: vi.fn().mockImplementation(() => _testArtifactRows),
  createArtifact: vi.fn(),
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
  runLayerA: vi.fn().mockReturnValue({ passed: true, violations: [] }),
  runLayerB: vi.fn().mockResolvedValue({
    passed: true, failed: false, verifierTaskId: null,
    identityCoherent: true, upstreamGrounded: true, confidence: 0.95, issues: [],
  }),
}));

vi.mock("../../store/audit-violations.js", () => ({
  recordAuditViolation: vi.fn(),
}));

vi.mock("../../store/tasks.js", () => ({
  getTask: vi.fn().mockReturnValue({ id: "prior-task-1", status: "completed", result: "", config: {} }),
  createTask: vi.fn().mockReturnValue({ id: "nudge-task-1" }),
  updateTask: vi.fn(),
}));

vi.mock("../../store/task-files.js", () => ({
  getTaskFiles: vi.fn().mockImplementation((taskId: string) =>
    _testTaskFileRows.filter((r) => r.taskId === taskId),
  ),
}));

vi.mock("../../lib/delivery-completeness.js", () => ({
  checkDeliveryCompleteness: vi.fn().mockReturnValue({ complete: true, missingKeys: [] }),
}));

// Intercept readFileSync for blob paths — vi.hoisted so vi.mock can reference it at top level.
// Must be vi.fn() to support mockImplementation in beforeEach.
const _readFileSyncBody = vi.hoisted(
  () => {
    const fn = vi.fn((path: string) => {
      if (typeof path !== "string") return "";
      if (path.includes("草稿-B")) return "MARKER_DRAFT_B_CONTENT_LOREM_IPSUM";
      if (path.includes("草稿-A")) return "MARKER_DRAFT_A_CONTENT";
      if (path.includes("critique-B")) return JSON.stringify({ theses: ["test thesis"] });
      if (path.includes("终稿-A")) return "MARKER_FINAL_A_CONTENT";
      return `content-of-${path}`;
    });
    return fn;
  },
);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readFileSync: _readFileSyncBody,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

afterAll(() => {
  cleanup();
  try { rmSync(testRuntimeRoot, { recursive: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Test: nudge prompt re-injects upstream artifact content
// ---------------------------------------------------------------------------

describe("dispatchNudge — upstream artifact re-injection", () => {
  beforeEach(() => {
    clearTestDb();
    vi.clearAllMocks();
    _testArtifactRows = [];
    _testTaskFileRows = [];
    _capturedPrompts.length = 0;
    process.env.ADAM_TEST_DIR = testRuntimeRoot;

    // Default: readFileSync returns marker content for known blob paths
    _readFileSyncBody.mockImplementation((path: string) => {
      if (typeof path !== "string") return "";
      if (path.includes("草稿-B")) return "MARKER_DRAFT_B_CONTENT_LOREM_IPSUM";
      if (path.includes("草稿-A")) return "MARKER_DRAFT_A_CONTENT";
      if (path.includes("critique-B")) return JSON.stringify({ theses: ["test thesis"] });
      if (path.includes("终稿-A")) return "MARKER_FINAL_A_CONTENT";
      return `content-of-${path}`;
    });
  });

  it("prompt contains upstream draft content from a file artifact", async () => {
    // Seed 写稿B's draft artifact (file kind)
    _testArtifactRows.push({
      id: "art-draft-b", sourceKind: "template_step", executionId: "exec-1",
      stepId: "写稿B", key: "草稿-B", kind: "file",
      blobPath: "/tmp/草稿-B.md", sizeBytes: 40, createdAt: Date.now(), roleId: "role-test",
    });
    // Seed 批判B's critique artifact (json kind)
    _testArtifactRows.push({
      id: "art-critique-b", sourceKind: "template_step", executionId: "exec-1",
      stepId: "批判B", key: "critique-B", kind: "json",
      value: { theses: ["test thesis"] }, sizeBytes: 30, createdAt: Date.now(), roleId: "role-test",
    });
    // Seed prior nudge task files (empty — original task wrote nothing useful)
    _testTaskFileRows.push(
      { taskId: "prior-task-1", path: "/tmp/roles/test/garbage.log", op: "created", size_bytes: 12 },
    );

    // Dynamically import TemplateExecutor to get the class after mocks are set up
    const { TemplateExecutor } = await import("../../scheduler/template-executor.js");
    const executor = new TemplateExecutor({ maxRetries: 1, baseDelayMs: 10 });

    const step: TaskStep = {
      id: "润色B",
      prompt: "Polish draft B",
      outputAs: "终稿-B",
      dependsOn: ["写稿B", "批判B"],
      roleId: "role-test",
    };

    // Cast to call the private method
    const dispatchNudge = (executor as unknown as {
      dispatchNudge: (
        context: {
          executionId: string; templateId: string; config: Record<string, unknown>;
          stepResults: Map<string, unknown>; failedStepIds: Set<string>;
          rolePreference: string; deliverTo?: unknown[]; stepStatuses: Record<string, unknown>;
        },
        step: TaskStep,
        priorTaskId: string,
        roleId: string,
        timeoutMs: number,
      ) => Promise<{ taskId: string; status: string }>;
    }).dispatchNudge;

    await dispatchNudge(
      {
        executionId: "exec-1",
        templateId: "tmpl-1",
        config: {},
        stepResults: new Map(),
        failedStepIds: new Set(),
        rolePreference: "role-test",
        stepStatuses: {},
      },
      step,
      "prior-task-1",
      "role-test",
      600_000,
    );

    // The nudge prompt must contain upstream draft content (from the file blob)
    expect(_capturedPrompts.length).toBeGreaterThan(0);
    const prompt = _capturedPrompts[0].prompt;
    expect(prompt).toContain("MARKER_DRAFT_B_CONTENT_LOREM_IPSUM");
  });

  it("prompt contains upstream critique JSON content", async () => {
    _testArtifactRows.push({
      id: "art-draft-b", sourceKind: "template_step", executionId: "exec-1",
      stepId: "写稿B", key: "草稿-B", kind: "file",
      blobPath: "/tmp/草稿-B.md", sizeBytes: 40, createdAt: Date.now(), roleId: "role-test",
    });
    _testArtifactRows.push({
      id: "art-critique-b", sourceKind: "template_step", executionId: "exec-1",
      stepId: "批判B", key: "critique-B", kind: "json",
      value: { theses: ["test thesis"] }, sizeBytes: 30, createdAt: Date.now(), roleId: "role-test",
    });

    const { TemplateExecutor } = await import("../../scheduler/template-executor.js");
    const executor = new TemplateExecutor({ maxRetries: 1, baseDelayMs: 10 });

    const step: TaskStep = {
      id: "润色B",
      prompt: "Polish draft B",
      outputAs: "终稿-B",
      dependsOn: ["写稿B", "批判B"],
      roleId: "role-test",
    };

    const dispatchNudge = (executor as unknown as {
      dispatchNudge: (
        context: {
          executionId: string; templateId: string; config: Record<string, unknown>;
          stepResults: Map<string, unknown>; failedStepIds: Set<string>;
          rolePreference: string; deliverTo?: unknown[]; stepStatuses: Record<string, unknown>;
        },
        step: TaskStep,
        priorTaskId: string,
        roleId: string,
        timeoutMs: number,
      ) => Promise<{ taskId: string; status: string }>;
    }).dispatchNudge;

    await dispatchNudge(
      {
        executionId: "exec-1",
        templateId: "tmpl-1",
        config: {},
        stepResults: new Map(),
        failedStepIds: new Set(),
        rolePreference: "role-test",
        stepStatuses: {},
      },
      step,
      "prior-task-1",
      "role-test",
      600_000,
    );

    expect(_capturedPrompts.length).toBeGreaterThan(0);
    const prompt = _capturedPrompts[0].prompt;
    // The JSON artifact content should appear as a serialized block
    expect(prompt).toContain("test thesis");
  });

  it("nudge framing appears BEFORE upstream artifact content (DP-003 Chosen B)", async () => {
    _testArtifactRows.push({
      id: "art-draft-b", sourceKind: "template_step", executionId: "exec-1",
      stepId: "写稿B", key: "草稿-B", kind: "file",
      blobPath: "/tmp/草稿-B.md", sizeBytes: 40, createdAt: Date.now(), roleId: "role-test",
    });
    _testTaskFileRows.push(
      { taskId: "prior-task-1", path: "/tmp/roles/test/garbage.log", op: "created", size_bytes: 12 },
    );

    const { TemplateExecutor } = await import("../../scheduler/template-executor.js");
    const executor = new TemplateExecutor({ maxRetries: 1, baseDelayMs: 10 });

    const step: TaskStep = {
      id: "润色B",
      prompt: "Polish draft B",
      outputAs: "终稿-B",
      dependsOn: ["写稿B"],
      roleId: "role-test",
    };

    const dispatchNudge = (executor as unknown as {
      dispatchNudge: (
        context: {
          executionId: string; templateId: string; config: Record<string, unknown>;
          stepResults: Map<string, unknown>; failedStepIds: Set<string>;
          rolePreference: string; deliverTo?: unknown[]; stepStatuses: Record<string, unknown>;
        },
        step: TaskStep,
        priorTaskId: string,
        roleId: string,
        timeoutMs: number,
      ) => Promise<{ taskId: string; status: string }>;
    }).dispatchNudge;

    await dispatchNudge(
      {
        executionId: "exec-1",
        templateId: "tmpl-1",
        config: {},
        stepResults: new Map(),
        failedStepIds: new Set(),
        rolePreference: "role-test",
        stepStatuses: {},
      },
      step,
      "prior-task-1",
      "role-test",
      600_000,
    );

    expect(_capturedPrompts.length).toBeGreaterThan(0);
    const prompt = _capturedPrompts[0].prompt;

    // Both strings must appear
    expect(prompt).toContain("MARKER_DRAFT_B_CONTENT_LOREM_IPSUM");
    expect(prompt).toContain("Corrective Step");

    // Framing appears FIRST (DP-003 Chosen B)
    const framingIndex = prompt.indexOf("Corrective Step");
    const artifactIndex = prompt.indexOf("MARKER_DRAFT_B_CONTENT_LOREM_IPSUM");
    expect(framingIndex).toBeLessThan(artifactIndex);
  });
});
