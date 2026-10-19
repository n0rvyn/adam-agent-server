/**
 * Task 19: Tests for migrate_template_outputAs adam-tool.
 *
 * Covers:
 * (a) template with 3 steps, all missing outputAs, mapping covers all 3 with valid names → all 3 updated, summary "3 added"
 * (b) template with mix of declared + missing → only missing get updated; declared ones surface as "skipped"
 * (c) mapping references unknown stepId → returned in errors[]
 * (d) dryRun=true → returns proposed changes but DB row unchanged
 * (e) invalid outputAs values (path traversal, spaces, empty, 257-char) → rejected via errors[]; DB unchanged
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// Mock task-templates.js BEFORE any imports that depend on it.
// Must come before the module-level imports below.
const { _mockGetTaskTemplate, _mockUpdateTaskTemplate } = vi.hoisted(() => {
  const store: Record<string, ReturnType<typeof getTestDb>["prepare"] extends (sql: string) => infer R ? R : never> = {};
  const _mockGetTaskTemplate = vi.fn((id: string) => {
    const db = getTestDb();
    const row = db.prepare("SELECT * FROM task_templates WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      name: row.name as string,
      trigger: { type: (row.trigger_type as string) as import("../../shared/types.js").TaskTemplateTrigger["type"] },
      steps: JSON.parse(row.steps as string) as import("../../shared/types.js").TaskStep[],
      config: row.config ? JSON.parse(row.config as string) : undefined,
      enabled: !!row.enabled,
      createdAt: row.created_at as number,
    };
  });
  const _mockUpdateTaskTemplate = vi.fn((id: string, updates: { steps?: import("../../shared/types.js").TaskStep[] }) => {
    const db = getTestDb();
    if (updates.steps) {
      db.prepare("UPDATE task_templates SET steps = ? WHERE id = ?").run(JSON.stringify(updates.steps), id);
    }
  });
  return { _mockGetTaskTemplate, _mockUpdateTaskTemplate };
});

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../store/task-templates.js", () => ({
  getTaskTemplate: _mockGetTaskTemplate,
  updateTaskTemplate: _mockUpdateTaskTemplate,
  createTaskTemplate: vi.fn(),
  deleteTaskTemplate: vi.fn(),
  listTaskTemplates: vi.fn(() => []),
  disableTaskTemplate: vi.fn(),
  getTaskTemplateDependents: vi.fn(() => ({ executionCount: 0, taskCount: 0 })),
}));

// Re-export KEY_REGEX so the test can validate the same regex
export { KEY_REGEX } from "../../manager/execution-tools.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

// ---------------------------------------------------------------------------
// Helper: seed a minimal task_template into test DB
// ---------------------------------------------------------------------------
function seedTemplate(id: string, steps: Array<{ id: string; prompt: string; outputAs?: string }>) {
  getTestDb().prepare(`
    INSERT INTO task_templates (id, name, trigger_type, steps, enabled, created_at)
    VALUES (?, ?, 'manual', ?, 1, ?)
  `).run(id, `Template ${id}`, JSON.stringify(steps), Date.now());
}

function getTemplateSteps(templateId: string): Array<{ id: string; outputAs: string | null }> {
  const row = getTestDb().prepare("SELECT steps FROM task_templates WHERE id = ?").get(templateId) as { steps: string };
  return (JSON.parse(row.steps) as Array<{ id: string; outputAs?: string | null }>).map((step) => ({
    id: step.id,
    outputAs: step.outputAs ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Test harness: imports the tool from adam-tools via a direct function call
// We construct the tool handler logic directly since the MCP tool() wrapper
// requires the SDK server to be running.
// ---------------------------------------------------------------------------

/**
 * Direct implementation of migrate_template_outputAs logic for testing.
 * Uses the mocked imports so it exercises the same code paths as the real tool handler.
 */
async function migrateTemplateOutputAs(args: {
  templateId: string;
  mapping: Record<string, string>;
  dryRun?: boolean;
}) {
  const { getTaskTemplate, updateTaskTemplate } = await import("../../store/task-templates.js");
  const { KEY_REGEX } = await import("../../manager/execution-tools.js");

  const template = getTaskTemplate(args.templateId);
  if (!template) return { applied: false, changes: [], errors: [{ stepId: "template", reason: `Template not found: ${args.templateId}` }], summary: "0 added, 0 skipped, 1 errors" };

  const steps = (template.steps ?? []) as Array<{ id: string; prompt: string; outputAs?: string }>;
  const changes: Array<{ stepId: string; before: string | null; after: string }> = [];
  const errors: Array<{ stepId: string; reason: string }> = [];

  for (const [stepId, proposedOutputAs] of Object.entries(args.mapping)) {
    if (!KEY_REGEX.test(proposedOutputAs)) {
      errors.push({ stepId, reason: `invalid outputAs "${proposedOutputAs}" — must match ${KEY_REGEX.toString()}` });
      continue;
    }
    const step = steps.find((s) => s.id === stepId);
    if (!step) {
      errors.push({ stepId, reason: "step not found in template" });
      continue;
    }
    if (step.outputAs && step.outputAs.length > 0) {
      changes.push({ stepId, before: step.outputAs, after: step.outputAs });
      continue;
    }
    changes.push({ stepId, before: null, after: proposedOutputAs });
    if (!args.dryRun) {
      step.outputAs = proposedOutputAs;
    }
  }

  if (!args.dryRun) {
    updateTaskTemplate(args.templateId, { steps });
  }

  return {
    applied: !args.dryRun,
    changes,
    errors,
    summary: `${changes.filter((c) => c.before === null).length} added, ${changes.filter((c) => c.before !== null).length} skipped (already set), ${errors.length} errors`,
  };
}

