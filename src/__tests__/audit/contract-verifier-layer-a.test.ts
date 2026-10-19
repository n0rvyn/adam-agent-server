/**
 * Task 6: Migrated Layer A tests to new {step, executionId, taskId} signature.
 *
 * Key changes from prior version:
 * - runLayerA now calls getStepOutput internally, which reads from stores.
 *   Mock the underlying stores (tasks, artifacts, task-templates)
 *   to control what getStepOutput returns.
 * - New mandatory cases: realistic LLM behavior (publish full artifact + short
 *   task.result summary), binary artifact short-circuit.
 */

import { afterAll, describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import type { TaskStep } from "../../shared/types.js";

const { cleanup } = setupTestDb();

// Per-test runtime root for blob files created by seedArtifact
const _testRuntimeRoot = join(tmpdir(), "adam-layer-a-test-" + Date.now());
mkdirSync(_testRuntimeRoot, { recursive: true });

afterAll(() => {
  rmSync(_testRuntimeRoot, { recursive: true, force: true });
  cleanup();
});

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// vi.hoisted() registers these for hoisting alongside vi.mock() factories.
// Use a mutable container object so the arrays can be reset in beforeEach
// (plain arrays returned from vi.hoisted() are const-bound).
const _store = vi.hoisted(() => ({
  artifacts: [] as Array<{
    executionId: string; stepId: string; key: string;
    mime?: string; value?: unknown; blobPath?: string; sizeBytes: number;
    artifactRole?: string;
  }>,
  tasks: [] as Array<{ id: string; result?: string }>,
}));

vi.mock("../../store/artifacts.js", () => {
  const toArtifact = (found: typeof _store.artifacts[number]) => ({
    id: `art-${found.executionId}-${found.stepId}-${found.key}`,
    executionId: found.executionId,
    stepId: found.stepId,
    key: found.key,
    kind: found.value !== undefined ? ("json" as const) : ("file" as const),
    mime: found.mime ?? "text/plain",
    blobPath: found.blobPath,
    value: found.value,
    sizeBytes: found.sizeBytes,
    artifactRole: found.artifactRole,
    createdAt: Date.now(),
  });
  return {
    getArtifact: (execId: string, stepId: string, key: string) => {
      const found = _store.artifacts.find(
        (a) => a.executionId === execId && a.stepId === stepId && a.key === key,
      );
      return found ? toArtifact(found) : null;
    },
    listArtifactsByExecution: (execId: string, stepId?: string) =>
      _store.artifacts
        .filter((a) => a.executionId === execId && (stepId === undefined || a.stepId === stepId))
        .map(toArtifact),
  };
});

vi.mock("../../store/tasks.js", () => ({
  getTask: (taskId: string) => {
    const t = _store.tasks.find((t) => t.id === taskId);
    return t ? { id: t.id, result: t.result ?? "", status: "completed" } : null;
  },
}));

// Step factory — no outputAs unless explicitly set
function makeStep(overrides: Partial<{
  id: string;
  outputAs: string;
  outputChannel: "reply" | "file";
  outputContract: {
    lengthTarget?: { min: number; max: number; unit: "characters" | "words" | "bytes" };
    format?: "markdown" | "text" | "json";
    mustReferenceArtifacts?: boolean;
    expectedArtifacts?: Array<{ role: string; mime?: string; count: number; required?: boolean }>;
  };
  persona: { speakAs: string; voiceConstraints?: string };
}> = {}): TaskStep {
  return {
    id: "step-1",
    prompt: "test prompt",
    ...overrides,
  } as TaskStep;
}

// Run Layer A — reads from the seeded store state
async function run(args: { step: TaskStep; executionId: string; taskId: string }) {
  const { runLayerA } = await import("../../audit/contract-verifier.js");
  return runLayerA(args);
}

// ---------------------------------------------------------------------------
// Helper: seed artifact into the mock store
// For file artifacts (mime set, value undefined), a blobPath is required
// so artifactToResult can read the content. We write a real tmp file.
// ---------------------------------------------------------------------------
function seedArtifact(p: {
  executionId: string;
  stepId: string;
  key: string;
  mime?: string;
  content?: string;   // text file content (used when no jsonValue set)
  jsonValue?: unknown; // json artifact value (used when set)
  sizeBytes?: number;
  artifactRole?: string;
}) {
  if (p.jsonValue !== undefined) {
    _store.artifacts.push({
      executionId: p.executionId,
      stepId: p.stepId,
      key: p.key,
      value: p.jsonValue,
      sizeBytes: p.sizeBytes ?? Buffer.byteLength(JSON.stringify(p.jsonValue), "utf8"),
      artifactRole: p.artifactRole,
    });
  } else {
    // For file artifacts, write content to a real tmp file so readFileSync finds it
    const blobPath = join(_testRuntimeRoot, `art-${p.executionId}-${p.stepId}-${p.key}.blob`);
    if (p.content !== undefined) {
      writeFileSync(blobPath, p.content, "utf8");
    }
    _store.artifacts.push({
      executionId: p.executionId,
      stepId: p.stepId,
      key: p.key,
      mime: p.mime,
      blobPath,
      sizeBytes: p.sizeBytes ?? (p.content ? Buffer.byteLength(p.content, "utf8") : 0),
      artifactRole: p.artifactRole,
    });
  }
}

// ---------------------------------------------------------------------------
// Helper: seed task result into the mock store
// ---------------------------------------------------------------------------
function seedTask(id: string, result: string) {
  _store.tasks.push({ id, result });
}

describe("contract-verifier Layer A (migrated to step-output)", () => {

  beforeEach(() => {
    clearTestDb();
    _store.artifacts = [];
    _store.tasks = [];
  });

  // -------------------------------------------------------------------------
  // Legacy path: step has NO outputAs → reads task.result (back-compat)
  // These tests replicate the prior test suite's core cases using the new
  // seed helpers so the actual getStepOutput behavior is exercised.
  // -------------------------------------------------------------------------
  describe("legacy: no outputAs — reads task.result", () => {
    // Length and format checks (under-min / markdown-heading / json-validity) were REMOVED from
    // Layer A in the single-vocabulary pure design — content/format is now enforced at the
    // PreToolUse boundary hook on write_artifact (Track A). Coverage moved to
    // execution-manager-pretool-hook-inject.test.ts (buildTrackAHook). The DP-001 reply-gating
    // of those Layer A checks is also gone (outputChannel removed). Layer A keeps only
    // presence-gate (outputAs) + persona identity, so only the persona cases remain here.

    it("skips identity check for podcast Role persona", async () => {
      const step = makeStep({ persona: { speakAs: "达芬奇" } });
      seedTask("task-legacy-7", "我是达芬奇，今天聊艺术。");

      const result = await run({ step, executionId: "exec-legacy-7", taskId: "task-legacy-7" });
      expect(result.passed).toBe(true);
    });

    it("fails identity check for non-podcast persona self-identifying as podcast Role", async () => {
      const step = makeStep({ persona: { speakAs: "卞旸" } });
      seedTask("task-legacy-8", "我是达芬奇。");

      const result = await run({ step, executionId: "exec-legacy-8", taskId: "task-legacy-8" });
      expect(result.passed).toBe(false);
      expect(result.violations[0].contractField).toBe("persona.speakAs");
    });
  });

  // -------------------------------------------------------------------------
  // NEW (a): realistic LLM behavior — publish full content as artifact, write
  // short summary in task.result. Layer A MUST measure the artifact (pass),
  // NOT the task.result (which would fail length check).
  // This is the exact root cause of the 2026-05-09 morning podcast failure.
  // -------------------------------------------------------------------------
  describe("realistic LLM behavior: artifact full content + task.result summary", () => {
    it("measures artifact content (passes length contract), not task.result summary", async () => {
      const step: TaskStep = {
        id: "step-writer",
        prompt: "写播客脚本",
        outputAs: "最终逐字稿",
        outputContract: { lengthTarget: { min: 2000, max: 3000, unit: "characters" } },
      } as TaskStep;

      // ~2205 chars: within [2000, 3000]
      const fullScript = "# 播客逐字稿\n\n" + "这是播客脚本的完整内容。".repeat(183);
      seedArtifact({
        executionId: "exec-realistic-1",
        stepId: "step-writer",
        key: "最终逐字稿",
        mime: "text/markdown",
        content: fullScript,
      });
      // Simulate LLM's short summary in task.result
      seedTask("task-realistic-1", "已发布到 artifact，最终逐字稿。");

      const result = await run({ step, executionId: "exec-realistic-1", taskId: "task-realistic-1" });

      // Length check uses artifact (2400 chars) → within [2000, 3000] → PASS
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it("would fail length check if it measured task.result instead of artifact", async () => {
      const step: TaskStep = {
        id: "step-writer",
        prompt: "写播客脚本",
        outputAs: "最终逐字稿",
        outputContract: { lengthTarget: { min: 2000, max: 3000, unit: "characters" } },
      } as TaskStep;

      const fullScript = "# 播客逐字稿\n\n" + "这是播客脚本的完整内容。".repeat(183);
      seedArtifact({
        executionId: "exec-realistic-2",
        stepId: "step-writer",
        key: "最终逐字稿",
        mime: "text/markdown",
        content: fullScript,
      });
      seedTask("task-realistic-2", "已发布。");

      const result = await run({ step, executionId: "exec-realistic-2", taskId: "task-realistic-2" });

      // Artifact is large enough; task.result ("已发布。", ~5 chars) would fail [2000, 3000]
      // But runLayerA measures artifact → PASS
      expect(result.passed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // NEW (b): step.outputAs declared, artifact missing → StepOutputMissingError
  // → Layer A returns passed=false with outputAs violation message.
  // -------------------------------------------------------------------------
  describe("outputAs declared but artifact missing", () => {
    it("returns failed result when declared artifact is not published", async () => {
      const step: TaskStep = {
        id: "step-no-artifact",
        prompt: "写点什么",
        outputAs: "podcast-script-final",
        outputContract: { lengthTarget: { min: 100, max: 500, unit: "characters" } },
      } as TaskStep;
      // No artifact seeded — getArtifact returns null → StepOutputMissingError thrown

      seedTask("task-no-artifact", "some result but artifact missing");

      const result = await run({ step, executionId: "exec-no-artifact", taskId: "task-no-artifact" });

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].contractField).toBe("outputAs");
      expect(result.violations[0].message).toContain("step-no-artifact");
      expect(result.violations[0].message).toContain("podcast-script-final");
    });
  });

  // -------------------------------------------------------------------------
  // NEW (c): binary artifact (audio/mpeg) → StepOutputBinaryError → Layer A
  // passes by convention (length/format/persona checks don't apply to binary).
  // This is the key short-circuit added in Task 5 step 2.
  // -------------------------------------------------------------------------
  describe("binary artifact: StepOutputBinaryError → Layer A passes by convention", () => {
    it("passes Layer A for binary artifact without reading the blob", async () => {
      const step: TaskStep = {
        id: "step-audio",
        prompt: "生成音频",
        outputAs: "audio-files",
        outputContract: { lengthTarget: { min: 100, max: 200, unit: "characters" } },
        persona: { speakAs: "周杰伦" },
      } as TaskStep;

      const readFileSyncSpy = vi.spyOn(require("node:fs"), "readFileSync");

      seedArtifact({
        executionId: "exec-binary-1",
        stepId: "step-audio",
        key: "audio-files",
        mime: "audio/mpeg",
        content: "binary data would be here",
      });
      seedTask("task-binary-1", "audio generated");

      const result = await run({ step, executionId: "exec-binary-1", taskId: "task-binary-1" });

      // Binary → StepOutputBinaryError → caught → returns { passed: true, violations: [] }
      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);

      // Prove readFileSync was NOT called on the blob path
      const binaryReadCall = readFileSyncSpy.mock.calls.find(
        ([path]) => String(path).includes("exec-binary-1"),
      );
      expect(binaryReadCall).toBeUndefined();

      readFileSyncSpy.mockRestore();
    });

    it("passes Layer A for image artifact (image/png)", async () => {
      const step: TaskStep = {
        id: "step-image",
        prompt: "生成图片",
        outputAs: "artworks",
        outputContract: { lengthTarget: { min: 1000, max: 2000, unit: "characters" } },
      } as TaskStep;

      seedArtifact({
        executionId: "exec-binary-2",
        stepId: "step-image",
        key: "artworks",
        mime: "image/png",
      });
      seedTask("task-binary-2", "image generated");

      const result = await run({ step, executionId: "exec-binary-2", taskId: "task-binary-2" });

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Combined: length + format + persona all in one step, using artifact source
  // -------------------------------------------------------------------------
  // Combined length+format violation cases REMOVED: length/format are no longer Layer A concerns
  // (moved to the PreToolUse boundary hook, Track A — covered by execution-manager-pretool-hook-inject.test.ts).
  // The persona identity + outputAs presence-gate dimensions Layer A still owns are covered by the
  // persona cases above and the "outputAs declared but artifact missing" case below.

  // expectedArtifacts role-count check REMOVED (D6): role-tagging is gone. Contract granularity is
  // the key (outputAs) — existence is enforced by the presence gate, binary quality by Track B.

  // DP-001 reply-gating of Layer A length/format checks REMOVED: outputChannel is gone, and there is
  // no Layer A length/format check left to gate. Content checks run at the boundary for every step.

  describe("combined checks: persona violation surfaces with artifact source", () => {
    it("flags persona identity drift when the artifact self-identifies as another podcast Role", async () => {
      const step: TaskStep = {
        id: "step-combo",
        prompt: "写播客内容",
        outputAs: "script",
        persona: { speakAs: "卞旸" },
      } as TaskStep;

      seedArtifact({
        executionId: "exec-combo-1",
        stepId: "step-combo",
        key: "script",
        mime: "text/markdown",
        content: "# 今日播客\n\n我是达芬奇，今天聊点别的。",
      });
      seedTask("task-combo-1", "done");

      const result = await run({ step, executionId: "exec-combo-1", taskId: "task-combo-1" });

      expect(result.passed).toBe(false);
      const fields = result.violations.map((v) => v.contractField);
      expect(fields).toContain("persona.speakAs");
    });

    it("passes when the artifact satisfies persona + presence (length/format owned by the boundary)", async () => {
      const step: TaskStep = {
        id: "step-combo-ok",
        prompt: "写播客内容",
        outputAs: "script-ok",
        persona: { speakAs: "李四" },
      } as TaskStep;

      const goodContent = "# 今日播客\n\n" + "这是完整的内容。".repeat(18);
      seedArtifact({
        executionId: "exec-combo-2",
        stepId: "step-combo-ok",
        key: "script-ok",
        mime: "text/markdown",
        content: goodContent,
      });
      seedTask("task-combo-2", "done");

      const result = await run({ step, executionId: "exec-combo-2", taskId: "task-combo-2" });

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });
});
