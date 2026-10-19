/**
 * Schema v82 migration tests — belief data normalization (post-review-fix data residue).
 *
 * v82 is a data-only migration: 2 UPDATE statements + schema_version bump. Tested at the
 * statement level on a minimal v82-shape DB rather than through the full runMigrations chain
 * (the chain zeroes last_used_at during v81 and disturbs ::pool data shape, masking v82's effect).
 *
 * Verifies:
 * 1. scope_key LIKE '%::pool' rows are normalized to NULL (frees belief-injection from band-aid)
 * 2. last_used_at > 1e9 (ms-timestamp residue from bug #2) clamped to per-role task_seq
 * 3. Niche scopes and small last_used_at values are not touched
 * 4. The UPDATE statements are idempotent (re-running has no effect)
 * 5. Full-chain integration: db-migration-v81 test reaches schema_version 82
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

/**
 * Seed a minimal v82-shape DB (post-v81 schema with the v82 data residue scenario).
 */
function seedV82TargetShape(db: Database.Database): void {
  db.exec(`
    CREATE TABLE roles (
      id TEXT PRIMARY KEY,
      task_seq INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE beliefs (
      id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL,
      scope_key TEXT,
      last_used_at INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.prepare("INSERT INTO roles (id, task_seq) VALUES (?, ?)").run("role-alpha", 42);
  db.prepare("INSERT INTO roles (id, task_seq) VALUES (?, ?)").run("role-beta", 7);

  // Legacy ::pool scope_key — v82 normalizes to NULL.
  db.prepare("INSERT INTO beliefs (id, role_id, scope_key, last_used_at) VALUES (?, ?, ?, ?)")
    .run("b-pool-1", "role-alpha", "role-alpha::pool", 10);
  db.prepare("INSERT INTO beliefs (id, role_id, scope_key, last_used_at) VALUES (?, ?, ?, ?)")
    .run("b-pool-2", "role-beta", "role-beta::pool", 3);

  // Niche scope — v82 leaves it alone.
  db.prepare("INSERT INTO beliefs (id, role_id, scope_key, last_used_at) VALUES (?, ?, ?, ?)")
    .run("b-niche", "role-alpha", "role-alpha::tts", 5);

  // ms-timestamp residue (bug #2): last_used_at as Date.now() ~ 1.7e12.
  db.prepare("INSERT INTO beliefs (id, role_id, scope_key, last_used_at) VALUES (?, ?, ?, ?)")
    .run("b-ms-residue", "role-alpha", null, 1700000050000);

  // Bug #2 residue for a role missing from roles table (defensive case for the COALESCE).
  db.prepare("INSERT INTO beliefs (id, role_id, scope_key, last_used_at) VALUES (?, ?, ?, ?)")
    .run("b-orphan", "role-missing", null, 1700000050000);

  // Clean data — v82 must not touch.
  db.prepare("INSERT INTO beliefs (id, role_id, scope_key, last_used_at) VALUES (?, ?, ?, ?)")
    .run("b-clean", "role-alpha", null, 20);
}

/** v82's two UPDATE statements, extracted for direct testing. */
function applyV82Statements(db: Database.Database): { pooled: number; clamped: number } {
  const poolUpdate = db.prepare(
    "UPDATE beliefs SET scope_key = NULL WHERE scope_key LIKE '%::pool'"
  ).run();
  const clampUpdate = db.prepare(
    "UPDATE beliefs SET last_used_at = COALESCE((SELECT task_seq FROM roles WHERE roles.id = beliefs.role_id), 0) WHERE last_used_at > 1000000000"
  ).run();
  return { pooled: poolUpdate.changes, clamped: clampUpdate.changes };
}

describe("Schema v82 data normalization (statement-level)", () => {
  it("normalizes legacy ::pool scope_key to NULL", () => {
    const db = new Database(":memory:");
    seedV82TargetShape(db);
    const { pooled } = applyV82Statements(db);

    expect(pooled).toBe(2);
    const pool1 = db.prepare("SELECT scope_key FROM beliefs WHERE id = ?").get("b-pool-1") as { scope_key: string | null };
    const pool2 = db.prepare("SELECT scope_key FROM beliefs WHERE id = ?").get("b-pool-2") as { scope_key: string | null };
    expect(pool1.scope_key).toBeNull();
    expect(pool2.scope_key).toBeNull();
  });

  it("leaves niche-scoped beliefs untouched", () => {
    const db = new Database(":memory:");
    seedV82TargetShape(db);
    applyV82Statements(db);

    const niche = db.prepare("SELECT scope_key FROM beliefs WHERE id = ?").get("b-niche") as { scope_key: string | null };
    expect(niche.scope_key).toBe("role-alpha::tts");
  });

  it("clamps ms-timestamp last_used_at to per-role task_seq", () => {
    const db = new Database(":memory:");
    seedV82TargetShape(db);
    const { clamped } = applyV82Statements(db);

    expect(clamped).toBe(2); // b-ms-residue + b-orphan
    const row = db.prepare("SELECT last_used_at FROM beliefs WHERE id = ?").get("b-ms-residue") as { last_used_at: number };
    expect(row.last_used_at).toBe(42); // role-alpha.task_seq
  });

  it("clamps orphan-role residue to 0 (COALESCE fallback)", () => {
    const db = new Database(":memory:");
    seedV82TargetShape(db);
    applyV82Statements(db);

    const orphan = db.prepare("SELECT last_used_at FROM beliefs WHERE id = ?").get("b-orphan") as { last_used_at: number };
    expect(orphan.last_used_at).toBe(0);
  });

  it("leaves small last_used_at values untouched", () => {
    const db = new Database(":memory:");
    seedV82TargetShape(db);
    applyV82Statements(db);

    const clean = db.prepare("SELECT last_used_at FROM beliefs WHERE id = ?").get("b-clean") as { last_used_at: number };
    expect(clean.last_used_at).toBe(20);
    const niche = db.prepare("SELECT last_used_at FROM beliefs WHERE id = ?").get("b-niche") as { last_used_at: number };
    expect(niche.last_used_at).toBe(5);
  });

  it("statements are idempotent (second apply changes 0 rows)", () => {
    const db = new Database(":memory:");
    seedV82TargetShape(db);
    applyV82Statements(db);
    const second = applyV82Statements(db);

    expect(second.pooled).toBe(0);
    expect(second.clamped).toBe(0);
    const pool1 = db.prepare("SELECT scope_key FROM beliefs WHERE id = ?").get("b-pool-1") as { scope_key: string | null };
    expect(pool1.scope_key).toBeNull();
    const residue = db.prepare("SELECT last_used_at FROM beliefs WHERE id = ?").get("b-ms-residue") as { last_used_at: number };
    expect(residue.last_used_at).toBe(42);
  });
});
