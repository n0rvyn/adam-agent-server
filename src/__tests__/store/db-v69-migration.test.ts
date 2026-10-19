import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../store/db.js";

/** Minimum pre-v69 schema: v68 schema with server_state at version 68. */
function seedPreV69(db: Database.Database): void {
  db.exec(`
    CREATE TABLE server_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      schema_version INTEGER DEFAULT 68
    );
    INSERT INTO server_state (id, schema_version) VALUES (1, 68);

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      prompt TEXT NOT NULL,
      config TEXT NOT NULL,
      result TEXT,
      error TEXT,
      sdk_session_id TEXT,
      template_id TEXT,
      original_prompt TEXT,
      role_id TEXT,
      step_id TEXT,
      source_session_id TEXT,
      notify_targets TEXT,
      deliver_to TEXT,
      report_to TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      cost_usd REAL,
      token_usage TEXT,
      num_turns INTEGER,
      total_duration_ms INTEGER,
      block_reason_json TEXT,
      trace_id TEXT,
      error_category TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      cag_prompt TEXT NOT NULL DEFAULT '',
      learned_rules TEXT,
      memory_stream_id TEXT NOT NULL,
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
      last_reflection_at INTEGER
    );
  `);
}

describe("db v69 migration", () => {
  it("Migration applied to fresh pre-v69 DB sets schema_version=69 and both columns exist", () => {
    const db = new Database(":memory:");
    db.pragma("trusted_schema = ON");
    seedPreV69(db);
    runMigrations(db);

    const version = db
      .prepare("SELECT schema_version FROM server_state WHERE id = 1")
      .get() as { schema_version: number };
    expect(version.schema_version).toBeGreaterThanOrEqual(69);

    const tasksCols = db
      .prepare("PRAGMA table_info(tasks)")
      .all() as Array<{ name: string }>;
    expect(tasksCols.some((c) => c.name === "context_meta")).toBe(true);

    const rolesCols = db
      .prepare("PRAGMA table_info(roles)")
      .all() as Array<{ name: string }>;
    expect(rolesCols.some((c) => c.name === "memory_budget_tokens")).toBe(true);
  });

  it("Migration is idempotent — running runMigrations twice does not error and columns still present", () => {
    const db = new Database(":memory:");
    db.pragma("trusted_schema = ON");
    seedPreV69(db);
    runMigrations(db);
    runMigrations(db); // must not throw

    const version = db
      .prepare("SELECT schema_version FROM server_state WHERE id = 1")
      .get() as { schema_version: number };
    expect(version.schema_version).toBeGreaterThanOrEqual(69);

    const tasksCols = db
      .prepare("PRAGMA table_info(tasks)")
      .all() as Array<{ name: string }>;
    expect(tasksCols.some((c) => c.name === "context_meta")).toBe(true);

    const rolesCols = db
      .prepare("PRAGMA table_info(roles)")
      .all() as Array<{ name: string }>;
    expect(rolesCols.some((c) => c.name === "memory_budget_tokens")).toBe(true);
  });

  it("Pre-v69 DB (schema_version=68) gets bumped to 69 after runMigrations and both columns added", () => {
    const db = new Database(":memory:");
    db.pragma("trusted_schema = ON");
    seedPreV69(db);
    // Confirm starting version is 68
    const before = db
      .prepare("SELECT schema_version FROM server_state WHERE id = 1")
      .get() as { schema_version: number };
    expect(before.schema_version).toBe(68);

    // Run migrations — should upgrade
    runMigrations(db);
    const after = db
      .prepare("SELECT schema_version FROM server_state WHERE id = 1")
      .get() as { schema_version: number };
    expect(after.schema_version).toBeGreaterThanOrEqual(69);

    const tasksCols = db
      .prepare("PRAGMA table_info(tasks)")
      .all() as Array<{ name: string }>;
    expect(tasksCols.some((c) => c.name === "context_meta")).toBe(true);

    const rolesCols = db
      .prepare("PRAGMA table_info(roles)")
      .all() as Array<{ name: string }>;
    expect(rolesCols.some((c) => c.name === "memory_budget_tokens")).toBe(true);
  });
});
