import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../store/db.js";

const LEGACY_COMPLETE_TRIGGER = ["work", "flow_complete"].join("");
const LEGACY_EXEC_TABLE = ["work", "flow_executions"].join("");
const LEGACY_EXEC_EVENT_INDEX = ["idx", "work", "flow_executions_event_id"].join("_");

function seedPreV28(db: Database.Database, version: number): void {
  db.exec(`
    CREATE TABLE server_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      schema_version INTEGER DEFAULT ${version}
    );
    INSERT INTO server_state (id, schema_version) VALUES (1, ${version});

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
      env_vars TEXT
    );
  `);
}

describe("store/db migrations", () => {
  it("adds roles.os_capabilities in schema v27", () => {
    const db = new Database(":memory:");
    seedPreV28(db, 26);

    runMigrations(db);

    const roleCols = db.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>;
    expect(roleCols.some((col) => col.name === "os_capabilities")).toBe(true);

    const state = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(state.schema_version).toBeGreaterThanOrEqual(41);

    db.close();
  });

  it("adds manager_decisions admission audit columns in schema v28", () => {
    const db = new Database(":memory:");
    seedPreV28(db, 27);

    runMigrations(db);

    const mdCols = db.prepare("PRAGMA table_info(manager_decisions)").all() as Array<{ name: string }>;
    const colNames = mdCols.map((c) => c.name);
    expect(colNames).toContain("requirements_json");
    expect(colNames).toContain("fit_score");
    expect(colNames).toContain("candidates_json");
    expect(colNames).toContain("tie_break_reason");

    const state = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(state.schema_version).toBeGreaterThanOrEqual(41);

    db.close();
  });

  it("v28 migration is idempotent — re-running does not duplicate or drop columns", () => {
    const db = new Database(":memory:");
    seedPreV28(db, 27);

    runMigrations(db);
    runMigrations(db);

    const mdCols = db.prepare("PRAGMA table_info(manager_decisions)").all() as Array<{ name: string }>;
    const colNames = mdCols.map((c) => c.name);
    for (const target of ["requirements_json", "fit_score", "candidates_json", "tie_break_reason"]) {
      expect(colNames.filter((n) => n === target)).toHaveLength(1);
    }

    db.close();
  });

  it("repairs legacy completion Template triggers", () => {
    const db = new Database(":memory:");
    seedPreV28(db, 40);
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
      INSERT INTO task_templates (
        id, name, trigger_type, trigger_event, steps, role_preference, enabled, created_at
      ) VALUES (
        'tmpl-legacy-trigger',
        'Legacy Trigger',
        '${LEGACY_COMPLETE_TRIGGER}',
        '${LEGACY_COMPLETE_TRIGGER}:tmpl-source',
        '[{"id":"s1","prompt":"Run"}]',
        'role-test-seed',
        1,
        1
      );
    `);

    runMigrations(db);

    const row = db.prepare(
      "SELECT trigger_type, trigger_event FROM task_templates WHERE id = 'tmpl-legacy-trigger'",
    ).get() as { trigger_type: string; trigger_event: string };
    expect(row.trigger_type).toBe("template_complete");
    expect(row.trigger_event).toBe("template_complete:tmpl-source");

    db.close();
  });

  it("renames legacy execution table and index to template_executions", () => {
    const db = new Database(":memory:");
    seedPreV28(db, 41);
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
      INSERT INTO task_templates (
        id, name, trigger_type, steps, role_preference, enabled, created_at
      ) VALUES (
        'tmpl-exec-migration',
        'Execution Migration',
        'manual',
        '[{"id":"s1","prompt":"Run"}]',
        'role-test-seed',
        1,
        1
      );
      CREATE TABLE ${LEGACY_EXEC_TABLE} (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        step_statuses TEXT NOT NULL DEFAULT '{}',
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT,
        event_id TEXT,
        FOREIGN KEY (template_id) REFERENCES task_templates(id)
      );
      CREATE INDEX ${LEGACY_EXEC_EVENT_INDEX} ON ${LEGACY_EXEC_TABLE}(event_id);
      INSERT INTO ${LEGACY_EXEC_TABLE} (id, template_id, status, step_statuses, started_at, event_id)
      VALUES ('exec-old', 'tmpl-exec-migration', 'completed', '{}', 1, 'event-old');
    `);

    runMigrations(db);

    const oldNames = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE name LIKE '%${LEGACY_EXEC_TABLE}%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(oldNames).toEqual([]);

    const row = db.prepare("SELECT id, event_id FROM template_executions WHERE id = 'exec-old'").get() as { id: string; event_id: string };
    expect(row).toEqual({ id: "exec-old", event_id: "event-old" });
    const newIndex = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_template_executions_event_id'",
    ).get();
    expect(newIndex).toBeDefined();

    db.close();
  });

  it("creates user_visible_events and backfills channel viewerKey in schema v54", () => {
    const db = new Database(":memory:");
    seedPreV28(db, 53);
    db.exec(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'disconnected',
        config TEXT NOT NULL,
        linked_role_id TEXT,
        allowed_chat_ids TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        last_message_at INTEGER,
        message_count INTEGER DEFAULT 0
      );
      INSERT INTO config (key, value, updated_at) VALUES ('identity.ownerViewerKey', '"owner-from-config"', 1);
      INSERT INTO channels (
        id, name, platform, enabled, status, config, created_at, message_count
      ) VALUES (
        'ch-old',
        'Old Email',
        'email',
        1,
        'connected',
        '{}',
        1,
        0
      );
    `);

    runMigrations(db);

    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='user_visible_events'",
    ).get();
    expect(table).toBeDefined();

    const columns = db.prepare("PRAGMA table_info(user_visible_events)").all() as Array<{ name: string }>;
    expect(columns.map((col) => col.name)).toEqual(expect.arrayContaining([
      "event_key",
      "viewer_key",
      "attachments_json",
      "targets_json",
      "last_delivered_at",
      "trace_id",
    ]));

    const channel = db.prepare("SELECT config, viewer_key FROM channels WHERE id = 'ch-old'").get() as { config: string; viewer_key: string | null };
    expect(channel.viewer_key).toBe("owner-from-config");
    expect(JSON.parse(channel.config)).not.toHaveProperty("viewerKey");

    const state = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(state.schema_version).toBeGreaterThanOrEqual(58);

    db.close();
  });

  it("creates runtime truth audit tables in schema v56", () => {
    const db = new Database(":memory:");
    seedPreV28(db, 55);

    runMigrations(db);

    const runtimeEffects = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_effects'",
    ).get();
    const commitmentAudits = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_commitment_audits'",
    ).get();
    expect(runtimeEffects).toBeDefined();
    expect(commitmentAudits).toBeDefined();

    const runtimeCols = db.prepare("PRAGMA table_info(runtime_effects)").all() as Array<{ name: string }>;
    expect(runtimeCols.map((col) => col.name)).toEqual(expect.arrayContaining([
      "trace_id",
      "effect_category",
      "entity_type",
      "field_path",
      "before_json",
      "after_json",
      "tool_name",
    ]));
    const auditCols = db.prepare("PRAGMA table_info(assistant_commitment_audits)").all() as Array<{ name: string }>;
    expect(auditCols.map((col) => col.name)).toContain("evidence_effect_ids");

    const state = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(state.schema_version).toBeGreaterThanOrEqual(56);

    db.close();
  });
});
