import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../store/db.js";

/** Minimum pre-v70 schema: v69 schema with server_state at version 69. */
function seedPreV70(db: Database.Database): void {
  db.exec(`
    CREATE TABLE server_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      schema_version INTEGER DEFAULT 69
    );
    INSERT INTO server_state (id, schema_version) VALUES (1, 69);

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
      retry_count INTEGER NOT NULL DEFAULT 0,
      context_meta TEXT
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
      last_reflection_at INTEGER,
      memory_budget_tokens INTEGER
    );
  `);
}

describe("db v70 migration", () => {
  it("Migration applied to fresh pre-v70 DB sets schema_version>=70 and retry_policy column exists", () => {
    const db = new Database(":memory:");
    db.pragma("trusted_schema = ON");
    seedPreV70(db);
    runMigrations(db);

    const version = db
      .prepare("SELECT schema_version FROM server_state WHERE id = 1")
      .get() as { schema_version: number };
    expect(version.schema_version).toBeGreaterThanOrEqual(70);

    const tmplCols = db
      .prepare("PRAGMA table_info(task_templates)")
      .all() as Array<{ name: string }>;
    expect(tmplCols.some((c) => c.name === "retry_policy")).toBe(true);
  });

  it("Migration is idempotent — running runMigrations twice does not error and column still present", () => {
    const db = new Database(":memory:");
    db.pragma("trusted_schema = ON");
    seedPreV70(db);
    runMigrations(db);
    runMigrations(db); // must not throw

    const version = db
      .prepare("SELECT schema_version FROM server_state WHERE id = 1")
      .get() as { schema_version: number };
    expect(version.schema_version).toBeGreaterThanOrEqual(70);

    const tmplCols = db
      .prepare("PRAGMA table_info(task_templates)")
      .all() as Array<{ name: string }>;
    expect(tmplCols.some((c) => c.name === "retry_policy")).toBe(true);
  });

  it("Pre-v70 DB (schema_version=69) gets bumped to 70 after runMigrations and column added", () => {
    const db = new Database(":memory:");
    db.pragma("trusted_schema = ON");
    seedPreV70(db);
    // Confirm starting version is 69
    const before = db
      .prepare("SELECT schema_version FROM server_state WHERE id = 1")
      .get() as { schema_version: number };
    expect(before.schema_version).toBe(69);

    // Run migrations — should upgrade to at least 70 (may go higher with newer migrations)
    runMigrations(db);
    const after = db
      .prepare("SELECT schema_version FROM server_state WHERE id = 1")
      .get() as { schema_version: number };
    expect(after.schema_version).toBeGreaterThanOrEqual(70);

    const tmplCols = db
      .prepare("PRAGMA table_info(task_templates)")
      .all() as Array<{ name: string }>;
    expect(tmplCols.some((c) => c.name === "retry_policy")).toBe(true);
  });

  it("Existing rows' retry_policy is null after migration (no data backfill)", () => {
    const db = new Database(":memory:");
    db.pragma("trusted_schema = ON");
    seedPreV70(db);
    // Insert a minimal task_templates row before migration
    db.exec(`
      CREATE TABLE task_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        trigger_type TEXT NOT NULL,
        trigger_cron TEXT,
        trigger_event TEXT,
        steps TEXT NOT NULL,
        role_preference TEXT,
        config TEXT,
        tags TEXT,
        enabled INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        source_session_id TEXT,
        notify_targets TEXT,
        deliver_to TEXT,
        report_to TEXT,
        goal_ids TEXT,
        is_preset INTEGER NOT NULL DEFAULT 0,
        preset_id TEXT
      );
    `);
    const now = Date.now();
    db.prepare(`
      INSERT INTO task_templates (id, name, trigger_type, steps, created_at)
      VALUES ('tmpl-test-1', 'Test Template', 'manual', '[]', ?)
    `).run(now);

    runMigrations(db);

    const row = db
      .prepare("SELECT retry_policy FROM task_templates WHERE id = 'tmpl-test-1'")
      .get() as { retry_policy: string | null };
    expect(row.retry_policy).toBeNull();
  });
});
