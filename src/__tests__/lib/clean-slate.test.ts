import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
}));

const { cleanup } = setupTestDb();

// Run cleanup once at the end of the file, not per-test.
// Calling cleanup (which closes the DB) in afterEach causes "database not open" in subsequent tests.
afterAll(() => {
  cleanup();
});

/** Seed a minimal template + execution chain so FK constraints pass. */
function seedTemplateAndExecution(db: ReturnType<typeof getTestDb>, execId: string): void {
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO task_templates
      (id, name, trigger_type, steps, enabled, created_at, retry_policy)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("tmpl-seed-1", "Seed Template", "manual", "[]", 1, now, null);

  db.prepare(`
    INSERT OR IGNORE INTO template_executions
      (id, template_id, status, step_statuses, started_at, step_results_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(execId, "tmpl-seed-1", "running", "{}", now, null);
}

describe("cleanSlatePriorAttempt", () => {
  let tmp: string;

  afterEach(() => {
    clearTestDb();
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "clean-slate-"));
  });

  it("only removes target step's artifacts — other steps' artifacts remain", async () => {
    const db = getTestDb();
    const execId = "exec-clean-1";
    seedTemplateAndExecution(db, execId);

    // Insert 3 artifact rows: 2 for stepA, 1 for stepB
    db.prepare(`
      INSERT INTO artifacts
        (id, source_kind, execution_id, step_id, role_id, key, kind, size_bytes, created_at, blob_path)
      VALUES (?, 'template_step', ?, ?, 'test-role', ?, ?, ?, ?, ?)
    `).run("art-1", execId, "stepA", "key1", "file", 100, Date.now(), join(tmp, "art1.bin"));
    db.prepare(`
      INSERT INTO artifacts
        (id, source_kind, execution_id, step_id, role_id, key, kind, size_bytes, created_at, blob_path)
      VALUES (?, 'template_step', ?, ?, 'test-role', ?, ?, ?, ?, ?)
    `).run("art-2", execId, "stepA", "key2", "file", 200, Date.now(), join(tmp, "art2.bin"));
    db.prepare(`
      INSERT INTO artifacts
        (id, source_kind, execution_id, step_id, role_id, key, kind, size_bytes, created_at, blob_path)
      VALUES (?, 'template_step', ?, ?, 'test-role', ?, ?, ?, ?, ?)
    `).run("art-3", execId, "stepB", "key3", "file", 300, Date.now(), join(tmp, "art3.bin"));

    writeFileSync(join(tmp, "art1.bin"), "a");
    writeFileSync(join(tmp, "art2.bin"), "b");
    writeFileSync(join(tmp, "art3.bin"), "c");

    const { cleanSlatePriorAttempt } = await import("../../lib/artifact-storage.js");
    const result = await cleanSlatePriorAttempt(execId, "stepA");

    expect(result.deletedRows).toBe(2);
    expect(result.deletedFiles).toBe(2);

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(tmp, "art1.bin"))).toBe(false);
    expect(existsSync(join(tmp, "art2.bin"))).toBe(false);
    expect(existsSync(join(tmp, "art3.bin"))).toBe(true); // stepB untouched

    const remaining = db.prepare(
      "SELECT id FROM artifacts WHERE execution_id = ?",
    ).all(execId) as Array<{ id: string }>;
    expect(remaining.map((r) => r.id)).toEqual(["art-3"]);
  });

  it("idempotent — calling twice on same step returns 0 on second call", async () => {
    const db = getTestDb();
    const execId = "exec-clean-2";
    seedTemplateAndExecution(db, execId);

    db.prepare(`
      INSERT INTO artifacts
        (id, source_kind, execution_id, step_id, role_id, key, kind, size_bytes, created_at, blob_path)
      VALUES (?, 'template_step', ?, ?, 'test-role', ?, ?, ?, ?, ?)
    `).run("art-single", execId, "stepX", "keyX", "file", 50, Date.now(), join(tmp, "single.bin"));
    writeFileSync(join(tmp, "single.bin"), "x");

    const { cleanSlatePriorAttempt } = await import("../../lib/artifact-storage.js");
    const first = await cleanSlatePriorAttempt(execId, "stepX");
    expect(first.deletedRows).toBe(1);
    expect(first.deletedFiles).toBe(1);

    const second = await cleanSlatePriorAttempt(execId, "stepX");
    expect(second.deletedRows).toBe(0);
    expect(second.deletedFiles).toBe(0);
  });

  it("missing blob file handled gracefully (deletedRows >= 1, deletedFiles may be < deletedRows)", async () => {
    const db = getTestDb();
    const execId = "exec-clean-3";
    seedTemplateAndExecution(db, execId);

    // Art-4 row exists but the .bin file does not
    const missingPath = join(tmp, "missing-art.bin");
    db.prepare(`
      INSERT INTO artifacts
        (id, source_kind, execution_id, step_id, role_id, key, kind, size_bytes, created_at, blob_path)
      VALUES (?, 'template_step', ?, ?, 'test-role', ?, ?, ?, ?, ?)
    `).run("art-missing", execId, "stepY", "keyY", "file", 50, Date.now(), missingPath);
    // Do NOT create the file — simulating already-deleted blob

    const { cleanSlatePriorAttempt } = await import("../../lib/artifact-storage.js");
    const result = await cleanSlatePriorAttempt(execId, "stepY");

    expect(result.deletedRows).toBe(1); // row still deleted from DB
    expect(result.deletedFiles).toBe(0); // file was already gone
  });
});
