/**
 * Task 8: Tests for step-output completion enforcement.
 *
 * Tests that when step declares outputAs but no artifact is published:
 * - Step status becomes "failed"
 * - An audit violation is recorded with layer="A" and a message containing the outputAs name
 * - Layer A is NOT re-run for the same missing-artifact (no duplicate audit_violations)
 *
 * Also verifies that legacy steps (no outputAs declared) remain unaffected.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
const testRuntimeRoot = mkdtempSync(tmpdir() + "/adam-step-output-enforcement-");

// Use container object so arrays can be reset in beforeEach (vi.hoisted returns const bindings)
const _testState = vi.hoisted(() => ({
  auditViolations: [] as unknown[],
  runLayerACalls: [] as unknown[],
}));

const _mockCreateTaskWithAdmission = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, taskId: "task-done", reason: "" }),
);
const _mockWaitForTaskCompletion = vi.hoisted(() =>
  vi.fn().mockResolvedValue("completed" as const),
);
const _mockGetTask = vi.hoisted(() =>
  vi.fn((id: string) => ({
    id,
    status: "completed" as const,
    result: "step result",
    config: {},
    createdAt: Date.now(),
    completedAt: Date.now(),
  })),
);
const _mockRecordAuditViolation = vi.hoisted(() =>
  vi.fn().mockImplementation((v: unknown) => { _testState.auditViolations.push(v); }),
);
const _mockRunLayerA = vi.hoisted(() =>
  vi.fn().mockReturnValue({ passed: true, violations: [] }),
);

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
  getArtifact: vi.fn().mockReturnValue(null), // Default: no artifact
  createArtifact: vi.fn(), // capture-primary path (text steps) calls this
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
  runLayerA: (...args: unknown[]) => { _testState.runLayerACalls.push(args); return _mockRunLayerA(...args); },
  runLayerB: vi.fn().mockResolvedValue({ passed: true, failed: false, verifierTaskId: null, identityCoherent: null, upstreamGrounded: null, confidence: null, issues: [], }),
}));

vi.mock("../../store/audit-violations.js", () => ({
  recordAuditViolation: (...args: unknown[]) => _mockRecordAuditViolation(...args),
}));

vi.mock("../../store/tasks.js", () => ({
  getTask: (id: string) => _mockGetTask(id),
  updateTaskConfig: vi.fn(),
}));

import { TemplateExecutor } from "../../scheduler/template-executor.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { createRole } from "../../store/roles.js";
import type { TaskTemplate } from "../../shared/types.js";
import { getArtifact } from "../../store/artifacts.js";

afterAll(() => {
  rmSync(testRuntimeRoot, { recursive: true, force: true });
  cleanup();
});

function seedRole(id: string): void {
  createRole({
    id, name: id, cagPrompt: "test",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `ms-${id}`,
    status: "active", preferences: {}, createdAt: Date.now(),
  });
}

describe("step-output completion enforcement", () => {
  let executor: TemplateExecutor;

  beforeEach(() => {
    clearTestDb();
    vi.clearAllMocks();
    process.env.ADAM_TEST_DIR = testRuntimeRoot;
    _testState.auditViolations = [];
    _testState.runLayerACalls = [];
    seedRole("role-enforcement-test");
    executor = new TemplateExecutor({ maxRetries: 1, baseDelayMs: 10 });
    _mockCreateTaskWithAdmission.mockResolvedValue({ ok: true, taskId: "task-done", reason: "" });
    _mockWaitForTaskCompletion.mockResolvedValue("completed" as const);
    _mockRunLayerA.mockReturnValue({ passed: true, violations: [] });
    // Default: no artifact
    vi.mocked(getArtifact).mockReturnValue(undefined);
  });

  // (a) step has outputAs, artifact published with matching key → step status=completed, no violation
  it("(a) artifact published with matching key → step status completed, no audit violation", async () => {
    const tmpl: TaskTemplate = {
      id: "tmpl-enf-a",
      name: "enforcement-a",
      trigger: { type: "manual" },
      steps: [{ id: "step-a", prompt: "Do something", outputAs: "result-file", roleId: "role-enforcement-test" }],
      enabled: true,
      createdAt: Date.now(),
    };
    createTaskTemplate(tmpl);

    const artA = {
      id: "art-a",
      sourceKind: "template_step" as const,
      roleId: "role-test",
      executionId: "exec-enf-a",
      stepId: "step-a",
      key: "result-file",
      kind: "file" as const,
      mime: "text/plain",
      sizeBytes: 100,
      createdAt: Date.now(),
    };
    // Fix A adds an artifactAlreadyPublished check (first call) before the inner nudge check
    // (second call). Both must return the artifact so the nudge block short-circuits correctly.
    vi.mocked(getArtifact).mockReturnValueOnce(artA).mockReturnValueOnce(artA);

    const result = await executor.execute(tmpl, "exec-enf-a");

    expect(result.stepResults.get("step-a")?.status).toBe("completed");
    expect(_mockRecordAuditViolation).not.toHaveBeenCalled();
  });

  it("(a2) collection manifest published under outputAs → step status completed", async () => {
    const tmpl: TaskTemplate = {
      id: "tmpl-enf-a2",
      name: "enforcement-a2",
      trigger: { type: "manual" },
      steps: [{ id: "step-a2", prompt: "Do something", outputAs: "artworks", roleId: "role-enforcement-test" }],
      enabled: true,
      createdAt: Date.now(),
    };
    createTaskTemplate(tmpl);

    const collectionArt = {
      id: "collection-art",
      sourceKind: "template_step" as const,
      roleId: "role-test",
      executionId: "exec-enf-a2",
      stepId: "step-a2",
      key: "artworks",
      kind: "json" as const,
      value: {
        type: "artifact_collection",
        outputAs: "artworks",
        items: [
          { artifactId: "child-1", key: "artwork_01.png", filename: "artwork_01.png", mime: "image/png", sizeBytes: 100 },
        ],
      },
      sizeBytes: 100,
      createdAt: Date.now(),
    };
    // Fix A adds an artifactAlreadyPublished check (first call) before the inner nudge check.
    vi.mocked(getArtifact).mockReturnValueOnce(collectionArt).mockReturnValueOnce(collectionArt);

    const result = await executor.execute(tmpl, "exec-enf-a2");

    expect(result.stepResults.get("step-a2")?.status).toBe("completed");
    expect(_mockRecordAuditViolation).not.toHaveBeenCalled();
  });

  // (b) step has outputAs, no artifact published → step status=failed, audit violation with layer="A"
  it("(b) no artifact published → step status failed, audit violation recorded", async () => {
    const tmpl: TaskTemplate = {
      id: "tmpl-enf-b",
      name: "enforcement-b",
      trigger: { type: "manual" },
      steps: [{
        id: "step-b",
        prompt: "Produce a report file",
        outputAs: "final-report",
        // Binary deliverable: presence gate / nudge applies (text deliverables are captured
        // from the response, so they never reach the missing-artifact fail path).
        outputContract: { contractRules: [{ kind: "fileSizeBytes", min: 1 }] },
        roleId: "role-enforcement-test",
      }],
      enabled: true,
      createdAt: Date.now(),
    };
    createTaskTemplate(tmpl);

    const result = await executor.execute(tmpl, "exec-enf-b");

    expect(result.stepResults.get("step-b")?.status).toBe("failed");
    expect(_mockRecordAuditViolation).toHaveBeenCalledTimes(1);
    expect(_mockRecordAuditViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "exec-enf-b",
        contractField: "outputAs",
        layer: "A",
        severity: "error",
        message: 'Step "step-b" declares outputAs="final-report" but no artifact was published with that key.',
      }),
    );
    expect(result.stepResults.get("step-b")?.error).toBe('Step "step-b" declares outputAs="final-report" but no artifact was published with that key.');
  });

  // (c) step has no outputAs, no artifact → step status=completed (legacy back-compat)
  it("(c) no outputAs declared, no artifact → step status completed (legacy back-compat)", async () => {
    const tmpl: TaskTemplate = {
      id: "tmpl-enf-c",
      name: "enforcement-c",
      trigger: { type: "manual" },
      steps: [{ id: "step-c", prompt: "Do legacy step", roleId: "role-enforcement-test" }],
      enabled: true,
      createdAt: Date.now(),
    };
    createTaskTemplate(tmpl);

    const result = await executor.execute(tmpl, "exec-enf-c");

    // Legacy step: no outputAs so the check is skipped → step completes normally
    expect(result.stepResults.get("step-c")?.status).toBe("completed");
    expect(_mockRecordAuditViolation).not.toHaveBeenCalled();
  });

  // (d) outputAs declared, no artifact published (getArtifact looks up by outputAs key,
  // which has no matching row) → enforcement fires
  // Note: getArtifact is keyed by (executionId, stepId, key). Since no artifact with
  // key="final-script" was published, getArtifact returns null → enforcement fires.
  it("(d) no artifact published under outputAs key → enforcement fires", async () => {
    const tmpl: TaskTemplate = {
      id: "tmpl-enf-d",
      name: "enforcement-d",
      trigger: { type: "manual" },
      steps: [{
        id: "step-d",
        prompt: "Produce a script file",
        outputAs: "final-script",
        // Binary deliverable so the presence gate still applies (see step-b note).
        outputContract: { contractRules: [{ kind: "fileSizeBytes", min: 1 }] },
        roleId: "role-enforcement-test",
      }],
      enabled: true,
      createdAt: Date.now(),
    };
    createTaskTemplate(tmpl);

    // getArtifact is called with key="final-script" but no such artifact exists
    // (mock already returns null by default) → enforcement fires
    const result = await executor.execute(tmpl, "exec-enf-d");

    expect(result.stepResults.get("step-d")?.status).toBe("failed");
    expect(_mockRecordAuditViolation).toHaveBeenCalledTimes(1);
    expect(_mockRecordAuditViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("final-script"),
      }),
    );
  });

  // (e) Exactly ONE audit_violations row when artifact missing (no duplicate from Layer A)
  it("(e) exactly one audit violation recorded when artifact missing (no duplicate from Layer A)", async () => {
    const tmpl: TaskTemplate = {
      id: "tmpl-enf-e",
      name: "enforcement-e",
      trigger: { type: "manual" },
      steps: [{
        id: "step-e",
        prompt: "Produce a content file",
        outputAs: "content-output",
        // Binary deliverable so the presence gate still applies (see step-b note).
        outputContract: { contractRules: [{ kind: "fileSizeBytes", min: 1 }] },
        roleId: "role-enforcement-test",
      }],
      enabled: true,
      createdAt: Date.now(),
    };
    createTaskTemplate(tmpl);

    const result = await executor.execute(tmpl, "exec-enf-e");

    expect(result.stepResults.get("step-e")?.status).toBe("failed");
    // Exactly 1 violation — from step-output check, NOT from Layer A's StepOutputMissingError catch
    expect(_mockRecordAuditViolation).toHaveBeenCalledTimes(1);
    expect(_mockRecordAuditViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        contractField: "outputAs",
        message: 'Step "step-e" declares outputAs="content-output" but no artifact was published with that key.',
      }),
    );
    // runLayerA should NOT be called — stepOutputCheckFailed=true prevents entry
    expect(_testState.runLayerACalls).toHaveLength(0);
  });

  // ===== Nudge race / race-rescue tests (Task 1-tests) =====

  it("nudge race: nudge task force-closed AFTER publishing artifact — step judged completed", async () => {
    // Test Case 1: initial task completes (no artifact), nudge is dispatched,
    // nudge's SDK wrapper reports "failed" (force-closed), but the artifact actually
    // landed in DB during the nudge. Step must be judged completed with retryReason="nudge".
    const tmpl: TaskTemplate = {
      id: "tmpl-nudge-race-1",
      name: "nudge-race-1",
      trigger: { type: "manual" },
      steps: [{ id: "step-nr1", prompt: "Produce audio", outputAs: "audio", outputContract: { contractRules: [{ kind: "fileSizeBytes", min: 1 }] }, roleId: "role-enforcement-test" }],
      enabled: true,
      createdAt: Date.now(),
    };
    createTaskTemplate(tmpl);

    // Initial task: completes (no artifact at start), nudge returns "failed" wrapper status
    _mockCreateTaskWithAdmission
      .mockResolvedValueOnce({ ok: true, taskId: "task-original-nr1", reason: "" })
      .mockResolvedValueOnce({ ok: true, taskId: "nudge-nr1", reason: "" });
    _mockWaitForTaskCompletion
      .mockResolvedValueOnce("completed" as const) // original task
      .mockResolvedValueOnce("failed" as const);   // nudge task force-closed

    // Artifact is pre-seeded (simulates publish_artifact_file landing before nudge times out)
    const seedArtifact = {
      id: "art-nr1",
      executionId: "exec-nudge-race-1",
      stepId: "step-nr1",
      key: "audio",
      kind: "file" as const,
      mime: "audio/mpeg",
      sizeBytes: 1024,
      createdAt: Date.now(),
    };
    // getArtifact call sequence:
    //   1st call (artifactAlreadyPublished check, Task 1-impl): artifact present → raceRescued if no nudge
    //   BUT in this test: initial lastStatus="completed" → enters nudge block at original code entry,
    //   inner getArtifact returns null (no artifact yet at inner check), nudge fires,
    //   then post-nudge getArtifact returns artifact.
    // After Task 1-impl fix: 1st call (artifactAlreadyPublished) returns null → raceRescued=false;
    //   2nd call (inner nudge block) returns null → nudge fires; 3rd call (post-nudge) returns artifact.
    vi.mocked(getArtifact)
      .mockReturnValueOnce(undefined) // artifactAlreadyPublished check: not yet present
      .mockReturnValueOnce(undefined) // inner nudge check: no artifact yet
      .mockReturnValueOnce(seedArtifact as any); // post-nudge: artifact landed

    const result = await executor.execute(tmpl, "exec-nudge-race-1");

    // Post-fix: step should be completed (artifact was found after nudge)
    expect(result.stepResults.get("step-nr1")?.status).toBe("completed");
    // No audit violation (artifact was found)
    expect(_mockRecordAuditViolation).not.toHaveBeenCalled();
    // Read persisted step_statuses from test DB to verify nudge metadata
    const execRow = getTestDb().prepare(
      "SELECT step_statuses FROM template_executions WHERE id = ?",
    ).get("exec-nudge-race-1") as { step_statuses: string } | undefined;
    if (execRow) {
      const statuses = JSON.parse(execRow.step_statuses) as Record<string, Record<string, unknown>>;
      expect(statuses["step-nr1"]?.nudgeAttempted).toBe(true);
      expect(statuses["step-nr1"]?.retryReason).toBe("nudge");
      expect(statuses["step-nr1"]?.status).toBe("completed");
      expect(statuses["step-nr1"]?.contractRetried).toBeUndefined();
    }
  });

  it("race-rescue: original task force-closed AFTER publishing artifact — step judged completed, no nudge", async () => {
    // Test Case 2: original task's SDK wrapper returns "failed" (force-closed), but the
    // artifact already landed in DB before the timeout. Step must be completed via
    // race-rescue path; nudge must NOT be dispatched.
    const tmpl: TaskTemplate = {
      id: "tmpl-race-rescue",
      name: "race-rescue",
      trigger: { type: "manual" },
      steps: [{ id: "step-rr", prompt: "Produce report", outputAs: "report", roleId: "role-enforcement-test" }],
      enabled: true,
      createdAt: Date.now(),
    };
    createTaskTemplate(tmpl);

    // Original task force-closed (failed)
    _mockWaitForTaskCompletion.mockResolvedValueOnce("failed" as const);

    // Artifact already in DB (landed before SDK timeout)
    const seedArtifact = {
      id: "art-rr",
      executionId: "exec-race-rescue",
      stepId: "step-rr",
      key: "report",
      kind: "file" as const,
      mime: "text/plain",
      sizeBytes: 512,
      createdAt: Date.now(),
    };
    // After Task 1-impl: artifactAlreadyPublished check fires first → returns artifact → raceRescued=true
    vi.mocked(getArtifact).mockReturnValue(seedArtifact as any);

    const nudgeDispatchSpy = vi.spyOn(executor as any, "dispatchNudge");

    const result = await executor.execute(tmpl, "exec-race-rescue");

    // Post-fix: step should be completed via race-rescue
    expect(result.stepResults.get("step-rr")?.status).toBe("completed");
    // Nudge must NOT have been called
    expect(nudgeDispatchSpy).not.toHaveBeenCalled();
    // No audit violation
    expect(_mockRecordAuditViolation).not.toHaveBeenCalled();
    // Read persisted step_statuses to verify race-rescue marker
    const execRow = getTestDb().prepare(
      "SELECT step_statuses FROM template_executions WHERE id = ?",
    ).get("exec-race-rescue") as { step_statuses: string } | undefined;
    if (execRow) {
      const statuses = JSON.parse(execRow.step_statuses) as Record<string, Record<string, unknown>>;
      expect(statuses["step-rr"]?.retryReason).toBe("race-rescue");
      expect(statuses["step-rr"]?.nudgeAttempted).toBeUndefined();
      expect(statuses["step-rr"]?.contractRetried).toBeUndefined();
    }
  });

  it("race-rescue + outputAs undefined → step keeps failed (artifact existence alone cannot rescue)", async () => {
    // Nice-to-have #8 boundary lock: when a step does NOT declare outputAs, the
    // artifactAlreadyPublished pre-check returns false regardless of DB state, so
    // raceRescued stays false. A force-closed wrapper with no artifact contract must
    // still be judged failed. This protects against a future refactor inverting the
    // ternary or dropping the `step.outputAs ?` guard from the pre-check.
    const tmpl: TaskTemplate = {
      id: "tmpl-no-outputas",
      name: "no-outputas",
      trigger: { type: "manual" },
      steps: [{ id: "step-no-out", prompt: "Do something", roleId: "role-enforcement-test" }],
      enabled: true,
      createdAt: Date.now(),
    };
    createTaskTemplate(tmpl);

    _mockWaitForTaskCompletion.mockResolvedValueOnce("failed" as const);
    // Even if some artifact exists in DB under a different step, the lack of step.outputAs
    // means artifactAlreadyPublished evaluates to false → raceRescued=false → step failed.
    vi.mocked(getArtifact).mockReturnValue({
      id: "art-irrelevant",
      executionId: "exec-no-outputas",
      stepId: "step-no-out",
      key: "irrelevant",
      kind: "file" as const,
    } as any);

    const result = await executor.execute(tmpl, "exec-no-outputas");

    expect(result.stepResults.get("step-no-out")?.status).toBe("failed");
    const execRow = getTestDb().prepare(
      "SELECT step_statuses FROM template_executions WHERE id = ?",
    ).get("exec-no-outputas") as { step_statuses: string } | undefined;
    if (execRow) {
      const statuses = JSON.parse(execRow.step_statuses) as Record<string, Record<string, unknown>>;
      expect(statuses["step-no-out"]?.retryReason).not.toBe("race-rescue");
    }
  });

  it("cancellation precedence: cancelled execution + artifact present → step cancelled, not race-rescued", async () => {
    // Must-fix #2 lock: when the execution is cancelled (either step-level or execution-level),
    // an artifact happening to exist in DB must NOT silently reclassify the step to completed.
    // Cancellation is user intent; race-rescue is a wrapper-vs-DB reconciliation. Cancellation wins.
    const tmpl: TaskTemplate = {
      id: "tmpl-cancel-rescue",
      name: "cancel-rescue",
      trigger: { type: "manual" },
      steps: [{ id: "step-cr", prompt: "Produce report", outputAs: "report", roleId: "role-enforcement-test" }],
      enabled: true,
      createdAt: Date.now(),
    };
    createTaskTemplate(tmpl);

    _mockWaitForTaskCompletion.mockResolvedValueOnce("cancelled" as const);

    // Artifact exists — but execution will be marked cancelled mid-flight via the DB row.
    vi.mocked(getArtifact).mockReturnValue({
      id: "art-cr",
      executionId: "exec-cancel-rescue",
      stepId: "step-cr",
      key: "report",
      kind: "file" as const,
    } as any);

    // Pre-seed the execution row with status=cancelled to simulate user cancellation that
    // landed before this step finished.
    const result = await executor.execute(tmpl, "exec-cancel-rescue");

    // Result status should be cancelled (or failed), absolutely NOT completed.
    const stepStatus = result.stepResults.get("step-cr")?.status;
    expect(stepStatus).not.toBe("completed");
    // race-rescue marker must NOT be set under cancellation
    const execRow = getTestDb().prepare(
      "SELECT step_statuses FROM template_executions WHERE id = ?",
    ).get("exec-cancel-rescue") as { step_statuses: string } | undefined;
    if (execRow) {
      const statuses = JSON.parse(execRow.step_statuses) as Record<string, Record<string, unknown>>;
      expect(statuses["step-cr"]?.retryReason).not.toBe("race-rescue");
    }
  });

  it("regression: nudge fired AND failed AND no artifact → step failed, violation recorded", async () => {
    // Test Case 3: regression guard — nudge fires but also fails to publish.
    // Step must remain "failed" and exactly one audit violation must be recorded.
    // This test must PASS both pre-fix AND post-fix (it locks the existing failure branch).
    const tmpl: TaskTemplate = {
      id: "tmpl-nudge-fail",
      name: "nudge-fail",
      trigger: { type: "manual" },
      steps: [{ id: "step-nf", prompt: "Produce audio", outputAs: "audio", outputContract: { contractRules: [{ kind: "fileSizeBytes", min: 1 }] }, roleId: "role-enforcement-test" }],
      enabled: true,
      createdAt: Date.now(),
    };
    createTaskTemplate(tmpl);

    // Original task completes; nudge also fails; NO artifact pre-seeded
    _mockCreateTaskWithAdmission
      .mockResolvedValueOnce({ ok: true, taskId: "task-original-nf", reason: "" })
      .mockResolvedValueOnce({ ok: true, taskId: "nudge-nf", reason: "" });
    _mockWaitForTaskCompletion
      .mockResolvedValueOnce("completed" as const) // original task
      .mockResolvedValueOnce("failed" as const);   // nudge task

    // No artifact (default: getArtifact returns undefined)
    vi.mocked(getArtifact).mockReturnValue(undefined);

    const result = await executor.execute(tmpl, "exec-nudge-fail");

    expect(result.stepResults.get("step-nf")?.status).toBe("failed");
    expect(_mockRecordAuditViolation).toHaveBeenCalledTimes(1);
    expect(_mockRecordAuditViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "exec-nudge-fail",
        contractField: "outputAs",
        layer: "A",
      }),
    );
    // Read persisted step_statuses to verify nudgeAttempted
    const execRow = getTestDb().prepare(
      "SELECT step_statuses FROM template_executions WHERE id = ?",
    ).get("exec-nudge-fail") as { step_statuses: string } | undefined;
    if (execRow) {
      const statuses = JSON.parse(execRow.step_statuses) as Record<string, Record<string, unknown>>;
      expect(statuses["step-nf"]?.nudgeAttempted).toBe(true);
    }
  });

  // (f) DELETED — tested the removed reply-gated post-hoc content retry path (outputChannel:"reply"
  // + Layer A lengthTarget violation triggering a re-dispatch). Pure design: any Layer A failure is
  // an immediate fail-A with the violation recorded under the original task (covered by case (b)/(e)
  // here and template-executor-contract-hook.test.ts case (b)); there is no retry task to record under.
});
