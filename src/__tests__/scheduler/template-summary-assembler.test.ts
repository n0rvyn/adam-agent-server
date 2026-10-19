/**
 * Unit tests for template-summary-assembler.ts — Phase 2 DP-001 Option C.
 *
 * Covers:
 *   assembleSummary — concat-step-results (4 cases: 3-status, completed-only, skipped-only, no-output)
 *   assembleSummary — primary-artifact (4 cases: json-string, json-object, file-text, file-non-text error)
 *   assembleSummary — custom mode throws DeliveryNotImplementedError
 *   assembleSummary — missing primary artifact throws PrimaryArtifactNotFoundError
 *   assembleSummaryFromDb — success (reconstructs from DB)
 *   assembleSummaryFromDb — missing step_results_json returns undefined
 *   assembleSummaryFromDb — execution not found returns undefined
 *   tryAssembleFallbackDelivery — returns null when not primary-artifact mode
 *   tryAssembleFallbackDelivery — returns partial delivery when primary-artifact resolves
 *   DeliveryNotImplementedError + PrimaryArtifactNotFoundError — exported for compat
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// ---------------------------------------------------------------------------
// Mock artifact store — seeded per-test via artifactRows array
// ---------------------------------------------------------------------------
const artifactRows: Array<Record<string, unknown>> = [];
vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn((executionId: string) =>
    artifactRows.filter((r) => r.executionId === executionId) as unknown,
  ),
}));

// ---------------------------------------------------------------------------
// Mock template-executions store (for assembleSummaryFromDb)
// ---------------------------------------------------------------------------
const executionRows: Array<Record<string, unknown>> = [];
vi.mock("../../store/template-executions.js", () => ({
  getTemplateExecution: vi.fn((id: string) =>
    executionRows.find((r) => r.id === id) as unknown,
  ),
}));

// ---------------------------------------------------------------------------
// Mock task-templates store (for assembleSummaryFromDb)
// ---------------------------------------------------------------------------
const templateRows: Array<Record<string, unknown>> = [];
vi.mock("../../store/task-templates.js", () => ({
  getTaskTemplate: vi.fn((id: string) =>
    templateRows.find((r) => r.id === id) as unknown,
  ),
}));

import { readFileSync } from "node:fs";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------
import {
  assembleSummary,
  assembleSummaryFromDb,
  tryAssembleFallbackDelivery,
  DeliveryNotImplementedError,
  PrimaryArtifactNotFoundError,
} from "../../scheduler/template-summary-assembler.js";
import type { TaskTemplate, TaskConfig, StepResult } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeTemplate(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    id: "tmpl-test",
    name: "Test Template",
    config: {},
    steps: [],
    trigger: { type: "manual" as const },
    enabled: true,
    ...overrides,
  } as TaskTemplate;
}

function makeStepResults(...entries: Array<[string, StepResult]>): Map<string, StepResult> {
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  artifactRows.length = 0;
  executionRows.length = 0;
  templateRows.length = 0;
  vi.mocked(readFileSync).mockReset().mockReturnValue("# Heading\n\nBody content");
});

describe("assembleSummary — concat-step-results mode", () => {

  it("3-step (completed / skipped / failed) → byte-for-byte expected output", () => {
    const stepResults = makeStepResults(
      ["step-a", { stepId: "step-a", taskId: "task-a", status: "completed", result: "step-a result", roleName: "RoleA" }],
      ["step-b", { stepId: "step-b", taskId: "task-b", status: "skipped", error: "Skipped: dependency failed" }],
      ["step-c", { stepId: "step-c", taskId: "task-c", status: "failed", error: "step-c error", roleName: "RoleC" }],
    );
    const result = assembleSummary({ executionId: "exec-1", template: makeTemplate(), stepResults });
    expect(result).toBe(`## [OK] Step: step-a (RoleA)

step-a result

---

## [SKIP] Step: step-b

Skipped: dependency failed

---

## [FAIL] Step: step-c (RoleC)

step-c error`);
  });

  it("completed-only step uses result verbatim", () => {
    const stepResults = makeStepResults(
      ["step-1", { stepId: "step-1", taskId: "task-1", status: "completed", result: "Final output here", roleName: "Engineer" }],
    );
    const result = assembleSummary({ executionId: "exec-1", template: makeTemplate(), stepResults });
    expect(result).toBe(`## [OK] Step: step-1 (Engineer)

Final output here`);
  });

  it("skipped-only step uses error field verbatim (not 'No output')", () => {
    const stepResults = makeStepResults(
      ["step-1", { stepId: "step-1", taskId: "task-1", status: "skipped", error: "Upstream step failed" }],
    );
    const result = assembleSummary({ executionId: "exec-1", template: makeTemplate(), stepResults });
    expect(result).toBe(`## [SKIP] Step: step-1

Upstream step failed`);
    expect(result).not.toContain("No output");
  });

  it("completed step with no result and no error → 'No output' sentinel", () => {
    const stepResults = makeStepResults(
      ["step-1", { stepId: "step-1", taskId: "task-1", status: "completed" }],
    );
    const result = assembleSummary({ executionId: "exec-1", template: makeTemplate(), stepResults });
    expect(result).toBe(`## [OK] Step: step-1

No output`);
  });

  it("step without roleName omits parentheses suffix", () => {
    const stepResults = makeStepResults(
      ["step-1", { stepId: "step-1", taskId: "task-1", status: "completed", result: "output" }],
    );
    const result = assembleSummary({ executionId: "exec-1", template: makeTemplate(), stepResults });
    expect(result).not.toContain("()");
  });

  it("empty stepResults returns empty string", () => {
    const result = assembleSummary({ executionId: "exec-1", template: makeTemplate(), stepResults: new Map() });
    expect(result).toBe("");
  });
});

describe("assembleSummary — primary-artifact mode", () => {

  it("json string artifact returns value verbatim", () => {
    artifactRows.push({ id: "art-1", executionId: "exec-1", stepId: "step-1", key: "body", kind: "json", value: "Hello world", sizeBytes: 12, createdAt: Date.now() });
    const template = makeTemplate({ config: { delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "step-1", key: "body" } } } as TaskConfig });
    const result = assembleSummary({ executionId: "exec-1", template, stepResults: new Map() });
    expect(result).toBe("Hello world");
  });

  it("json object artifact returns pretty JSON", () => {
    artifactRows.push({ id: "art-2", executionId: "exec-1", stepId: "step-1", key: "data", kind: "json", value: { foo: "bar", count: 42 }, sizeBytes: 20, createdAt: Date.now() });
    const template = makeTemplate({ config: { delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "step-1", key: "data" } } } as TaskConfig });
    const result = assembleSummary({ executionId: "exec-1", template, stepResults: new Map() });
    expect(result).toBe(`{
  "foo": "bar",
  "count": 42
}`);
  });

  it("file artifact with text/markdown mime returns file content", () => {
    vi.mocked(readFileSync).mockReturnValue("# Markdown\n\nContent here");
    artifactRows.push({ id: "art-3", executionId: "exec-1", stepId: "step-1", key: "report", kind: "file", blobPath: "/tmp/report.md", mime: "text/markdown", sizeBytes: 256, createdAt: Date.now() });
    const template = makeTemplate({ config: { delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "step-1", key: "report" } } } as TaskConfig });
    const result = assembleSummary({ executionId: "exec-1", template, stepResults: new Map() });
    expect(result).toBe("# Markdown\n\nContent here");
    expect(readFileSync).toHaveBeenCalledWith("/tmp/report.md", "utf-8");
  });

  it("file artifact with non-text mime throws descriptive error", () => {
    artifactRows.push({ id: "art-4", executionId: "exec-1", stepId: "step-1", key: "audio", kind: "file", blobPath: "/tmp/podcast.mp3", mime: "audio/mpeg", sizeBytes: 1024, createdAt: Date.now() });
    const template = makeTemplate({ config: { delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "step-1", key: "audio" } } } as TaskConfig });
    expect(() => assembleSummary({ executionId: "exec-1", template, stepResults: new Map() }))
      .toThrow(/not text-renderable/);
  });

  it("missing primary artifact throws PrimaryArtifactNotFoundError", () => {
    artifactRows.length = 0; // no artifacts at all
    const template = makeTemplate({ config: { delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "step-1", key: "body" } } } as TaskConfig });
    expect(() => assembleSummary({ executionId: "exec-1", template, stepResults: new Map() }))
      .toThrow(PrimaryArtifactNotFoundError);
  });
});

describe("assembleSummary — custom mode", () => {
  it("throws DeliveryNotImplementedError('custom')", () => {
    const template = makeTemplate({ config: { delivery: { mode: "custom" } } as TaskConfig });
    expect(() => assembleSummary({ executionId: "exec-1", template, stepResults: new Map() }))
      .toThrow(DeliveryNotImplementedError);
    try {
      assembleSummary({ executionId: "exec-1", template, stepResults: new Map() });
    } catch (err) {
      expect(err).toBeInstanceOf(DeliveryNotImplementedError);
      expect((err as DeliveryNotImplementedError).mode).toBe("custom");
    }
  });
});

describe("assembleSummaryFromDb", () => {

  it("reconstructs summary from execution + template + step_results_json", () => {
    executionRows.push({
      id: "exec-db-1",
      templateId: "tmpl-db-1",
      stepResultsJson: JSON.stringify([["s1", { stepId: "s1", taskId: "t1", status: "completed", result: "DB result", roleName: "DBRole" }]]),
    });
    templateRows.push({
      id: "tmpl-db-1",
      name: "DB Template",
      config: {},
      steps: [],
      trigger: { type: "manual" as const },
      enabled: true,
    });
    artifactRows.push({ id: "art-db-1", executionId: "exec-db-1", stepId: "s1", key: "out", kind: "file", blobPath: "/tmp/db-out.txt", mime: "text/plain", sizeBytes: 8, createdAt: Date.now() });

    const result = assembleSummaryFromDb("exec-db-1");
    expect(result).toBeDefined();
    expect(result!.summary).toContain("DB result");
    expect(result!.summary).toContain("DBRole");
    expect(result!.fileArtifacts).toHaveLength(1);
    expect(result!.fileArtifacts[0].id).toBe("art-db-1");
  });

  it("returns undefined when execution not found", () => {
    const result = assembleSummaryFromDb("nonexistent");
    expect(result).toBeUndefined();
  });

  it("returns undefined when step_results_json is absent", () => {
    executionRows.push({ id: "exec-no-json", templateId: "tmpl-db-1" });
    const result = assembleSummaryFromDb("exec-no-json");
    expect(result).toBeUndefined();
  });

  it("returns undefined when step_results_json is null", () => {
    executionRows.push({ id: "exec-null-json", templateId: "tmpl-db-1", stepResultsJson: null });
    const result = assembleSummaryFromDb("exec-null-json");
    expect(result).toBeUndefined();
  });

  it("returns undefined when template not found", () => {
    executionRows.push({ id: "exec-no-tmpl", templateId: "nonexistent-template", stepResultsJson: "[]" });
    const result = assembleSummaryFromDb("exec-no-tmpl");
    expect(result).toBeUndefined();
  });
});

describe("tryAssembleFallbackDelivery", () => {

  it("returns null when mode is not primary-artifact", () => {
    const template = makeTemplate({ config: { delivery: { mode: "concat-step-results" } } as TaskConfig });
    const stepResults = makeStepResults(["s1", { stepId: "s1", taskId: "t1", status: "failed", error: "oops" }]);
    const result = tryAssembleFallbackDelivery(
      { executionId: "exec-1", template, stepResults },
      "failed",
      (s) => `Failed: ${s}`,
    );
    expect(result).toBeNull();
  });

  it("returns partial delivery when primary-artifact resolves", () => {
    artifactRows.push({ id: "art-fb-1", executionId: "exec-fb-1", stepId: "s1", key: "body", kind: "json", value: "partial result", sizeBytes: 14, createdAt: Date.now() });
    const template = makeTemplate({ name: "Podcast Template", config: { delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "s1", key: "body" } } } as TaskConfig });
    const stepResults = makeStepResults(["s1", { stepId: "s1", taskId: "t1", status: "failed", error: "some steps failed" }]);
    const result = tryAssembleFallbackDelivery(
      { executionId: "exec-fb-1", template, stepResults },
      "failed",
      (s) => `Status: ${s}`,
    );
    expect(result).not.toBeNull();
    expect(result!.usedFallback).toBe(true);
    expect(result!.summary).toContain("partial result");
    expect(result!.summary).toContain("Status: failed");
    expect(result!.fileArtifacts).toHaveLength(0);
  });

  it("returns null when primary-artifact lookup fails (logs warning, does not throw)", () => {
    artifactRows.length = 0;
    const template = makeTemplate({ config: { delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "s1", key: "missing" } } } as TaskConfig });
    const stepResults = makeStepResults(["s1", { stepId: "s1", taskId: "t1", status: "failed", error: "oops" }]);
    const result = tryAssembleFallbackDelivery(
      { executionId: "exec-1", template, stepResults },
      "failed",
      (s) => `Failed: ${s}`,
    );
    expect(result).toBeNull();
  });
});

describe("Error class exports (backward compat)", () => {
  it("DeliveryNotImplementedError has correct name and mode", () => {
    const err = new DeliveryNotImplementedError("custom");
    expect(err.name).toBe("DeliveryNotImplementedError");
    expect(err.mode).toBe("custom");
    expect(err.message).toContain("custom");
  });

  it("PrimaryArtifactNotFoundError has stepId, key, availableKeys", () => {
    const err = new PrimaryArtifactNotFoundError("step-1", "body", ["other-key"]);
    expect(err.name).toBe("PrimaryArtifactNotFoundError");
    expect(err.stepId).toBe("step-1");
    expect(err.key).toBe("body");
    expect(err.availableKeys).toEqual(["other-key"]);
  });
});
