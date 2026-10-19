import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../store/db.js";
import { setupTestDb } from "../helpers/test-db.js";

/** Minimum schema for v71: server_state at version 70, plus roles (required for FK). */
function seedPreV71(db: Database.Database): void {
  const stmts = [
    `CREATE TABLE server_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      schema_version INTEGER DEFAULT 70
    )`,
    `INSERT INTO server_state (id, schema_version) VALUES (1, 70)`,
    `CREATE TABLE roles (
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
    )`,
  ];
  for (const sql of stmts) {
    db.prepare(sql).run();
  }
}

describe("db v71 migration", () => {
  it("fresh DB has 3 new tables with correct column counts", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV71(db);
    runMigrations(db);

    const extCols = db.prepare("PRAGMA table_info(extensions)").all() as Array<{ name: string }>;
    expect(extCols.length).toBe(9);

    const reCols = db.prepare("PRAGMA table_info(role_extensions)").all() as Array<{ name: string }>;
    expect(reCols.length).toBe(8);

    const ehCols = db.prepare("PRAGMA table_info(extension_health)").all() as Array<{ name: string }>;
    expect(ehCols.length).toBe(6);
  });

  it("schema_version is 71 after migration on a separate in-memory DB via runMigrations", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV71(db);
    runMigrations(db);

    const row = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(row.schema_version).toBe(90);
  });

  it("v71 migration is idempotent — running runMigrations twice stays at 71 with no error", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV71(db);
    runMigrations(db);
    runMigrations(db); // must not throw

    const row = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(row.schema_version).toBe(90);
  });

  it("v71 does NOT modify roles.mcp_servers values", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedPreV71(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO roles (id, name, mcp_servers, created_at) VALUES ('role-test-1', 'test-role', '{"foo":"bar"}', ?)`
    ).run(now);

    runMigrations(db);

    const row = db.prepare("SELECT mcp_servers FROM roles WHERE id = 'role-test-1'").get() as { mcp_servers: string };
    expect(row.mcp_servers).toBe('{"foo":"bar"}');
  });

  it("test-db schema matches initDatabase schema for new tables (no drift)", () => {
    // Build a DB from runMigrations (production path)
    const prodDb = new Database(":memory:");
    prodDb.pragma("foreign_keys = ON");
    prodDb.pragma("trusted_schema = ON");
    seedPreV71(prodDb);
    runMigrations(prodDb);

    // Build a DB from setupTestDb (test path)
    const { db: testDb, cleanup } = setupTestDb();

    try {
      for (const tableName of ["extensions", "role_extensions", "extension_health"]) {
        const prodCols = (prodDb.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; type: string }>)
          .map((c) => c.name);
        const testCols = (testDb.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; type: string }>)
          .map((c) => c.name);
        expect(testCols, `column list mismatch for ${tableName}`).toEqual(prodCols);
      }
    } finally {
      cleanup();
    }
  });
});
