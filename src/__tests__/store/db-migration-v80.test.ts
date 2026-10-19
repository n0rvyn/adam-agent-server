import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../store/db.js";
import { setupTestDb } from "../helpers/test-db.js";

/**
 * Seed a DB at schema v79 (v80 not yet applied).
 * We need only server_state for the migration guard to work.
 */
function seedPreV80(db: Database.Database): void {
  db.exec(`
    CREATE TABLE server_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      schema_version INTEGER DEFAULT 79
    );
    INSERT INTO server_state (id, schema_version) VALUES (1, 79);

    CREATE TABLE roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      cag_prompt TEXT NOT NULL DEFAULT '',
      learned_rules TEXT,
      memory_stream_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      performance_score REAL,
      preferences TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      importance_trigger_curr INTEGER DEFAULT 150,
      allowed_tools TEXT,
      disallowed_tools TEXT,
      evaluation_criteria TEXT,
      execution_mode TEXT DEFAULT 'isolated',
      model TEXT,
      max_budget_usd REAL,
      approval_required TEXT,
      source TEXT DEFAULT 'system',
      additional_directories TEXT,
      allowed_channels TEXT,
      mcp_servers TEXT,
      inherit_user_settings INTEGER DEFAULT 0,
      permission_mode TEXT,
      allowed_bash_patterns TEXT,
      denied_bash_patterns TEXT,
      env_vars TEXT,
      os_capabilities TEXT,
      preset_id TEXT,
      effort_tier TEXT,
      skills TEXT,
      last_reflection_at INTEGER,
      memory_budget_tokens INTEGER
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
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      last_validated_at INTEGER NOT NULL,
      scope_key TEXT,
      status TEXT NOT NULL DEFAULT 'candidate',
      trial_count INTEGER NOT NULL DEFAULT 0,
      delta_sum REAL NOT NULL DEFAULT 0,
      expires_at INTEGER,
      success_ema REAL
    );

    CREATE TABLE belief_scopes (
      scope_key TEXT PRIMARY KEY,
      role_id TEXT NOT NULL,
      step_kind TEXT NOT NULL,
      score_ema REAL,
      score_var_ema REAL NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      current_challenger_id TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
}

describe("db v80 migration", () => {
  it("schema_version reaches latest after migration", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    seedPreV80(db);
    runMigrations(db);

    const row = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(row.schema_version).toBe(90);
  });

  it("user_feedback table exists after migration", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    seedPreV80(db);
    runMigrations(db);

    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_feedback'"
    ).get() as { name: string } | undefined;
    expect(table).toBeDefined();
    expect(table!.name).toBe("user_feedback");
  });

  it("user_feedback table has correct columns", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    seedPreV80(db);
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(user_feedback)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("execution_id");
    expect(names).toContain("step_id");
    expect(names).toContain("rating");
    expect(names).toContain("created_at");
  });

  it("user_feedback rating column rejects values other than good/bad", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    seedPreV80(db);
    runMigrations(db);

    expect(() => {
      db.prepare("INSERT INTO user_feedback (id, execution_id, rating, created_at) VALUES (?, ?, ?, ?)")
        .run("fb-1", "exec-1", "invalid", Date.now());
    }).toThrow();
  });

  it("user_feedback row can be inserted with valid rating", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    seedPreV80(db);
    runMigrations(db);

    db.prepare("INSERT INTO user_feedback (id, execution_id, step_id, rating, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("fb-good", "exec-1", null, "good", Date.now());
    db.prepare("INSERT INTO user_feedback (id, execution_id, step_id, rating, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("fb-bad", "exec-2", "step-1", "bad", Date.now());

    const count = (db.prepare("SELECT COUNT(*) AS cnt FROM user_feedback").get() as { cnt: number }).cnt;
    expect(count).toBe(2);
  });

  it("v80 migration is idempotent — running runMigrations twice does not throw", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    seedPreV80(db);
    runMigrations(db);
    runMigrations(db); // must not throw

    const row = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(row.schema_version).toBe(90);
  });

  it("test-db schema matches production schema for user_feedback (no drift)", () => {
    const prodDb = new Database(":memory:");
    prodDb.pragma("foreign_keys = ON");
    seedPreV80(prodDb);
    runMigrations(prodDb);

    const { db: testDb, cleanup } = setupTestDb();
    try {
      const prodCols = (prodDb.prepare("PRAGMA table_info(user_feedback)").all() as Array<{ name: string }>)
        .map((c) => c.name);
      const testCols = (testDb.prepare("PRAGMA table_info(user_feedback)").all() as Array<{ name: string }>)
        .map((c) => c.name);
      expect(testCols, "column list mismatch for user_feedback").toEqual(prodCols);
    } finally {
      cleanup();
    }
  });
});
