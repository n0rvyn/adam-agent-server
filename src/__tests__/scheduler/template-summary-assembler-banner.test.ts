/**
 * Task 4-tests: Unit tests for delivery banner prepending + concat icon NO-CONTENT label.
 *
 * After Task 1-impl (chokepoint) + Task 4-impl (banner + icon):
 *   - assembleSummary prepends a warning banner when checkDeliveryCompleteness reports gaps
 *   - concat-step-results mode shows [NO-CONTENT] icon for steps with status="no_content"
 *
 * Pre-impl: no banner exists; icon falls through to "FAIL" for no_content steps.
 *
 * Pattern: mirrors template-summary-assembler.test.ts harness (mutable shared arrays).
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// ---------------------------------------------------------------------------
// Mock state — mutable arrays seeded per test before calling assemble*()
// ---------------------------------------------------------------------------

const _artifactRows: Array<{
  id: string; sourceKind: string; executionId: string; stepId: string;
  key: string; kind: "file" | "json"; value?: unknown; blobPath?: string;
  sizeBytes: number; createdAt: number; roleId?: string;
}> = [];

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn((execId: string) =>
    _artifactRows.filter((r) => r.executionId === execId) as unknown,
  ),
}));

// Execution rows for assembleSummaryFromDb
const _executionRows: Array<Record<string, unknown>> = [];
vi.mock("../../store/template-executions.js", () => ({
  getTemplateExecution: vi.fn((id: string) =>
    _executionRows.find((r) => r.id === id) as unknown,
  ),
}));

// Template rows for assembleSummaryFromDb
const _templateRows: Array<Record<string, unknown>> = [];
vi.mock("../../store/task-templates.js", () => ({
  getTaskTemplate: vi.fn((id: string) =>
    _templateRows.find((r) => r.id === id) as unknown,
  ),
}));

const _mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: _mockReadFileSync };
});

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------
import {
  assembleSummary,
  assembleSummaryFromDb,
} from "../../scheduler/template-summary-assembler.js";
import type { TaskTemplate, StepResult } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal podcast-like template: draft step (reply-channel) + audio step (file output). */
function makePodcastTemplate(mode: "concat-step-results" | "primary-artifact" = "primary-artifact"): TaskTemplate {
  return {
    id: "tmpl-banner-test",
    name: "banner-test-podcast",
    trigger: { type: "manual" },
    steps: [
      {
        id: "定稿",
        prompt: "Write the draft.",
        outputAs: "draft-output",
        roleId: "role-banner-test",
      },
      {
        id: "jay",
        prompt: "Produce mp3.",
        outputAs: "audio-files",
        roleId: "role-banner-test",
      },
    ],
    enabled: true,
    createdAt: Date.now(),
    config: {
      delivery: {
        mode,
        primaryArtifact: mode === "primary-artifact"
          ? { stepId: "定稿", key: "draft-output" }
          : undefined,
      },
    },
  };
}

function stepResult(status: StepResult["status"], stepId: string, result = ""): StepResult {
  return { stepId, taskId: `task-${stepId}`, status, result, roleName: "TestRole" };
}

function clearMockRows(): void {
  _artifactRows.length = 0;
  _executionRows.length = 0;
  _templateRows.length = 0;
}

// ---------------------------------------------------------------------------
// Test cases (plan Task 4-tests)
// ---------------------------------------------------------------------------

