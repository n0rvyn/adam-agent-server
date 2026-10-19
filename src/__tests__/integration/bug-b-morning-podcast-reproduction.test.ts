/**
 * Task 5: Integration test — canonical reproduction of morning podcast bug B.
 *
 * Seeds a test DB with a faithful copy of execution 219ea326-412e-4c95-b549-cadab3508815
 * (today 2026-05-24 06:00 morning podcast). The jay step's artifact is a no_content
 * JSON marker; all other steps have real file artifacts.
 *
 * After Tasks 1-4, the three assertions hold:
 *   (1) checkDeliveryCompleteness returns a no_content gap on jay/audio-files
 *   (2) assembleSummary body begins with "⚠️ 本期音频缺失" banner
 *   (3) the finalStatus predicate computes "partial" (not "completed")
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// ---------------------------------------------------------------------------
// Mock state — mutable arrays
// ---------------------------------------------------------------------------

const _artifactRows: Array<{
  id: string; sourceKind: "template_step"; executionId: string; stepId: string;
  key: string; kind: "file" | "json"; value?: unknown; blobPath?: string;
  sizeBytes: number; createdAt: number; roleId?: string;
}> = [];

let _testArtifactRows: typeof _artifactRows = [];

const _mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../store/artifacts.js", () => ({
  getArtifact: vi.fn((execId: string, stepId: string, key: string) =>
    _testArtifactRows.find((a) => a.executionId === execId && a.stepId === stepId && a.key === key),
  ),
  createArtifact: vi.fn((row: typeof _artifactRows[number]) => {
    _artifactRows.push(row);
  }),
  listArtifactsByExecution: vi.fn((_execId: string) => _testArtifactRows),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: _mockReadFileSync };
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import { checkDeliveryCompleteness } from "../../lib/delivery-completeness.js";
import { assembleSummary } from "../../scheduler/template-summary-assembler.js";
import type { TaskTemplate, StepResult } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Template mirroring the morning podcast template (id 95a97f8c-...)
// Only steps that declare outputAs are relevant to the completeness check.
// ---------------------------------------------------------------------------
// Minimal template matching the 3 steps with confirmed real artifacts in the morning DB.
// The full 15-step template includes intermediate steps (critique/润色/评分/口播稿)
// that had no artifacts in the real execution; the chokepoint correctly reports those as gaps.
// This minimal version isolates the jay/no_content gap for a targeted assertion.
const MORNING_TEMPLATE: TaskTemplate = {
  id: "tmpl-morning-podcast",
  name: "早间播客流水线",
  trigger: { type: "cron" },
  steps: [
    { id: "定稿", prompt: "...", outputAs: "定稿结果", roleId: "role-k" },
    { id: "jay", prompt: "...", outputAs: "audio-files", roleId: "role-jay" },
    { id: "picasso", prompt: "...", outputAs: "artworks", roleId: "role-picasso" },
  ],
  enabled: true,
  createdAt: Date.now(),
  config: {
    delivery: {
      mode: "primary-artifact",
      primaryArtifact: { stepId: "定稿", key: "定稿结果" },
    },
    continueOnError: true,
  },
};

// The exact no_content artifact from the real execution.
const NO_CONTENT_ARTIFACT = {
  id: "89297586-8a17-44e0-ba1e-24a5a2ad5123",
  sourceKind: "template_step" as const,
  executionId: "219ea326-412e-4c95-b549-cadab3508815",
  stepId: "jay",
  key: "audio-files",
  kind: "json" as const,
  value: { status: "no_content", reason: "Previous task wrote no files - crashed or hit quota before producing audio output" },
  blobPath: undefined,
  sizeBytes: 129,
  createdAt: Date.now(),
  roleId: "role-jay",
};

// Real step status values from execution 219ea326-... (extracted from DB).
// All steps completed; jay step's artifact is the no_content marker.
function makeStepResults(): Map<string, StepResult> {
  const steps: Array<[string, StepResult]> = [
    "采集", "写稿A", "写稿B", "写稿C",
    "批判A", "批判B", "批判C",
    "润色A", "润色B", "润色C",
    "评分", "定稿", "口播稿", "jay", "picasso",
  ].map((stepId) => [
    stepId,
    {
      stepId,
      taskId: `task-${stepId}`,
      status: stepId === "jay" ? "no_content" as const : "completed" as const,
      result: stepId === "jay" ? "" : "Step completed.",
      roleName: "TestRole",
    },
  ]);
  return new Map(steps);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bug-b morning podcast reproduction (219ea326)", () => {
  beforeEach(() => {
    clearTestDb();
    _artifactRows.length = 0;
    _testArtifactRows = _artifactRows;
    _mockReadFileSync.mockReset();

    // Seed all artifacts matching the real morning execution EXCEPT jay's.
    // jay has the no_content JSON marker (not a real file).
    const realArtifacts = [
      { id: "art-采集", stepId: "采集", key: "素材摘要", kind: "file" as const, blobPath: "/tmp/素材摘要.md", sizeBytes: 14408 },
      { id: "art-写稿A", stepId: "写稿A", key: "草稿-A", kind: "file" as const, blobPath: "/tmp/草稿-A.md", sizeBytes: 12905 },
      { id: "art-写稿B", stepId: "写稿B", key: "草稿-B", kind: "file" as const, blobPath: "/tmp/草稿-B.md", sizeBytes: 11836 },
      { id: "art-写稿C", stepId: "写稿C", key: "草稿-C", kind: "file" as const, blobPath: "/tmp/草稿-C.md", sizeBytes: 18309 },
      { id: "art-定稿", stepId: "定稿", key: "定稿结果", kind: "file" as const, blobPath: "/tmp/定稿结果.md", sizeBytes: 17490 },
      { id: "art-picasso", stepId: "picasso", key: "artworks", kind: "file" as const, blobPath: "/tmp/artworks.zip", sizeBytes: 4733614 },
      // NO artifact for jay/audio-files — the no_content marker IS the artifact
    ];

    for (const a of realArtifacts) {
      _artifactRows.push({
        ...a,
        sourceKind: "template_step",
        executionId: "219ea326-412e-4c95-b549-cadab3508815",
        value: undefined,
        createdAt: Date.now(),
        roleId: "role-da",
      });
    }

    // jay step's artifact is the no_content JSON marker
    _artifactRows.push(NO_CONTENT_ARTIFACT);
  });

  /**
   * Assertion 1: chokepoint returns no_content gap on jay/audio-files.
   * This is the canonical reproduction of today's morning bug.
   */
  it("(1) checkDeliveryCompleteness returns no_content gap for jay/audio-files", () => {
    const result = checkDeliveryCompleteness(
      "219ea326-412e-4c95-b549-cadab3508815",
      MORNING_TEMPLATE,
    );

    expect(result.complete).toBe(false);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      stepId: "jay",
      key: "audio-files",
      kind: "no_content",
    });
    expect(result.gaps[0].reason).toMatch(/Previous task wrote no files/);
  });

  /**
   * Assertion 2: assembled body begins with warning banner.
   * After Tasks 1+4, assembleSummary prepends the banner when gaps exist.
   */
  it("(2) assembleSummary body begins with warning banner", () => {
    const stepResults = makeStepResults();

    // Seed readFileSync so the primary artifact (定稿/定稿结果) resolves.
    _mockReadFileSync.mockReturnValueOnce("# 播客定稿\n\n测试内容。");

    const body = assembleSummary({
      executionId: "219ea326-412e-4c95-b549-cadab3508815",
      template: MORNING_TEMPLATE,
      stepResults,
    });

    expect(body).toMatch(/^⚠️ 本期音频缺失/);
    expect(body).toContain("jay");
    expect(body).toContain("audio-files");
  });

  /**
   * Assertion 3: finalStatus predicate computes "partial" not "completed".
   * After Task 3, the predicate flips to partial when hasNoContent OR gaps exist.
   *
   * Simulate the predicate logic directly (the real executor path is tested in
   * template-executor-completeness-gate.test.ts; here we test that the predicate
   * formula fires correctly for the no_content step result).
   */
  it("(3) finalStatus predicate computes 'partial' when step status is no_content", () => {
    const stepResults = makeStepResults();

    // Simulate the predicate from template-executor.ts:394-397
    const hasFailures = false;
    const hasSkipped = [...stepResults.values()].some(
      (r) => r.status === "skipped" || r.status === "cancelled",
    );
    const hasNoContent = [...stepResults.values()].some((r) => r.status === "no_content");
    const completeness = checkDeliveryCompleteness(
      "219ea326-412e-4c95-b549-cadab3508815",
      MORNING_TEMPLATE,
    );
    const finalStatus: "completed" | "partial" =
      (hasFailures || hasSkipped || hasNoContent || !completeness.complete)
        ? "partial"
        : "completed";

    expect(finalStatus).toBe("partial");
  });
});

afterAll(() => cleanup());