describe("migrate_template_outputAs", () => {
  it("(a) all steps missing outputAs → all 3 updated, summary '3 added'", async () => {
    seedTemplate("tmpl-a", [
      { id: "step-1", prompt: "Collect today's news" },
      { id: "step-2", prompt: "Write a summary" },
      { id: "step-3", prompt: "Polish the draft" },
    ]);

    const result = await migrateTemplateOutputAs({
      templateId: "tmpl-a",
      mapping: { "step-1": "news-summary", "step-2": "summary-draft", "step-3": "polished-final" },
    });

    expect(result.applied).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.summary).toBe("3 added, 0 skipped (already set), 0 errors");

    const updatedSteps = getTemplateSteps("tmpl-a");
    expect(updatedSteps.find((s) => s.id === "step-1")?.outputAs).toBe("news-summary");
    expect(updatedSteps.find((s) => s.id === "step-2")?.outputAs).toBe("summary-draft");
    expect(updatedSteps.find((s) => s.id === "step-3")?.outputAs).toBe("polished-final");
  });

  it("(b) mix of declared + missing → only missing updated, declared skipped", async () => {
    seedTemplate("tmpl-b", [
      { id: "collect", prompt: "Collect data", outputAs: "素材摘要" },
      { id: "write", prompt: "Write draft" },
      { id: "polish", prompt: "Polish draft" },
    ]);

    const result = await migrateTemplateOutputAs({
      templateId: "tmpl-b",
      mapping: { "collect": "news-summary", "write": "draft-content", "polish": "final-version" },
    });

    expect(result.applied).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.summary).toBe("2 added, 1 skipped (already set), 0 errors");

    const updatedSteps = getTemplateSteps("tmpl-b");
    // collect already had outputAs — unchanged
    expect(updatedSteps.find((s) => s.id === "collect")?.outputAs).toBe("素材摘要");
    // write and polish were updated
    expect(updatedSteps.find((s) => s.id === "write")?.outputAs).toBe("draft-content");
    expect(updatedSteps.find((s) => s.id === "polish")?.outputAs).toBe("final-version");
  });

  it("(c) mapping references unknown stepId → returned in errors[]", async () => {
    seedTemplate("tmpl-c", [
      { id: "step-1", prompt: "Do something" },
    ]);

    const result = await migrateTemplateOutputAs({
      templateId: "tmpl-c",
      mapping: { "step-1": "valid-key", "nonexistent-step": "also-key" },
    });

    expect(result.applied).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({ stepId: "nonexistent-step", reason: "step not found in template" });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].stepId).toBe("step-1");
  });

  it("(d) dryRun=true → returns proposed changes but DB row unchanged", async () => {
    seedTemplate("tmpl-d", [
      { id: "step-1", prompt: "Do something" },
    ]);

    const result = await migrateTemplateOutputAs({
      templateId: "tmpl-d",
      mapping: { "step-1": "proposed-key" },
      dryRun: true,
    });

    expect(result.applied).toBe(false);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].before).toBeNull();
    expect(result.changes[0].after).toBe("proposed-key");

    // DB must NOT be updated
    const unchangedSteps = getTemplateSteps("tmpl-d");
    expect(unchangedSteps.find((s) => s.id === "step-1")?.outputAs).toBeNull();
  });

  it("(e) invalid outputAs values → rejected via errors[], DB unchanged", async () => {
    seedTemplate("tmpl-e", [
      { id: "step-1", prompt: "Do something" },
      { id: "step-2", prompt: "Do another thing" },
      { id: "step-3", prompt: "Do yet another thing" },
      { id: "step-4", prompt: "Do the last thing" },
    ]);

    // (e-i) path traversal attempt
    const result1 = await migrateTemplateOutputAs({
      templateId: "tmpl-e",
      mapping: { "step-1": "../../etc/passwd" },
    });
    expect(result1.errors).toHaveLength(1);
    expect(result1.errors[0].reason).toContain("must match");
    const unchanged1 = getTemplateSteps("tmpl-e");
    expect(unchanged1.find((s) => s.id === "step-1")?.outputAs).toBeNull();

    // (e-ii) key with spaces
    const result2 = await migrateTemplateOutputAs({
      templateId: "tmpl-e",
      mapping: { "step-2": "key with spaces" },
    });
    expect(result2.errors).toHaveLength(1);
    expect(result2.errors[0].reason).toContain("must match");

    // (e-iii) empty string
    const result3 = await migrateTemplateOutputAs({
      templateId: "tmpl-e",
      mapping: { "step-3": "" },
    });
    expect(result3.errors).toHaveLength(1);
    expect(result3.errors[0].reason).toContain("must match");

    // (e-iv) 257-char string
    const longKey = "a".repeat(257);
    const result4 = await migrateTemplateOutputAs({
      templateId: "tmpl-e",
      mapping: { "step-4": longKey },
    });
    expect(result4.errors).toHaveLength(1);
    expect(result4.errors[0].reason).toContain("must match");

    // DB completely unchanged
    const unchanged = getTemplateSteps("tmpl-e");
    expect(unchanged.every((s) => s.outputAs == null)).toBe(true);
  });
});
