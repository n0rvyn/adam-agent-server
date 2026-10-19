import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import type { TaskStep, TaskTemplate } from "../../shared/types.js";

const { cleanup } = setupTestDb();
const testRuntimeRoot = mkdtempSync(tmpdir() + sep + "adam-step-output-");

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { getStepOutput, StepOutputMissingError, StepOutputBinaryError } from "../../lib/step-output.js";
import { createArtifact } from "../../store/artifacts.js";
import { createTask } from "../../store/tasks.js";
import { createTemplateExecution } from "../../store/template-executions.js";
import { createTaskTemplate } from "../../store/task-templates.js";

afterAll(() => {
  delete process.env.ADAM_TEST_DIR;
  rmSync(testRuntimeRoot, { recursive: true, force: true });
  cleanup();
});

/** Seed a minimal template + execution so artifact FK is satisfied. */
function seedTemplateAndExecution(executionId: string, stepId: string): void {
  const template: TaskTemplate = {
    id: "tmpl-seed-" + executionId,
    name: "Seed Template",
    enabled: true,
    trigger: { type: "once", runAt: new Date(Date.now()).toISOString() },
    steps: [{ id: stepId, prompt: "test step", autoSelectRole: true, requirements: {} }],
    // rolePreference omitted — the step has autoSelectRole so template-level role is not needed
  };
  createTaskTemplate(template);
  createTemplateExecution(executionId, template.id);
}