describe("delivery banner + NO-CONTENT icon", () => {
  beforeEach(() => {
    clearTestDb();
    clearMockRows();
  });

  // -------------------------------------------------------------------------
  // (a) Complete primary-artifact: zero gaps → no banner prepended
  // Regression shield: existing email body unchanged when everything succeeded.
  // -------------------------------------------------------------------------
  it("(a) complete primary-artifact: body has no banner (regression)", () => {
    const tmpl = makePodcastTemplate("primary-artifact");

    // Both steps have real file artifacts.
    _artifactRows.push(
      {
        id: "art-draft", sourceKind: "template_step", executionId: "exec-complete",
        stepId: "定稿", key: "draft-output", kind: "file",
        blobPath: "/tmp/draft.md", sizeBytes: 512, createdAt: 1,
      },
      {
        id: "art-mp3", sourceKind: "template_step", executionId: "exec-complete",
        stepId: "jay", key: "audio-files", kind: "file",
        blobPath: "/tmp/podcast.mp3", sizeBytes: 2048, createdAt: 2,
      },
    );

    // Seed the fs mock so readFileSync returns content for the primary artifact
    _mockReadFileSync.mockReturnValueOnce("# 播客逐字稿\n\n测试内容。");

    const stepResults = new Map<string, StepResult>([
      ["定稿", stepResult("completed", "定稿", "# 播客逐字稿\n\n测试内容。")],
      ["jay", stepResult("completed", "jay", "")],
    ]);

    const body = assembleSummary({ executionId: "exec-complete", template: tmpl, stepResults });

    // No banner prefix
    expect(body).not.toMatch(/^⚠️/);
    // Content is present
    expect(body).toContain("播客逐字稿");
  });

  // -------------------------------------------------------------------------
  // (b) no_content gap in primary-artifact mode: banner prepended with reason
  // -------------------------------------------------------------------------
  it("(b) no_content gap: body begins with warning banner + reason", () => {
    const tmpl = makePodcastTemplate("primary-artifact");

    // Draft artifact OK; jay artifact is a no_content JSON marker.
    _artifactRows.push(
      {
        id: "art-draft", sourceKind: "template_step", executionId: "exec-nocontent",
        stepId: "定稿", key: "draft-output", kind: "file",
        blobPath: "/tmp/draft.md", sizeBytes: 512, createdAt: 1,
      },
      {
        id: "art-nocontent", sourceKind: "template_step", executionId: "exec-nocontent",
        stepId: "jay", key: "audio-files", kind: "json",
        value: { status: "no_content", reason: "quota exceeded before any files written" },
        blobPath: undefined, sizeBytes: 0, createdAt: 2,
      },
    );

    _mockReadFileSync.mockReturnValueOnce("# 播客逐字稿\n\n测试内容。");

    const stepResults = new Map<string, StepResult>([
      ["定稿", stepResult("completed", "定稿", "# 播客逐字稿\n\n测试内容。")],
      ["jay", stepResult("no_content", "jay", "")],
    ]);

    const body = assembleSummary({ executionId: "exec-nocontent", template: tmpl, stepResults });

    // Banner is present and prepended
    expect(body).toMatch(/^⚠️ 本期音频缺失/);
    // Reason text is included
    expect(body).toMatch(/no_content/);
    // Original content still present
    expect(body).toContain("播客逐字稿");
    // Separator between banner and body
    expect(body).toMatch(/\n\n---\n\n/);
  });

  // -------------------------------------------------------------------------
  // (c) missing gap in primary-artifact mode: banner prepended (no reason)
  // -------------------------------------------------------------------------
  it("(c) missing gap: body begins with warning banner (no reason line)", () => {
    const tmpl = makePodcastTemplate("primary-artifact");

    // Only the draft has an artifact; jay step has nothing.
    _artifactRows.push(
      {
        id: "art-draft", sourceKind: "template_step", executionId: "exec-missing",
        stepId: "定稿", key: "draft-output", kind: "file",
        blobPath: "/tmp/draft.md", sizeBytes: 512, createdAt: 1,
      },
      // no jay artifact
    );

    _mockReadFileSync.mockReturnValueOnce("# 播客逐字稿\n\n测试内容。");

    const stepResults = new Map<string, StepResult>([
      ["定稿", stepResult("completed", "定稿", "# 播客逐字稿\n\n测试内容。")],
      ["jay", stepResult("completed", "jay", "")],
    ]);

    const body = assembleSummary({ executionId: "exec-missing", template: tmpl, stepResults });

    expect(body).toMatch(/^⚠️ 本期音频缺失/);
    expect(body).toContain("播客逐字稿");
  });

  // -------------------------------------------------------------------------
  // (d) concat-step-results mode: no_content step shows [NO-CONTENT] icon
  // Verifier S1-3: assembler.ts:204 icon ternary falls through to "FAIL" for no_content.
  // -------------------------------------------------------------------------
  it("(d) concat mode: no_content step shows [NO-CONTENT] icon, not [FAIL]", () => {
    const tmpl = makePodcastTemplate("concat-step-results");

    // In concat mode, no primary artifact required — just check the icon label.
    const stepResults = new Map<string, StepResult>([
      ["定稿", stepResult("completed", "定稿", "# 播客逐字稿")],
      ["jay", stepResult("no_content", "jay", "{status:no_content}")],
    ]);

    const body = assembleSummary({ executionId: "exec-concat", template: tmpl, stepResults });

    // NO-CONTENT icon present
    expect(body).toMatch(/\[NO-CONTENT\]/);
    // FAIL icon absent
    expect(body).not.toMatch(/\[FAIL\].*jay/);
    // Completed step still shows OK icon
    expect(body).toMatch(/\[OK\]/);
  });
});

afterAll(() => cleanup());
