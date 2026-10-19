/**
 * Schema v85 migration tests: chat_messages cost columns.
 *
 * Tests run against the REAL runMigrations() from store/db.ts.
 * Pre-impl: tests FAIL because chat_messages has no cost_usd/token_usage/model columns.
 * Post-impl (Task 1-impl): all tests pass.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../store/db.js";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";

// Initialize test DB for drift checks
setupTestDb();

/**
 * Build an in-memory DB at schema_version=83.
 * Same helper as in db-migration-llm-costs.test.ts.
 */
function freshDbAtV83(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("trusted_schema = ON");
  db.exec(`
    CREATE TABLE server_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      schema_version INTEGER DEFAULT 0,
      tools_fingerprint TEXT
    );
    INSERT INTO server_state (id, schema_version) VALUES (1, 83);

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
      os_capabilities TEXT,
      permission_mode TEXT,
      allowed_bash_patterns TEXT,
      denied_bash_patterns TEXT,
      env_vars TEXT,
      preset_id TEXT,
      effort_tier TEXT,
      skills TEXT,
      last_reflection_at INTEGER,
      memory_budget_tokens INTEGER,
      task_seq INTEGER NOT NULL DEFAULT 0,
      is_cron INTEGER NOT NULL DEFAULT 0,
      schedule TEXT,
      report_to TEXT,
      deliver_to TEXT,
      plugin_paths TEXT,
      visible_paths TEXT,
      identity_key TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_roles_status ON roles(status);
    CREATE INDEX IF NOT EXISTS idx_roles_name ON roles(name);
  `);
  return db;
}

describe("Schema v85 migration — chat_messages cost columns", () => {
  it("migrates schema_version 83 -> 85 (fresh DB)", () => {
    const db = freshDbAtV83();
    runMigrations(db);

    const row = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(row.schema_version).toBe(90);
  });

  it("chat_messages has cost_usd REAL column after v85 migration", () => {
    const db = freshDbAtV83();
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string; type: string }>;
    const costUsd = cols.find((c) => c.name === "cost_usd");
    expect(costUsd, "chat_messages missing cost_usd column").toBeDefined();
    expect(costUsd!.type.toUpperCase()).toContain("REAL");
  });

  it("chat_messages has token_usage TEXT column after v85 migration", () => {
    const db = freshDbAtV83();
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string; type: string }>;
    const tokenUsage = cols.find((c) => c.name === "token_usage");
    expect(tokenUsage, "chat_messages missing token_usage column").toBeDefined();
  });

  it("chat_messages has model TEXT column after v85 migration", () => {
    const db = freshDbAtV83();
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string; type: string }>;
    const model = cols.find((c) => c.name === "model");
    expect(model, "chat_messages missing model column").toBeDefined();
  });

  it("is idempotent: second runMigrations does not throw", () => {
    const db = freshDbAtV83();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();

    const row = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(row.schema_version).toBe(90);
  });

  it("pre-existing chat_messages rows survive the column additions", () => {
    const db = freshDbAtV83();
    runMigrations(db); // creates chat_messages with all pre-v85 columns

    // Rewind to v84 to re-apply v85 only (v84 = llm_costs done, v85 = chat_messages cost cols not yet)
    db.prepare("UPDATE server_state SET schema_version = 84 WHERE id = 1").run();

    // Insert a pre-existing chat message WITHOUT cost columns (they don't exist yet conceptually)
    db.prepare(`
      INSERT INTO chat_sessions (id, status, source_type, created_at, last_active_at)
      VALUES ('sess-pre-v85', 'active', 'cli', ${Date.now()}, ${Date.now()})
    `).run();
    db.prepare(`
      INSERT INTO chat_messages (id, session_id, role, content, source_type, created_at)
      VALUES ('msg-pre-v85', 'sess-pre-v85', 'user', 'hello', 'cli', ${Date.now()})
    `).run();

    // Re-apply v85 (ADD COLUMN on a populated table)
    runMigrations(db);

    const msg = db.prepare(
      "SELECT id, content, cost_usd, token_usage, model FROM chat_messages WHERE id = 'msg-pre-v85'"
    ).get() as { id: string; content: string; cost_usd: number | null; token_usage: string | null; model: string | null };

    expect(msg.id).toBe("msg-pre-v85");
    expect(msg.content).toBe("hello"); // original data intact
    expect(msg.cost_usd).toBeNull();   // new columns default to NULL
    expect(msg.token_usage).toBeNull();
    expect(msg.model).toBeNull();
  });

  it("no drift: test-db chat_messages has cost_usd / token_usage / model columns", () => {
    const testDb = getTestDb();

    const cols = (testDb.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>)
      .map((c) => c.name);

    expect(cols, "test-db chat_messages missing cost_usd").toContain("cost_usd");
    expect(cols, "test-db chat_messages missing token_usage").toContain("token_usage");
    expect(cols, "test-db chat_messages missing model").toContain("model");
  });
});
