/**
 * Schema v87 drift-repair migration test.
 *
 * Reproduces the production regression reported 2026-05-30: a real DB reached
 * schema_version 86 while tasks.cost_breakdown (v83) and chat_messages cost columns
 * (v85) were never applied — because the version-gated v83/v85 blocks are skipped once
 * schema_version >= their guard (86 >= 83/85). The symptom was:
 *   `SqliteError: table tasks has no column named cost_breakdown` on the 采集 task INSERT,
 * which failed the whole evening-podcast pipeline (1 failed, 13 skipped).
 *
 * This runs the REAL runMigrations() — NOT the hand-maintained test-db.ts inline schema.
 * That distinction is the whole point: the canonical gate builds its schema from test-db.ts
 * (which already has these columns), so a migration skipped on a real drifted DB is invisible
 * to every other test. This test closes that blind spot for the cost columns.
 *
 * Method: build a full, real schema via runMigrations on a fresh DB, then SIMULATE the drift
 * (DROP the cost columns + rewind schema_version to 86) and re-run migrations. Without the v87
 * block this FAILS (86 >= 83/85 skips v83/v85, nothing re-adds the columns).
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../store/db.js";

function cols(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

/**
 * Build a full real schema, then rewind it into the prod drift state:
 * cost columns dropped + schema_version forced back to 86 (>= v83/v85 guards).
 */
function buildDriftedDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db); // full real schema (includes cost_breakdown + chat_messages cost cols + v87)

  // Simulate the drift: remove the columns and force schema_version to 86 (past v83/v85 guards,
  // below v87). Use INSERT-or-update so the id=1 row definitely exists at 86 — only then is the
  // drift real (v83/v85 SKIPPED so the columns can only be restored by v87, not v83).
  db.exec("ALTER TABLE tasks DROP COLUMN cost_breakdown");
  db.exec("ALTER TABLE chat_messages DROP COLUMN cost_usd");
  db.exec("ALTER TABLE chat_messages DROP COLUMN token_usage");
  db.exec("ALTER TABLE chat_messages DROP COLUMN model");
  db.prepare(
    "INSERT INTO server_state (id, schema_version) VALUES (1, 86) ON CONFLICT(id) DO UPDATE SET schema_version = 86",
  ).run();
  return db;
}

describe("schema v87 drift repair", () => {
  it("re-adds tasks.cost_breakdown on a v86 DB that lost it (reproduces the prod SqliteError)", () => {
    const db = buildDriftedDb();
    expect(cols(db, "tasks")).not.toContain("cost_breakdown"); // precondition: drift state
    runMigrations(db);
    expect(cols(db, "tasks")).toContain("cost_breakdown");
    db.close();
  });

  it("re-adds chat_messages cost columns (cost_usd, token_usage, model) on a v86 DB", () => {
    const db = buildDriftedDb();
    runMigrations(db);
    expect(cols(db, "chat_messages")).toEqual(
      expect.arrayContaining(["cost_usd", "token_usage", "model"]),
    );
    db.close();
  });

  it("bumps schema_version to >=87 and lets the exact failing INSERT (cost_breakdown) succeed", () => {
    const db = buildDriftedDb();
    runMigrations(db);
    const v = (db.prepare("SELECT schema_version FROM server_state WHERE id=1").get() as { schema_version: number })
      .schema_version;
    expect(v).toBeGreaterThanOrEqual(87);
    // The operation from the prod report — writing cost_breakdown on a task — must not throw.
    // (base tasks has NOT NULL prompt/config/created_at, so provide them.)
    expect(() =>
      db
        .prepare("INSERT INTO tasks (id, prompt, config, created_at, cost_breakdown) VALUES (?, ?, ?, ?, ?)")
        .run("t1", "p", "{}", 0, JSON.stringify({ perModel: [] })),
    ).not.toThrow();
    db.close();
  });

  it("is idempotent — re-running on an already-healed DB is a no-op and does not throw", () => {
    const db = buildDriftedDb();
    runMigrations(db); // heals
    expect(() => runMigrations(db)).not.toThrow(); // second pass: v87 guard blocks the double-ALTER
    expect(cols(db, "tasks")).toContain("cost_breakdown");
    db.close();
  });
});