describe("getStepOutput", () => {
  beforeEach(() => {
    clearTestDb();
    process.env.ADAM_TEST_DIR = testRuntimeRoot;
  });

  // (a) step.outputAs declared, file artifact exists with text mime → returns artifact content from blob, source="artifact"
  it("returns artifact content from blob for declared outputAs with text mime", () => {
    const executionId = "exec-1";
    const taskId = "task-1";
    const step: TaskStep = { id: "step-1", prompt: "", outputAs: "podcast-script" };
    seedTemplateAndExecution(executionId, step.id);

    createTask({
      id: taskId,
      prompt: "test",
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300, env: {} },
      status: "completed",
      createdAt: Date.now(),
    });

    const blobPath = join(testRuntimeRoot, "blob-1.md");
    writeFileSync(blobPath, "# Podcast Script\n\nContent here.", "utf8");

    createArtifact({
      id: "art-1",
      sourceKind: "template_step",
      roleId: "role-test",
      executionId,
      stepId: "step-1",
      key: "podcast-script",
      kind: "file",
      blobPath,
      mime: "text/markdown",
      sizeBytes: 36,
      createdAt: Date.now(),
    });

    const result = getStepOutput({ step, executionId, taskId });

    expect(result.source).toBe("artifact");
    expect(result.artifactId).toBe("art-1");
    expect(result.key).toBe("podcast-script");
    expect(result.content).toBe("# Podcast Script\n\nContent here.");
    expect(result.mime).toBe("text/markdown");
    expect(result.sizeBytes).toBe(36);
  });

  // (b) step.outputAs declared, json artifact exists → returns serialized JSON, source="artifact"
  it("returns serialized JSON for declared outputAs with json artifact", () => {
    const executionId = "exec-2";
    const taskId = "task-2";
    const step: TaskStep = { id: "step-2", prompt: "", outputAs: "metadata" };
    seedTemplateAndExecution(executionId, step.id);

    createTask({
      id: taskId,
      prompt: "test",
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300, env: {} },
      status: "completed",
      createdAt: Date.now(),
    });

    createArtifact({
      id: "art-2",
      sourceKind: "template_step",
      roleId: "role-test",
      executionId,
      stepId: "step-2",
      key: "metadata",
      kind: "json",
      value: { title: "Morning Brief", tags: ["podcast", "morning"] },
      sizeBytes: 57,
      createdAt: Date.now(),
    });

    const result = getStepOutput({ step, executionId, taskId });

    expect(result.source).toBe("artifact");
    expect(result.artifactId).toBe("art-2");
    expect(result.key).toBe("metadata");
    expect(result.mime).toBe("text/plain");
    expect(result.content).toBe('{\n  "title": "Morning Brief",\n  "tags": [\n    "podcast",\n    "morning"\n  ]\n}');
  });

  // (c) step.outputAs declared, no matching artifact → throws StepOutputMissingError with correct stepId + outputAs
  it("throws StepOutputMissingError when declared outputAs artifact is missing", () => {
    const executionId = "exec-3";
    const taskId = "task-3";
    const step: TaskStep = { id: "step-3", prompt: "", outputAs: "nonexistent-artifact" };
    seedTemplateAndExecution(executionId, step.id);

    createTask({
      id: taskId,
      prompt: "test",
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300, env: {} },
      status: "completed",
      createdAt: Date.now(),
    });

    expect(() => getStepOutput({ step, executionId, taskId })).toThrow(StepOutputMissingError);
    try {
      getStepOutput({ step, executionId, taskId });
    } catch (err) {
      expect(err).toBeInstanceOf(StepOutputMissingError);
      expect((err as StepOutputMissingError).stepId).toBe("step-3");
      expect((err as StepOutputMissingError).outputAs).toBe("nonexistent-artifact");
    }
  });

  // (d) step.outputAs undeclared, task.result has content → returns task.result, source="task-result-fallback"
  it("returns task.result for undeclared outputAs with content", () => {
    const executionId = "exec-4";
    const taskId = "task-4";
    const step: TaskStep = { id: "step-4", prompt: "" }; // no outputAs

    createTask({
      id: taskId,
      prompt: "test",
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300, env: {} },
      status: "completed",
      result: "This is the step result from the task.",
      createdAt: Date.now(),
    });

    const result = getStepOutput({ step, executionId, taskId });

    expect(result.source).toBe("task-result-fallback");
    expect(result.artifactId).toBeNull();
    expect(result.key).toBeNull();
    expect(result.content).toBe("This is the step result from the task.");
    expect(result.mime).toBe("text/plain");
  });

  // (e) step.outputAs undeclared, task.result empty/null → returns "" with source="task-result-fallback" (no throw)
  it("returns empty string for undeclared outputAs with no task result", () => {
    const executionId = "exec-5";
    const taskId = "task-5";
    const step: TaskStep = { id: "step-5", prompt: "" }; // no outputAs

    createTask({
      id: taskId,
      prompt: "test",
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300, env: {} },
      status: "completed",
      createdAt: Date.now(),
      // result undefined → falls back to ""
    });

    const result = getStepOutput({ step, executionId, taskId });

    expect(result.source).toBe("task-result-fallback");
    expect(result.content).toBe("");
    expect(result.artifactId).toBeNull();
    expect(result.key).toBeNull();
  });

  // (f) step.outputAs declared, file artifact with binary mime → throws StepOutputBinaryError; verify readFileSync NOT called
  it("throws StepOutputBinaryError for binary mime and does not invoke readFileSync", () => {
    const executionId = "exec-6";
    const taskId = "task-6";
    const step: TaskStep = { id: "step-6", prompt: "", outputAs: "audio-files" };
    seedTemplateAndExecution(executionId, step.id);

    createTask({
      id: taskId,
      prompt: "test",
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300, env: {} },
      status: "completed",
      createdAt: Date.now(),
    });

    // Write a real tmp blob file (should NOT be read for binary mime)
    const blobPath = join(testRuntimeRoot, "blob-6.mp3");
    const dummyBinary = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
    writeFileSync(blobPath, dummyBinary);

    createArtifact({
      id: "art-6",
      sourceKind: "template_step",
      roleId: "role-test",
      executionId,
      stepId: "step-6",
      key: "audio-files",
      kind: "file",
      blobPath,
      mime: "audio/mpeg",
      sizeBytes: 4,
      createdAt: Date.now(),
    });

    const readFileSyncSpy = vi.spyOn(require("node:fs"), "readFileSync");

    expect(() => getStepOutput({ step, executionId, taskId })).toThrow(StepOutputBinaryError);

    try {
      getStepOutput({ step, executionId, taskId });
    } catch (err) {
      expect(err).toBeInstanceOf(StepOutputBinaryError);
      expect((err as StepOutputBinaryError).stepId).toBe("step-6");
      expect((err as StepOutputBinaryError).outputAs).toBe("audio-files");
      expect((err as StepOutputBinaryError).mime).toBe("audio/mpeg");
    }

    // Prove readFileSync was never called — binary detection happened before the read
    const readCall = readFileSyncSpy.mock.calls.find((call) => call[0] === blobPath);
    expect(readCall).toBeUndefined();

    readFileSyncSpy.mockRestore();
  });
});
