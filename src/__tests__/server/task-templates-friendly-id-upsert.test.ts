import { describe, it, expect, vi } from "vitest";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";

// CRITICAL: mock store/db.js BEFORE importing anything that calls getDb().
// Without this, createTaskTemplate would touch ~/.adam/adam.db (production DB).
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Imported AFTER vi.mock so the mocked getDb is wired up.
import { createTaskTemplate, getTaskTemplate, listTaskTemplates } from "../../store/task-templates.js";
import type { TaskTemplate } from "../../shared/types.js";

const baseTemplate = (id: string): TaskTemplate => ({
  id,
  name: `Template ${id}`,
  trigger: { type: "manual" },
  steps: [{ id: "s1", prompt: "/inbox" }],
  rolePreference: "达芬奇",
  enabled: true,
  createdAt: Date.now(),
});

describe("task templates: friendly id + INSERT OR IGNORE upsert", () => {
  it("creates a row with a user-supplied friendly id (not a UUID)", () => {
    const { cleanup } = setupTestDb();
    try {
      const t = baseTemplate("pkos-scan-and-sync");
      const result = createTaskTemplate(t);
      expect(result.changes).toBe(1);

      const stored = getTaskTemplate("pkos-scan-and-sync");
      expect(stored?.id).toBe("pkos-scan-and-sync");
      expect(stored?.name).toBe("Template pkos-scan-and-sync");
    } finally {
      cleanup();
    }
  });

  it("re-importing the same friendly id is idempotent — preserves existing row", () => {
    const { cleanup } = setupTestDb();
    try {
      const original = baseTemplate("pkos-scan-and-sync");
      const first = createTaskTemplate(original);
      expect(first.changes).toBe(1);

      // Re-import (simulates yaml plugin re-import with same id and yaml content)
      const second = createTaskTemplate(original);
      expect(second.changes).toBe(0); // INSERT OR IGNORE skipped — row preserved

      const stored = getTaskTemplate("pkos-scan-and-sync");
      expect(stored?.name).toBe("Template pkos-scan-and-sync");
    } finally {
      cleanup();
    }
  });

  it("re-running yaml import multiple times does not produce duplicates", () => {
    const { cleanup } = setupTestDb();
    try {
      const ids = ["pkos-scan-and-sync", "pkos-inbox-ripple-workflow", "pkos-news-podcast-workflow"];
      const tpls = ids.map(baseTemplate);

      for (const t of tpls) createTaskTemplate(t);
      for (const t of tpls) createTaskTemplate(t); // re-import
      for (const t of tpls) createTaskTemplate(t); // and again

      const all = listTaskTemplates();
      const matching = all.filter(x => ids.includes(x.id));
      expect(matching).toHaveLength(3); // not 9
    } finally {
      cleanup();
    }
  });

  it("does NOT overwrite user customizations on re-import (preserve semantics)", () => {
    const { cleanup } = setupTestDb();
    try {
      // First import (yaml-shipped content)
      const original = baseTemplate("pkos-scan-and-sync");
      createTaskTemplate(original);

      // User customizes the row directly via DB (simulates UI edit, etc.)
      getTestDb().prepare("UPDATE task_templates SET name = ?, enabled = 0 WHERE id = ?")
        .run("My Custom Name", "pkos-scan-and-sync");

      // Plugin yaml re-imports with the original (un-customized) content
      const reimport = createTaskTemplate(original);
      expect(reimport.changes).toBe(0);

      // User's customization survives — INSERT OR IGNORE never overwrites
      const stored = getTaskTemplate("pkos-scan-and-sync");
      expect(stored?.name).toBe("My Custom Name");
      expect(stored?.enabled).toBe(false);
    } finally {
      cleanup();
    }
  });
});
