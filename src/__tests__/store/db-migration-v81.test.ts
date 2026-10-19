/**
 * Schema v81 migration tests.
 *
 * Tests run against the REAL runMigrations() from store/db.ts.
 * Pre-impl: all tests FAIL because runMigrations only reaches v80.
 * Post-impl (Task 1-impl): all tests pass.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../store/db.js";
import { setupTestDb } from "../helpers/test-db.js";

/**
 * Seed a DB at schema v80 (v81 not yet applied).
 * Includes full v80 beliefs schema with dead columns and old status values.
 */
function seedPreV81(db: Database.Database): void {
  db.exec(`
    CREATE TABLE server_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      schema_version INTEGER DEFAULT 80
    );
    INSERT INTO server_state (id, schema_version) VALUES (1, 80);

    CREATE TABLE roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      cag_prompt TEXT NOT NULL DEFAULT '',
      learned_rules TEXT,
      memory_stream_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      performance_score REAL,
      preferences TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER
    );

    CREATE TABLE beliefs (
      id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      use_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      is_anti INTEGER NOT NULL DEFAULT 0 CHECK(is_anti IN (0, 1)),
      evidence_obs_ids TEXT,
      embedding BLOB,
      superseded_by TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER NOT NULL DEFAULT 0,
      last_validated_at INTEGER NOT NULL DEFAULT 0,
      scope_key TEXT,
      status TEXT NOT NULL DEFAULT 'candidate',
      trial_count INTEGER NOT NULL DEFAULT 0,
      delta_sum REAL NOT NULL DEFAULT 0,
      expires_at INTEGER,
      success_ema REAL
    );

    CREATE VIRTUAL TABLE beliefs_fts USING fts5(content, content='beliefs', content_rowid='rowid');

    CREATE TRIGGER beliefs_fts_insert AFTER INSERT ON beliefs BEGIN
      INSERT INTO beliefs_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER beliefs_fts_delete AFTER DELETE ON beliefs BEGIN
      INSERT INTO beliefs_fts(beliefs_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER beliefs_fts_update AFTER UPDATE ON beliefs BEGIN
      INSERT INTO beliefs_fts(beliefs_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO beliefs_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TABLE belief_scopes (
      scope_key TEXT PRIMARY KEY,
      role_id TEXT NOT NULL,
      step_kind TEXT NOT NULL,
      score_ema REAL,
      score_var_ema REAL NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      current_challenger_id TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE user_feedback (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      step_id TEXT,
      rating TEXT NOT NULL CHECK(rating IN ('good','bad')),
      created_at INTEGER NOT NULL
    );
  `);
}

