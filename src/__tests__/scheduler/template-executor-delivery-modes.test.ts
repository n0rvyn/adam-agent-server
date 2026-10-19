/**
 * Tests for assembleSummary three-mode branch coverage (Phase 2 DP-001 Option C).
 *
 * Verifies:
 * Case A — concat-step-results (legacy default): output matches existing format.
 * Case B — primary-artifact (json): resolved artifact body returned.
 * Case C — primary-artifact (file, text mime): file content returned.
 * Case D — primary-artifact key mismatch: throws PrimaryArtifactNotFoundError.
 * Case E — custom mode: throws DeliveryNotImplementedError.
 *
 * Uses the lifted free function from template-summary-assembler.ts (Phase 2).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// --- Hoisted mutable mock state ---
const { artifactRows } = vi.hoisted(() => {
  const artifactRows: Array<{
    id: string;
    executionId: string;
    stepId: string;
    key: string;
    kind: "json" | "file";
    value?: unknown;
    blobPath?: string;
    mime?: string;
    originalFilename?: string;
    sizeBytes: number;
    createdAt: number;
  }> = [];
  return { artifactRows };
});

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/index.js", () => ({
  getDefaults: () => ({
    timeout: 600,
    maxTurns: 100,
    maxBudgetUsd: 5.0,
    effort: "high" as const,
    model: "claude-sonnet-4-6",
    settingSources: ["project"],
    allowedTools: [],
    disallowedTools: [],
    approvalRequired: [],
    approvalTimeout: 300,
    env: {},
  }),
}));

vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn(() => artifactRows),
}));

vi.mock("../../store/role-workspace.js", () => ({
  ensureRoleWorkspace: vi.fn(),
  getRoleWorkspacePath: vi.fn(),
  writeRoleCLAUDEmd: vi.fn(),
  syncRoleSettings: vi.fn(),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readFileSync: vi.fn().mockReturnValue("# Heading\n\nBody content"),
  };
});

import { readFileSync } from "node:fs";
import { assembleSummary, DeliveryNotImplementedError, PrimaryArtifactNotFoundError } from "../../scheduler/template-summary-assembler.js";
import type { TaskTemplate, TaskConfig, StepResult } from "../../shared/types.js";

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
  artifactRows.length = 0;
  vi.mocked(readFileSync).mockReset().mockReturnValue("# Heading\n\nBody content");
});

// ---------------------------------------------------------------------------
// Helper: build AssembleSummaryInput for assembleSummary
// ---------------------------------------------------------------------------
function makeTemplate(
  templateOverrides: Partial<TaskTemplate> = {},
): TaskTemplate {
  return {
    id: "tmpl-test",
    name: "Test Template",
    config: {},
    steps: [],
    trigger: { type: "manual" as const },
    enabled: true,
    ...templateOverrides,
  } as TaskTemplate;
}

function assemble(
  template: TaskTemplate,
  stepResults: Map<string, StepResult>,
  executionId = "exec-test",
): string {
  return assembleSummary({ executionId, template, stepResults });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("assembleSummary — three-mode branch coverage", () => {

  // Case A — concat-step-results (legacy default)
  it("Case A: concat-step-results outputs existing format verbatim", () => {
    const stepResults = new Map<string, StepResult>();
    stepResults.set("step-1", { stepId: "step-1", taskId: "task-1", status: "completed", result: "step-a result content", roleName: "RoleA" });
    stepResults.set("step-2", { stepId: "step-2", taskId: "task-2", status: "skipped", error: "Skipped: dependency failed" });
    stepResults.set("step-3", { stepId: "step-3", taskId: "task-3", status: "failed", error: "step-c error message", roleName: "RoleC" });

    const result = assemble(makeTemplate(), stepResults);

    const expected = `## [OK] Step: step-1 (RoleA)

step-a result content

---

## [SKIP] Step: step-2

Skipped: dependency failed

---

## [FAIL] Step: step-3 (RoleC)

step-c error message`;
    expect(result).toBe(expected);
  });

  // Case B — primary-artifact, json kind
  it("Case B: primary-artifact (json) returns stringified value", () => {
    artifactRows.push({
      id: "art-1",
      executionId: "exec-test",
      stepId: "step-1",
      key: "body",
      kind: "json",
      value: "Hello world",
      sizeBytes: 12,
      createdAt: Date.now(),
    });

    const template = makeTemplate({
      config: { delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "step-1", key: "body" } } } as TaskConfig,
    });

    const result = assemble(template, new Map());
    expect(result).toBe("Hello world");
  });

  it("Case B variant: primary-artifact (json, non-string value) returns pretty JSON", () => {
    artifactRows.push({
      id: "art-2",
      executionId: "exec-test",
      stepId: "step-1",
      key: "data",
      kind: "json",
      value: { foo: "bar", count: 42 },
      sizeBytes: 20,
      createdAt: Date.now(),
    });

    const template = makeTemplate({
      config: { delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "step-1", key: "data" } } } as TaskConfig,
    });

    const result = assemble(template, new Map());
    expect(result).toBe(`{
  "foo": "bar",
  "count": 42
}`);
  });

  // Case C — primary-artifact, file kind with text mime
  it("Case C: primary-artifact (file, text/markdown) returns file content", () => {
    artifactRows.push({
      id: "art-3",
      executionId: "exec-test",
      stepId: "step-1",
      key: "script",
      kind: "file",
      blobPath: "/tmp/test.md",
      mime: "text/markdown",
      sizeBytes: 256,
      createdAt: Date.now(),
    });

    const template = makeTemplate({
      config: { delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "step-1", key: "script" } } } as TaskConfig,
    });

    const result = assemble(template, new Map());
    expect(result).toBe("# Heading\n\nBody content");
    expect(readFileSync).toHaveBeenCalledWith("/tmp/test.md", "utf-8");
  });

  it("Case C variant: primary-artifact (file, .md extension but no mime) is text-renderable", () => {
    artifactRows.push({
      id: "art-4",
      executionId: "exec-test",
      stepId: "step-1",
      key: "podcast-script-final",
      kind: "file",
      blobPath: "/tmp/podcast.md",
      mime: undefined,
      originalFilename: "final-script.md",
      sizeBytes: 1024,
      createdAt: Date.now(),
    });
    vi.mocked(readFileSync).mockImplementation(() => "Script content here");

    const template = makeTemplate({
      config: { delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "step-1", key: "podcast-script-final" } } } as TaskConfig,
    });

    const result = assemble(template, new Map());
    expect(result).toBe("Script content here");
  });

  // Case D — primary-artifact key mismatch
  it("Case D: primary-artifact key mismatch throws PrimaryArtifactNotFoundError", () => {
    artifactRows.push({
      id: "art-5",
      executionId: "exec-test",
      stepId: "step-1",
      key: "wrong-key",
      kind: "json",
      value: "something",
      sizeBytes: 9,
      createdAt: Date.now(),
    });

    const template = makeTemplate({
      config: { delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "step-1", key: "missing-key" } } } as TaskConfig,
    });

    expect(() => assemble(template, new Map())).toThrow(PrimaryArtifactNotFoundError);
    try {
      assemble(template, new Map());
    } catch (err) {
      expect((err as PrimaryArtifactNotFoundError).stepId).toBe("step-1");
      expect((err as PrimaryArtifactNotFoundError).key).toBe("missing-key");
      expect((err as PrimaryArtifactNotFoundError).availableKeys).toEqual(["wrong-key"]);
    }
  });

  it("Case D variant: no artifacts at all for the step throws PrimaryArtifactNotFoundError with empty availableKeys", () => {
    // artifactRows is empty
    const template = makeTemplate({
      config: { delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "step-1", key: "body" } } } as TaskConfig,
    });

    expect(() => assemble(template, new Map())).toThrow(PrimaryArtifactNotFoundError);
    try {
      assemble(template, new Map());
    } catch (err) {
      expect((err as PrimaryArtifactNotFoundError).stepId).toBe("step-1");
      expect((err as PrimaryArtifactNotFoundError).key).toBe("body");
      expect((err as PrimaryArtifactNotFoundError).availableKeys).toEqual([]);
    }
  });

  // Case E — custom mode
  it("Case E: custom mode throws DeliveryNotImplementedError", () => {
    const template = makeTemplate({
      config: { delivery: { mode: "custom" } } as Partial<TaskConfig> & { delivery: { mode: string } },
    });

    expect(() => assemble(template, new Map())).toThrow(DeliveryNotImplementedError);
    try {
      assemble(template, new Map());
    } catch (err) {
      expect((err as DeliveryNotImplementedError).mode).toBe("custom");
      expect((err as Error).message).toContain("not implemented");
    }
  });

  // Case F — primary-artifact key omitted, step.outputAs declared → key auto-derived
  it("Case F: primary-artifact omits key, step has outputAs → key derived from step.outputAs", () => {
    artifactRows.push({
      id: "art-5",
      executionId: "exec-test",
      stepId: "step-writer",
      key: "最终逐字稿",
      kind: "file",
      blobPath: "/tmp/最终逐字稿.md",
      sizeBytes: 30,
      createdAt: Date.now(),
    });

    const template = makeTemplate({
      steps: [{
        id: "step-writer",
        prompt: "写播客脚本",
        outputAs: "最终逐字稿",
        roleId: "role-test",
      }] as TaskTemplate["steps"],
      config: {
        // key is deliberately absent — server derives it from step.outputAs
        delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "step-writer" } },
      } as TaskConfig,
    });

    const result = assemble(template, new Map());
    // The readFileSync mock returns "# Heading\n\nBody content" for file artifacts.
    // With the completeness banner prepended (no other gaps since step-writer has a file artifact):
    // "⚠️ 本期音频缺失\n原因: step-writer 步骤的 最终逐字稿 产出被标记为 no_content\n..."
    // Wait — step-writer IS the only step; with a file artifact there are no gaps.
    // Banner is empty; body is just the file content.
    expect(result).toBe("# Heading\n\nBody content");
  });

  // Case G — primary-artifact key omitted, step has no outputAs → throws PrimaryArtifactNotFoundError
  it("Case G: primary-artifact omits key, step has no outputAs → throws with descriptive message", () => {
    const template = makeTemplate({
      steps: [{
        id: "step-legacy",
        prompt: "Do something",
        // No outputAs declared
        roleId: "role-test",
      }] as TaskTemplate["steps"],
      config: {
        delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "step-legacy" } },
      } as TaskConfig,
    });

    expect(() => assemble(template, new Map())).toThrow(PrimaryArtifactNotFoundError);
    try {
      assemble(template, new Map());
    } catch (err) {
      expect((err as PrimaryArtifactNotFoundError).stepId).toBe("step-legacy");
      // No key was specified and no outputAs to derive from → PrimaryArtifactNotFoundError with empty key
      expect((err as PrimaryArtifactNotFoundError).key).toBe("");
    }
  });

  // Case H — primary-artifact explicit key still works (override path)
  it("Case H: primary-artifact explicit key overrides step.outputAs", () => {
    // The override artifact (this is the delivery target per template config)
    artifactRows.push({
      id: "art-6",
      executionId: "exec-test",
      stepId: "step-override",
      key: "custom-key-override",
      kind: "file",
      blobPath: "/tmp/custom-key-override.txt",
      sizeBytes: 25,
      createdAt: Date.now(),
    });
    // Also seed the step's declared outputAs artifact — in production, the step's
    // role always publishes its outputAs even when delivery picks a different key.
    // Without this, the new delivery-completeness chokepoint (Bug B fix) would
    // report a gap and prepend an "⚠️ 本期音频缺失" banner to the body, masking
    // the test's actual intent (verify that delivery.key takes precedence over step.outputAs).
    artifactRows.push({
      id: "art-6b",
      executionId: "exec-test",
      stepId: "step-override",
      key: "normal-output",
      kind: "file",
      blobPath: "/tmp/normal-output.txt",
      sizeBytes: 25,
      createdAt: Date.now(),
    });

    const template = makeTemplate({
      steps: [{
        id: "step-override",
        prompt: "Write script",
        outputAs: "normal-output",
        roleId: "role-test",
      }] as TaskTemplate["steps"],
      config: {
        // Explicit key overrides step.outputAs
        delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "step-override", key: "custom-key-override" } },
      } as TaskConfig,
    });

    const result = assemble(template, new Map());
    // The readFileSync mock returns "# Heading\n\nBody content" for file artifacts.
    expect(result).toBe("# Heading\n\nBody content");
  });

});
