import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../store/db.js";
import { setupTestDb } from "../helpers/test-db.js";

function seedPreV79(db: Database.Database): void {
  db.exec(`
    CREATE TABLE server_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      schema_version INTEGER DEFAULT 78
    );
    INSERT INTO server_state (id, schema_version) VALUES (1, 78);

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
      last_validated_at INTEGER NOT NULL
    );
  `);
}

function insertSampleBeliefs(db: Database.Database): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO beliefs (id, role_id, content, confidence, use_count, success_count, is_anti, created_at, last_used_at, last_validated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("belief-1", "role-a", "Content A", 0.8, 5, 4, 0, now, now, now);

  db.prepare(
    `INSERT INTO beliefs (id, role_id, content, confidence, use_count, success_count, is_anti, created_at, last_used_at, last_validated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("belief-2", "role-a", "Anti Content", 0.3, 3, 0, 1, now, now, now);

  db.prepare(
    `INSERT INTO beliefs (id, role_id, content, confidence, use_count, success_count, is_anti, created_at, last_used_at, last_validated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("belief-3", "role-b", "Content B", 0.6, 2, 1, 0, now, now, now);
}

describe("db v79 migration", () => {
  // Note: v79 introduced scope_key/status/trial_count/delta_sum/expires_at/success_ema columns + belief_scopes table.
  // v81 subsequently drops trial_count/delta_sum/expires_at/belief_scopes and seeds status='active'/success_ema=0.5.
  // These tests verify the FINAL state after running all migrations through v81.

  it("schema_version is 81 after running all migrations from pre-v79 state", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV79(db);
    runMigrations(db);

    const row = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(row.schema_version).toBe(90);
  });

  it("beliefs table has v81 columns (scope_key, status, success_ema, inject_count; no trial_count/delta_sum/expires_at)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV79(db);
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(beliefs)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("scope_key");
    expect(names).toContain("status");
    expect(names).toContain("success_ema");
    expect(names).toContain("inject_count");
    // v81 drops these v79-era columns:
    expect(names).not.toContain("trial_count");
    expect(names).not.toContain("delta_sum");
    expect(names).not.toContain("expires_at");
  });

  it("beliefs row count is preserved after migration", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV79(db);
    insertSampleBeliefs(db);

    const beforeCount = (db.prepare("SELECT COUNT(*) AS cnt FROM beliefs").get() as { cnt: number }).cnt;
    expect(beforeCount).toBe(3);

    runMigrations(db);

    const afterCount = (db.prepare("SELECT COUNT(*) AS cnt FROM beliefs").get() as { cnt: number }).cnt;
    expect(afterCount).toBe(3);
  });

  it("existing beliefs are migrated to status='active' and success_ema=0.5 (v81 seed)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV79(db);
    insertSampleBeliefs(db);
    runMigrations(db);

    const rows = db.prepare("SELECT id, role_id, status, success_ema FROM beliefs").all() as Array<{
      id: string;
      role_id: string;
      status: string;
      success_ema: number | null;
    }>;

    for (const row of rows) {
      expect(row.status, `status for ${row.id}`).toBe("active");
      expect(row.success_ema, `success_ema for ${row.id}`).toBeCloseTo(0.5, 2);
    }
  });

  it("is_anti=1 beliefs are also migrated to active", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV79(db);
    insertSampleBeliefs(db);
    runMigrations(db);

    const antiRow = db.prepare("SELECT status FROM beliefs WHERE is_anti = 1").get() as {
      status: string;
    } | undefined;
    expect(antiRow).toBeDefined();
    expect(antiRow!.status).toBe("active");
  });

  it("belief_scopes table does NOT exist after migration (dropped by v81)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV79(db);
    runMigrations(db);

    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'belief_scopes'"
    ).get() as { name: string } | undefined;
    expect(table).toBeUndefined();
  });

  it("v79→v81 migration is idempotent — running runMigrations twice does not throw", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV79(db);
    insertSampleBeliefs(db);
    runMigrations(db);
    runMigrations(db); // must not throw

    const row = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(row.schema_version).toBe(90);

    const count = (db.prepare("SELECT COUNT(*) AS cnt FROM beliefs").get() as { cnt: number }).cnt;
    expect(count).toBe(3);
  });

  it("test-db schema matches production schema for beliefs (no drift)", () => {
    const prodDb = new Database(":memory:");
    prodDb.pragma("foreign_keys = ON");
    prodDb.pragma("trusted_schema = ON");
    seedPreV79(prodDb);
    runMigrations(prodDb);

    const { db: testDb, cleanup } = setupTestDb();
    try {
      const prodCols = (prodDb.prepare("PRAGMA table_info(beliefs)").all() as Array<{ name: string }>)
        .map((c) => c.name);
      const testCols = (testDb.prepare("PRAGMA table_info(beliefs)").all() as Array<{ name: string }>)
        .map((c) => c.name);
      expect(testCols, "column list mismatch for beliefs").toEqual(prodCols);
    } finally {
      cleanup();
    }
  });
});