describe("Schema v81 migration", () => {
  it("migrates schema_version 80 -> 81", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV81(db);
    runMigrations(db);

    const row = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(row.schema_version).toBe(90);
  });

  it("drops belief_scopes table after migration", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV81(db);
    runMigrations(db);

    const scopesTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='belief_scopes'"
    ).get();
    expect(scopesTable).toBeUndefined();
  });

  it("seeds existing beliefs with default success_ema=0.5 and status='active'", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV81(db);

    // 3 candidate beliefs (success_ema=NULL -> should get 0.5)
    db.prepare(`INSERT INTO beliefs (id, role_id, content, status, confidence, use_count, success_count, success_ema, created_at, last_used_at, last_validated_at)
                VALUES ('b1', 'role-1', 'content1', 'candidate', 0.7, 2, 1, NULL, 0, 0, 0)`).run();
    db.prepare(`INSERT INTO beliefs (id, role_id, content, status, confidence, use_count, success_count, success_ema, created_at, last_used_at, last_validated_at)
                VALUES ('b2', 'role-1', 'content2', 'candidate', 0.6, 1, 0, NULL, 0, 0, 0)`).run();
    db.prepare(`INSERT INTO beliefs (id, role_id, content, status, confidence, use_count, success_count, success_ema, created_at, last_used_at, last_validated_at)
                VALUES ('b3', 'role-1', 'content3', 'candidate', 0.5, 0, 0, NULL, 0, 0, 0)`).run();
    // 1 core belief with existing success_ema=0.8 -> should be preserved
    db.prepare(`INSERT INTO beliefs (id, role_id, content, status, confidence, use_count, success_count, success_ema, created_at, last_used_at, last_validated_at)
                VALUES ('b4', 'role-1', 'content4', 'core', 0.9, 5, 4, 0.8, 0, 0, 0)`).run();

    runMigrations(db);

    const rows = db.prepare("SELECT id, status, success_ema FROM beliefs ORDER BY id").all() as Array<{
      id: string;
      status: string;
      success_ema: number | null;
    }>;

    // All 4 rows preserved
    expect(rows).toHaveLength(4);

    // 3 candidates -> success_ema seeded to 0.5, status='active'
    for (const r of rows.filter((r) => r.id !== "b4")) {
      expect(r.status).toBe("active");
      expect(r.success_ema).toBeCloseTo(0.5, 5);
    }

    // 1 core -> success_ema preserved at 0.8, status='active'
    const b4 = rows.find((r) => r.id === "b4")!;
    expect(b4.status).toBe("active");
    expect(b4.success_ema).toBeCloseTo(0.8, 5);
  });

  it("resets last_used_at to 0 (role.task_seq initial) on migration", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV81(db);

    db.prepare(`INSERT INTO beliefs (id, role_id, content, status, confidence, use_count, success_count, created_at, last_used_at, last_validated_at)
                VALUES ('b5', 'role-1', 'content5', 'candidate', 0.5, 0, 0, 0, 1234567890, 0)`).run();

    runMigrations(db);

    const row = db.prepare("SELECT last_used_at FROM beliefs WHERE id = 'b5'").get() as { last_used_at: number };
    expect(row.last_used_at).toBe(0);
  });

  it("preserves is_anti flag across migration", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV81(db);

    db.prepare(`INSERT INTO beliefs (id, role_id, content, status, is_anti, confidence, use_count, success_count, created_at, last_used_at, last_validated_at)
                VALUES ('b6', 'role-1', 'anti-belief', 'candidate', 1, 0.3, 0, 0, 0, 0, 0)`).run();

    runMigrations(db);

    const row = db.prepare("SELECT is_anti FROM beliefs WHERE id = 'b6'").get() as { is_anti: number };
    expect(row.is_anti).toBe(1);
  });

  it("seeds inject_count to 0 on migration (DP-001 Option A)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV81(db);

    db.prepare(`INSERT INTO beliefs (id, role_id, content, status, confidence, use_count, success_count, created_at, last_used_at, last_validated_at)
                VALUES ('b7', 'role-1', 'content7', 'candidate', 0.5, 0, 0, 0, 0, 0)`).run();

    runMigrations(db);

    const row = db.prepare("SELECT inject_count FROM beliefs WHERE id = 'b7'").get() as { inject_count: number };
    expect(row.inject_count).toBe(0);
  });

  it("FTS5 round-trip after table recreation", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV81(db);

    // Insert a pre-migration belief with searchable content
    db.prepare(`INSERT INTO beliefs (id, role_id, content, status, confidence, use_count, success_count, created_at, last_used_at, last_validated_at)
                VALUES ('b8', 'role-1', 'pre-migration-content-xyzq', 'candidate', 0.5, 0, 0, 0, 0, 0)`).run();

    runMigrations(db);

    // Insert a post-migration belief
    db.prepare(`INSERT INTO beliefs (id, role_id, content, is_anti, created_at, last_used_at, last_validated_at, status, inject_count)
                VALUES ('b9', 'role-1', 'unique-fts-marker-zxqv', 0, 0, 0, 0, 'active', 0)`).run();

    // Post-migration belief searchable — match unique token 'zxqv' (FTS5 tokenizes on hyphens)
    const postMig = db.prepare(
      "SELECT id FROM beliefs WHERE rowid IN (SELECT rowid FROM beliefs_fts WHERE beliefs_fts MATCH 'zxqv')"
    ).all() as Array<{ id: string }>;
    expect(postMig.map((r) => r.id)).toContain("b9");

    // Pre-migration belief backfilled in FTS5 and searchable — match unique token 'xyzq'
    const preMig = db.prepare(
      "SELECT id FROM beliefs WHERE rowid IN (SELECT rowid FROM beliefs_fts WHERE beliefs_fts MATCH 'xyzq')"
    ).all() as Array<{ id: string }>;
    expect(preMig.map((r) => r.id)).toContain("b8");
  });

  it("test-db schema matches production beliefs schema after v81 (no drift)", () => {
    const prodDb = new Database(":memory:");
    prodDb.pragma("foreign_keys = ON");
    prodDb.pragma("trusted_schema = ON");
    seedPreV81(prodDb);
    runMigrations(prodDb);

    const { db: testDb, cleanup } = setupTestDb();
    try {
      const prodCols = (prodDb.prepare("PRAGMA table_info(beliefs)").all() as Array<{ name: string }>)
        .map((c) => c.name)
        .sort();
      const testCols = (testDb.prepare("PRAGMA table_info(beliefs)").all() as Array<{ name: string }>)
        .map((c) => c.name)
        .sort();
      expect(testCols, "beliefs column list mismatch between test-db and prod migration").toEqual(prodCols);
    } finally {
      cleanup();
    }
  });
});
