import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../store/db.js";
import { setupTestDb } from "../helpers/test-db.js";

/**
 * Seed server_state at v71 + roles table only.
 * All other tables (template_execution_artifacts, template_executions, tasks, chat_sessions, etc.)
 * are created by runMigrations running through v1..v71. This matches the v71 test pattern.
 */
function seedV71State(db: Database.Database): void {
  const stmts = [
    `CREATE TABLE server_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      schema_version INTEGER DEFAULT 71
    )`,
    `INSERT INTO server_state (id, schema_version) VALUES (1, 71)`,
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

/**
 * Build a DB at schema v71 with legacy artifact rows ready for v72 migration.
 * Since seedV71State sets schema_version=71, runMigrations skips all v1..v71 blocks.
 * We therefore create the required upstream tables manually, matching the cumulative
 * production schema at v71.
 */
function buildPreV72WithRows(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("trusted_schema = ON");
  seedV71State(db);

  // Manually create tables that runMigrations would have created in v1..v71.
  // Only the tables needed for FK chain: task_templates → template_executions → template_execution_artifacts.
  db.prepare(`CREATE TABLE task_templates (
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
    preset_id TEXT,
    retry_policy TEXT
  )`).run();

  db.prepare(`CREATE TABLE template_executions (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    step_statuses TEXT NOT NULL DEFAULT '{}',
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    error TEXT,
    event_id TEXT,
    step_results_json TEXT,
    FOREIGN KEY (template_id) REFERENCES task_templates(id)
  )`).run();

  db.prepare(`CREATE TABLE template_execution_artifacts (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('json', 'file')),
    value_json TEXT,
    blob_path TEXT,
    mime TEXT,
    original_filename TEXT,
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    locator TEXT,
    content_hash TEXT,
    retention_hint TEXT,
    encryption_class TEXT,
    purpose TEXT,
    replaces TEXT,
    produced_by_role TEXT,
    access TEXT,
    UNIQUE(execution_id, step_id, key),
    FOREIGN KEY (execution_id) REFERENCES template_executions(id) ON DELETE CASCADE
  )`).run();

  // Insert task_templates → template_executions → artifacts rows
  db.prepare(`INSERT INTO task_templates (id, name, trigger_type, steps, created_at) VALUES ('tmpl-1', 'test-template', 'manual', '[]', 1700000000000)`).run();
  db.prepare(`INSERT INTO template_executions (id, template_id, status, step_statuses, started_at) VALUES ('exec-1', 'tmpl-1', 'completed', '{}', 1700000000000)`).run();

  db.prepare(
    `INSERT INTO template_execution_artifacts
     (id, execution_id, step_id, key, kind, size_bytes, created_at, produced_by_role, content_hash)
     VALUES ('art-1', 'exec-1', 'step-1', 'output', 'json', 100, 1700000001000, 'role-a', 'hash-abc')`
  ).run();
  db.prepare(
    `INSERT INTO template_execution_artifacts
     (id, execution_id, step_id, key, kind, size_bytes, created_at, produced_by_role)
     VALUES ('art-2', 'exec-1', 'step-2', 'output', 'file', 200, 1700000002000, 'role-b')`
  ).run();
  db.prepare(
    `INSERT INTO template_execution_artifacts
     (id, execution_id, step_id, key, kind, size_bytes, created_at, produced_by_role)
     VALUES ('art-3', 'exec-1', 'step-3', 'output2', 'json', 50, 1700000003000, NULL)`
  ).run();

  return db;
}

describe("db v72 migration", () => {
  it("schema_version is 72 after migration", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedV71State(db);
    runMigrations(db);

    // v73 (artifacts.priority), v74 (channels.recipient_cap_map), and v75 (audit_violations
    // layer CHECK extended to include 'C') migrations run after v72;
    // runMigrations always advances to the current max version.
    const row = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(row.schema_version).toBe(90);
  });

  it("artifacts table exists with correct column count (25)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedV71State(db);
    runMigrations(db);

    // Column count is 25 after v73 adds `priority` and v78 adds `artifact_role`.
    const cols = db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
    expect(cols.length).toBe(25);
  });

  it("artifacts table has source_kind column", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedV71State(db);
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("source_kind");
  });

  it("artifacts table has new FK columns: task_id, chat_session_id, role_id", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedV71State(db);
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("task_id");
    expect(names).toContain("chat_session_id");
    expect(names).toContain("role_id");
  });

  it("all 3 legacy rows are migrated with source_kind='template_step'", () => {
    const db = buildPreV72WithRows();
    runMigrations(db); // now runs v72

    const rows = db.prepare("SELECT source_kind FROM artifacts").all() as Array<{ source_kind: string }>;
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.source_kind === "template_step")).toBe(true);
  });

  it("migrated rows: role_id backfilled from produced_by_role", () => {
    const db = buildPreV72WithRows();
    runMigrations(db);

    const row = db.prepare("SELECT role_id FROM artifacts WHERE id = 'art-1'").get() as { role_id: string | null };
    expect(row.role_id).toBe("role-a");

    const row2 = db.prepare("SELECT role_id FROM artifacts WHERE id = 'art-3'").get() as { role_id: string | null };
    expect(row2.role_id).toBeNull();
  });

  it("migrated rows: task_id and chat_session_id are NULL", () => {
    const db = buildPreV72WithRows();
    runMigrations(db);

    const rows = db.prepare("SELECT task_id, chat_session_id FROM artifacts").all() as Array<{ task_id: string | null; chat_session_id: string | null }>;
    expect(rows.every((r) => r.task_id === null)).toBe(true);
    expect(rows.every((r) => r.chat_session_id === null)).toBe(true);
  });

  it("CHECK constraint rejects template_step row missing step_id", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedV71State(db);
    runMigrations(db);

    // Need a template_execution for FK
    db.prepare(`INSERT INTO task_templates (id, name, trigger_type, steps, created_at) VALUES ('tmpl-c1', 'test', 'manual', '[]', 1700000000000)`).run();
    db.prepare(`INSERT INTO template_executions (id, template_id, status, step_statuses, started_at) VALUES ('exec-c1', 'tmpl-c1', 'completed', '{}', 1700000000000)`).run();

    expect(() => {
      db.prepare(
        `INSERT INTO artifacts (id, source_kind, execution_id, step_id, key, kind, size_bytes, created_at)
         VALUES ('bad-1', 'template_step', 'exec-c1', NULL, 'out', 'json', 1, 1700000000000)`
      ).run();
    }).toThrow();
  });

  it("CHECK constraint rejects task_published row with execution_id set", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedV71State(db);
    runMigrations(db);

    db.prepare(`INSERT INTO task_templates (id, name, trigger_type, steps, created_at) VALUES ('tmpl-c2', 'test', 'manual', '[]', 1700000000000)`).run();
    db.prepare(`INSERT INTO template_executions (id, template_id, status, step_statuses, started_at) VALUES ('exec-c2', 'tmpl-c2', 'completed', '{}', 1700000000000)`).run();
    db.prepare(`INSERT INTO tasks (id, status, prompt, config, created_at) VALUES ('task-c1', 'completed', 'test', '{}', 1700000000000)`).run();

    expect(() => {
      db.prepare(
        `INSERT INTO artifacts (id, source_kind, execution_id, task_id, key, kind, size_bytes, created_at)
         VALUES ('bad-2', 'task_published', 'exec-c2', 'task-c1', 'out', 'json', 1, 1700000000000)`
      ).run();
    }).toThrow();
  });

  it("CHECK constraint rejects chat_sent row with task_id set", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedV71State(db);
    runMigrations(db);

    db.prepare(`INSERT INTO tasks (id, status, prompt, config, created_at) VALUES ('task-c2', 'completed', 'test', '{}', 1700000000000)`).run();
    db.prepare(`INSERT INTO chat_sessions (id, source_type, status, created_at, last_active_at) VALUES ('sess-1', 'web', 'active', 1700000000000, 1700000000000)`).run();

    expect(() => {
      db.prepare(
        `INSERT INTO artifacts (id, source_kind, chat_session_id, task_id, kind, size_bytes, created_at)
         VALUES ('bad-3', 'chat_sent', 'sess-1', 'task-c2', 'json', 1, 1700000000000)`
      ).run();
    }).toThrow();
  });

  it("FK CASCADE: deleting template_execution deletes its artifacts", () => {
    const db = buildPreV72WithRows();
    runMigrations(db);

    const before = db.prepare("SELECT COUNT(*) AS cnt FROM artifacts WHERE execution_id = 'exec-1'").get() as { cnt: number };
    expect(before.cnt).toBe(3);

    db.prepare("DELETE FROM template_executions WHERE id = 'exec-1'").run();

    const after = db.prepare("SELECT COUNT(*) AS cnt FROM artifacts WHERE execution_id = 'exec-1'").get() as { cnt: number };
    expect(after.cnt).toBe(0);
  });

  it("partial unique index idx_artifacts_template_step_key prevents duplicate (execution_id, step_id, key) for template_step", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedV71State(db);
    runMigrations(db);

    db.prepare(`INSERT INTO task_templates (id, name, trigger_type, steps, created_at) VALUES ('tmpl-u1', 'test', 'manual', '[]', 1700000000000)`).run();
    db.prepare(`INSERT INTO template_executions (id, template_id, status, step_statuses, started_at) VALUES ('exec-u1', 'tmpl-u1', 'running', '{}', 1700000000000)`).run();
    db.prepare(
      `INSERT INTO artifacts (id, source_kind, execution_id, step_id, key, kind, size_bytes, created_at)
       VALUES ('dup-1', 'template_step', 'exec-u1', 'step-x', 'out', 'json', 1, 1700000000000)`
    ).run();

    expect(() => {
      db.prepare(
        `INSERT INTO artifacts (id, source_kind, execution_id, step_id, key, kind, size_bytes, created_at)
         VALUES ('dup-2', 'template_step', 'exec-u1', 'step-x', 'out', 'json', 1, 1700000000000)`
      ).run();
    }).toThrow();
  });

  it("all 9 indexes exist on artifacts table", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedV71State(db);
    runMigrations(db);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'artifacts'"
    ).all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);

    expect(names).toContain("idx_artifacts_execution_id");
    expect(names).toContain("idx_artifacts_task_id");
    expect(names).toContain("idx_artifacts_chat_session_id");
    expect(names).toContain("idx_artifacts_role_id");
    expect(names).toContain("idx_artifacts_created_at");
    expect(names).toContain("idx_artifacts_source_kind");
    expect(names).toContain("idx_artifacts_template_step_key");
    expect(names).toContain("idx_artifacts_replaces");
    expect(names).toContain("idx_artifacts_content_hash");
  });

  it("v72 migration is idempotent — running runMigrations twice stays at 72", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    seedV71State(db);
    runMigrations(db);
    runMigrations(db); // must not throw

    const row = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(row.schema_version).toBe(90);
  });

  it("test-db schema matches production for artifacts table (no drift)", () => {
    const prodDb = new Database(":memory:");
    prodDb.pragma("foreign_keys = ON");
    prodDb.pragma("trusted_schema = ON");
    seedV71State(prodDb);
    runMigrations(prodDb);

    const { db: testDb, cleanup } = setupTestDb();
    try {
      const prodCols = (prodDb.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>)
        .map((c) => c.name);
      const testCols = (testDb.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>)
        .map((c) => c.name);
      expect(testCols, "column list mismatch for artifacts").toEqual(prodCols);
    } finally {
      cleanup();
    }
  });
});
