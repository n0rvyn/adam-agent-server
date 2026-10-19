import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "../shared/constants.js";
import { getLogger } from "../lib/logger.js";
import { migrateLegacyTemplateExecutionArtifactStorage } from "../lib/artifact-storage.js";

const log = getLogger("store");

const LEGACY_TEMPLATE_COMPLETE_TRIGGER = ["work", "flow_complete"].join("");
const LEGACY_TEMPLATE_COMPLETE_PREFIX = `${LEGACY_TEMPLATE_COMPLETE_TRIGGER}:`;
const LEGACY_EXECUTIONS_TABLE = ["work", "flow_executions"].join("");
const LEGACY_ARTIFACTS_TABLE = ["work", "flow_artifacts"].join("");
const LEGACY_EXECUTIONS_EVENT_INDEX = ["idx", "work", "flow_executions_event_id"].join("_");
const LEGACY_ARTIFACTS_EXECUTION_INDEX = ["idx", "work", "flow_artifacts_execution"].join("_");
const LEGACY_ARTIFACTS_STEP_INDEX = ["idx", "work", "flow_artifacts_step"].join("_");

let db: Database.Database | null = null;

export function runMigrations(database: Database.Database): void {
  // ===== Phase 2: Schema v2 — drop and recreate with skill terminology (DP-001, D-009) =====
  // Ensure server_state table exists (needed before version check; preserved across migrations).
  database.exec(`
    CREATE TABLE IF NOT EXISTS server_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      sdk_session_id TEXT,
      user_task_session_id TEXT,
      workspace_path TEXT,
      schema_version INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      last_active_at INTEGER
    );
  `);
  // Ensure schema_version column exists (may be absent if DB was created before Phase 2)
  const columns = database.prepare("PRAGMA table_info(server_state)").all() as Array<{ name: string }>;
  if (!columns.some(c => c.name === "schema_version")) {
    database.exec("ALTER TABLE server_state ADD COLUMN schema_version INTEGER DEFAULT 0");
  }

  // Guard: only run full recreate if schema_version < 2.
  // server_state is preserved (has session info worth keeping).
  const stateRow = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
  const currentVersion = stateRow?.schema_version ?? 0;

  if (currentVersion < 2) {
    // Drop all tables (except server_state which is preserved) and FTS tables
    const tablesToDrop = [
      "delivery_log",
      "delivery_rules",
      "manager_decisions",
      "skill_scores",
      "approval_rules",
      "task_plans",
      "calibration_history",
      "task_plugins",
      "marketplaces",
      "plugins",
      "trials",
      "strategies",
      "metric_tree",
      "goals",
      "chat_messages",
      "chat_sessions",
      "channels",
      "evolution_audit",
      "step_logs",
      "task_templates",
      "memories",
      "tasks",
      "config",
      "memories_fts",
      "memories_fts_config",
      "memories_fts_data",
      "memories_fts_docsize",
      "memories_fts_idx",
    ];
    for (const table of tablesToDrop) {
      try { database.exec(`DROP TABLE IF EXISTS ${table}`); } catch { /* ignore */ }
    }
    // Drop FTS sync triggers
    for (const trigger of [
      "memories_fts_insert",
      "memories_fts_delete",
      "memories_fts_update",
    ]) {
      try { database.exec(`DROP TRIGGER IF EXISTS ${trigger}`); } catch { /* ignore */ }
    }
  }

  // Always recreate fresh schema (CREATE TABLE IF NOT EXISTS handles idempotency).
  // Phase 2: skill terminology throughout.

  database.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
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
      total_duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_template_id ON tasks(template_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_role_id ON tasks(role_id);

    CREATE TABLE IF NOT EXISTS step_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      "index" INTEGER NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_name TEXT,
      tool_input TEXT,
      tool_output TEXT,
      truncated INTEGER DEFAULT 0,
      timestamp INTEGER NOT NULL,
      token_usage TEXT,
      plan_step_index INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_step_logs_task_index ON step_logs(task_id, "index");

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evolution_audit (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      old_rules TEXT,
      new_rules TEXT,
      diff TEXT,
      trigger_task_id TEXT,
      role_id TEXT,
      source TEXT DEFAULT 'reflection'
    );

    CREATE INDEX IF NOT EXISTS idx_evolution_audit_role_id ON evolution_audit(role_id);

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('event', 'thought', 'reflection')),
      content TEXT NOT NULL,
      embedding BLOB,
      keywords TEXT,
      importance INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 5),
      source_type TEXT NOT NULL,
      source_task_id TEXT,
      evidence TEXT,
      created_at INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL,
      retrieved_count INTEGER DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      keywords,
      content='memories',
      content_rowid='rowid'
    );

    CREATE INDEX IF NOT EXISTS idx_memories_role_id ON memories(role_id);
    CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);

    -- FTS5 content sync triggers
    CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.rowid, new.content, new.keywords);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES ('delete', old.rowid, old.content, old.keywords);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES ('delete', old.rowid, old.content, old.keywords);
      INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.rowid, new.content, new.keywords);
    END;
  `);

  // ===== Goal-Driven Architecture tables =====

  database.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      role TEXT NOT NULL,
      metric_type TEXT NOT NULL,
      target_value REAL NOT NULL,
      current_value REAL NOT NULL DEFAULT 0,
      deadline INTEGER NOT NULL,
      budget_usd REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      notify_targets TEXT,
      deliver_to TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
    CREATE INDEX IF NOT EXISTS idx_goals_deadline ON goals(deadline);

    CREATE TABLE IF NOT EXISTS metric_tree (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      level TEXT NOT NULL CHECK(level IN ('L0', 'L1', 'L2', 'L3')),
      parent_id TEXT REFERENCES metric_tree(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      description TEXT,
      weight REAL NOT NULL DEFAULT 1.0,
      calibration_factor REAL DEFAULT 1.0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_metric_tree_goal_id ON metric_tree(goal_id);
    CREATE INDEX IF NOT EXISTS idx_metric_tree_level ON metric_tree(level);
    CREATE INDEX IF NOT EXISTS idx_metric_tree_parent_id ON metric_tree(parent_id);

    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt_template TEXT NOT NULL,
      alpha REAL NOT NULL DEFAULT 0.5,
      beta REAL NOT NULL DEFAULT 0.5,
      total_trials INTEGER DEFAULT 0,
      avg_reward REAL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_strategies_role_task_type ON strategies(role_id, task_type, name);
    CREATE INDEX IF NOT EXISTS idx_strategies_role ON strategies(role_id);

    CREATE TABLE IF NOT EXISTS trials (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      reward REAL,
      metric_l2_score REAL,
      metric_l3_score REAL,
      context TEXT,
      completed_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trials_strategy_id ON trials(strategy_id);
    CREATE INDEX IF NOT EXISTS idx_trials_goal_id ON trials(goal_id);
    CREATE INDEX IF NOT EXISTS idx_trials_task_id ON trials(task_id);
    CREATE INDEX IF NOT EXISTS idx_trials_completed_at ON trials(completed_at);

    CREATE TABLE IF NOT EXISTS task_templates (
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
      goal_ids TEXT
    );

    CREATE TABLE IF NOT EXISTS task_plugins (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      plugin_path TEXT NOT NULL,
      plugin_name TEXT NOT NULL,
      role_id TEXT,
      used_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_plugins_task_id ON task_plugins(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_plugins_plugin_path ON task_plugins(plugin_path);
    CREATE INDEX IF NOT EXISTS idx_task_plugins_role_id ON task_plugins(role_id);
  `);

  // ===== Chat & Channels tables =====

  database.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
      source_type TEXT NOT NULL,
      source_channel_id TEXT,
      source_chat_id TEXT,
      title TEXT,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      archived_at INTEGER,
      message_count INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_status ON chat_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON chat_sessions(last_active_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_source ON chat_sessions(source_type, source_channel_id, source_chat_id);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      source_type TEXT NOT NULL,
      task_id TEXT,
      channel_message_id TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      cost_usd REAL,
      token_usage TEXT,
      model TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_task ON chat_messages(task_id);

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'disconnected',
      config TEXT NOT NULL,
      linked_role_id TEXT,
      allowed_chat_ids TEXT,
      viewer_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      last_message_at INTEGER,
      message_count INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_channels_platform ON channels(platform);
    CREATE INDEX IF NOT EXISTS idx_channels_enabled ON channels(enabled);
    CREATE INDEX IF NOT EXISTS idx_channels_linked_role_id ON channels(linked_role_id);
  `);

  // ===== Phase 3: Plan-Approve-Execute-Review-Learn (D-009, D-010, D-011, D-012) =====

  database.exec(`
    CREATE TABLE IF NOT EXISTS task_plans (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      plan_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied', 'completed')),
      approval_type TEXT CHECK(approval_type IN ('once', 'permanent')),
      deviation_report_json TEXT,
      learned_rules_json TEXT,
      created_at INTEGER NOT NULL,
      approved_at INTEGER,
      reviewed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_task_plans_task_id ON task_plans(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_plans_status ON task_plans(status);

    CREATE TABLE IF NOT EXISTS approval_rules (
      id TEXT PRIMARY KEY,
      role_id TEXT,
      task_pattern TEXT NOT NULL,
      max_risk_level TEXT NOT NULL CHECK(max_risk_level IN ('low', 'medium', 'high')),
      created_at INTEGER NOT NULL,
      created_by_task_id TEXT REFERENCES tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_approval_rules_role_id ON approval_rules(role_id);
  `);

  // ===== Phase 5: Monitor skill scores (D-002, D-003) =====

  database.exec(`
    CREATE TABLE IF NOT EXISTS role_scores (
      id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      score_json TEXT NOT NULL,
      ema_score REAL NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_role_scores_role_id ON role_scores(role_id);
    CREATE INDEX IF NOT EXISTS idx_role_scores_task_id ON role_scores(task_id);
    CREATE INDEX IF NOT EXISTS idx_role_scores_created_at ON role_scores(created_at);
  `);

  // ===== Phase 6: Manager decision audit (D-001) =====

  database.exec(`
    CREATE TABLE IF NOT EXISTS manager_decisions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      role_id TEXT,
      decision_type TEXT NOT NULL,
      boundary_json TEXT,
      reason TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_manager_decisions_task_id ON manager_decisions(task_id);
    CREATE INDEX IF NOT EXISTS idx_manager_decisions_role_id ON manager_decisions(role_id);
  `);

  // ===== Delivery Rules (D-001 through D-009) =====

  database.exec(`
    CREATE TABLE IF NOT EXISTS delivery_rules (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      match_criteria TEXT NOT NULL,
      target TEXT NOT NULL,
      format_template TEXT,
      max_per_minute INTEGER DEFAULT 5,
      skip_origin_channel INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      created_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_delivery_rules_event_type ON delivery_rules(event_type);
    CREATE INDEX IF NOT EXISTS idx_delivery_rules_enabled ON delivery_rules(enabled);

    CREATE TABLE IF NOT EXISTS delivery_log (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL REFERENCES delivery_rules(id),
      task_id TEXT REFERENCES tasks(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'failed', 'expired')),
      target TEXT NOT NULL,
      content TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_delivery_log_status ON delivery_log(status);
    CREATE INDEX IF NOT EXISTS idx_delivery_log_expires ON delivery_log(expires_at);
    CREATE INDEX IF NOT EXISTS idx_delivery_log_rule_id ON delivery_log(rule_id);
  `);

  // ===== LLM Cost Accounting (v84+) =====

  database.exec(`
    CREATE TABLE IF NOT EXISTS llm_costs (
      id TEXT PRIMARY KEY,
      call_id TEXT NOT NULL,
      source TEXT NOT NULL,
      model TEXT NOT NULL,
      role_id TEXT,
      task_id TEXT,
      session_id TEXT,
      message_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      priced INTEGER NOT NULL DEFAULT 0,
      estimated INTEGER NOT NULL DEFAULT 0,
      sdk_total_cost_usd REAL,
      num_turns INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_llm_costs_created ON llm_costs(created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_costs_source ON llm_costs(source);
    CREATE INDEX IF NOT EXISTS idx_llm_costs_model ON llm_costs(model);
    CREATE INDEX IF NOT EXISTS idx_llm_costs_role ON llm_costs(role_id);
  `);

  // ===== Calibration History =====

  database.exec(`
    CREATE TABLE IF NOT EXISTS calibration_history (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      factors_json TEXT NOT NULL,
      l0_score REAL NOT NULL,
      l1_trend REAL NOT NULL,
      l2_trend REAL NOT NULL,
      l3_trend REAL NOT NULL,
      applied INTEGER NOT NULL DEFAULT 0,
      computed_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_calibration_goal ON calibration_history(goal_id);
    CREATE INDEX IF NOT EXISTS idx_calibration_computed ON calibration_history(computed_at);
  `);

  // ===== Update schema_version to 2 =====
  // Ensure schema_version column exists (may be absent if DB was created before Phase 2)
  // ALTER is idempotent (try/catch), but the UPDATE must be inside the v2 guard
  // to avoid downgrading schema_version from a higher value on subsequent startups.
  if (currentVersion < 2) {
    database.exec(`UPDATE server_state SET schema_version = 2 WHERE id = 1`);
  }

  // Note: Schema v3 (agents execution_mode/model columns) removed in Phase 1 — agents table eliminated

  // ===== Schema v4: Role + Skill two-layer model (D-023) — Phase 1 update: add absorbed skill columns + role_plugins =====
  const v4Check = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
  if ((v4Check?.schema_version ?? 0) < 4) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        cag_prompt TEXT NOT NULL DEFAULT '',
        learned_rules TEXT,
        memory_stream_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'retired', 'probation', 'dead')),
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
        os_capabilities TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_roles_status ON roles(status);
      CREATE INDEX IF NOT EXISTS idx_roles_name ON roles(name);

      CREATE TABLE IF NOT EXISTS role_plugins (
        role_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        bound_at INTEGER NOT NULL,
        PRIMARY KEY (role_id, plugin_id)
      );
    `);

    // Add role_id to tasks table (DP-003: Role assigned at dispatch time)
    const taskCols = database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!taskCols.some(c => c.name === "role_id")) {
      database.exec("ALTER TABLE tasks ADD COLUMN role_id TEXT");
      database.exec("CREATE INDEX IF NOT EXISTS idx_tasks_role_id ON tasks(role_id)");
    }

    database.exec("UPDATE server_state SET schema_version = 4 WHERE id = 1");
  }

  // ===== Schema v5: skill_id → role_id for memories, scores, evolution (DP-001) =====
  const v5Check = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
  if ((v5Check?.schema_version ?? 0) < 5) {
    // Drop and recreate memories with role_id
    database.exec(`
      DROP TABLE IF EXISTS memories;
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('event', 'thought', 'reflection')),
        content TEXT NOT NULL,
        embedding BLOB,
        keywords TEXT,
        importance INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 5),
        source_type TEXT NOT NULL,
        source_task_id TEXT,
        evidence TEXT,
        created_at INTEGER NOT NULL,
        last_accessed INTEGER NOT NULL,
        retrieved_count INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_memories_role_id ON memories(role_id);
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, keywords,
        content='memories',
        content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.rowid, new.content, new.keywords);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES ('delete', old.rowid, old.content, old.keywords);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES ('delete', old.rowid, old.content, old.keywords);
        INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.rowid, new.content, new.keywords);
      END;
    `);

    // Drop and recreate skill_scores → role_scores
    database.exec(`
      DROP TABLE IF EXISTS skill_scores;
      CREATE TABLE IF NOT EXISTS role_scores (
        id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        score_json TEXT NOT NULL,
        ema_score REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_role_scores_role_id ON role_scores(role_id);
      CREATE INDEX IF NOT EXISTS idx_role_scores_task_id ON role_scores(task_id);
      CREATE INDEX IF NOT EXISTS idx_role_scores_created_at ON role_scores(created_at);
    `);

    // Recreate evolution_audit with role_id
    database.exec(`
      DROP TABLE IF EXISTS evolution_audit;
      CREATE TABLE evolution_audit (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        old_rules TEXT,
        new_rules TEXT,
        diff TEXT,
        trigger_task_id TEXT,
        role_id TEXT,
        source TEXT DEFAULT 'reflection'
      );
      CREATE INDEX IF NOT EXISTS idx_evolution_audit_role_id ON evolution_audit(role_id);
    `);

    database.exec("UPDATE server_state SET schema_version = 5 WHERE id = 1");
  }

  // ===== Schema v6: Add importance_trigger_curr to roles table (DP-001: reflection counter per role) =====
  const v6Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
  if ((v6Row?.schema_version ?? 0) < 6) {
    const roleCols = database.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>;
    if (!roleCols.some(c => c.name === "importance_trigger_curr")) {
      database.exec("ALTER TABLE roles ADD COLUMN importance_trigger_curr INTEGER DEFAULT 150");
    }
    database.exec("UPDATE server_state SET schema_version = 6 WHERE id = 1");
  }

  // ===== Schema v7: Add source_session_id to tasks (result delivery routing) =====
  const v7Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
  if ((v7Row?.schema_version ?? 0) < 7) {
    const taskCols7 = database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!taskCols7.some(c => c.name === "source_session_id")) {
      database.exec("ALTER TABLE tasks ADD COLUMN source_session_id TEXT");
    }
    database.exec("UPDATE server_state SET schema_version = 7 WHERE id = 1");
  }

  // ===== Schema v8: Goal + Automation chat binding (Phase 3.5) =====
  const v8Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
  if ((v8Row?.schema_version ?? 0) < 8) {
    const goalCols = database.prepare("PRAGMA table_info(goals)").all() as Array<{ name: string }>;
    if (!goalCols.some(c => c.name === "source_session_id")) {
      database.exec("ALTER TABLE goals ADD COLUMN source_session_id TEXT");
    }
    if (!goalCols.some(c => c.name === "notify_targets")) {
      database.exec("ALTER TABLE goals ADD COLUMN notify_targets TEXT");
    }

    const templateCols = database.prepare("PRAGMA table_info(task_templates)").all() as Array<{ name: string }>;
    if (!templateCols.some(c => c.name === "source_session_id")) {
      database.exec("ALTER TABLE task_templates ADD COLUMN source_session_id TEXT");
    }
    if (!templateCols.some(c => c.name === "notify_targets")) {
      database.exec("ALTER TABLE task_templates ADD COLUMN notify_targets TEXT");
    }
    if (!templateCols.some(c => c.name === "goal_ids")) {
      database.exec("ALTER TABLE task_templates ADD COLUMN goal_ids TEXT");
    }

    // Migrate existing goals: old states → new "active" state
    database.exec("UPDATE goals SET status = 'active' WHERE status IN ('pending','planning','executing','evaluating','replanning')");

    database.exec("UPDATE server_state SET schema_version = 8 WHERE id = 1");
  }

  // ===== Schema v10: Eliminate Skill entity — absorb into Role (Phase 1) =====
  const v10Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
  if ((v10Row?.schema_version ?? 0) < 10) {
    // Disable foreign keys for table recreation (required by SQLite when dropping referenced tables)
    database.exec("PRAGMA foreign_keys = OFF");

    // Clean up any residual _new tables from a previously failed migration attempt
    database.exec("DROP TABLE IF EXISTS tasks_new");
    database.exec("DROP TABLE IF EXISTS chat_sessions_new");
    database.exec("DROP TABLE IF EXISTS task_plans_new");
    database.exec("DROP TABLE IF EXISTS task_plugins_new");
    database.exec("DROP TABLE IF EXISTS approval_rules_new");
    database.exec("DROP TABLE IF EXISTS manager_decisions_new");
    database.exec("DROP TABLE IF EXISTS channels_new");

    // Add new columns to roles table
    const roleCols = database.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>;
    if (!roleCols.some(c => c.name === "allowed_tools")) {
      database.exec("ALTER TABLE roles ADD COLUMN allowed_tools TEXT");
    }
    if (!roleCols.some(c => c.name === "disallowed_tools")) {
      database.exec("ALTER TABLE roles ADD COLUMN disallowed_tools TEXT");
    }
    if (!roleCols.some(c => c.name === "evaluation_criteria")) {
      database.exec("ALTER TABLE roles ADD COLUMN evaluation_criteria TEXT");
    }
    if (!roleCols.some(c => c.name === "execution_mode")) {
      database.exec("ALTER TABLE roles ADD COLUMN execution_mode TEXT DEFAULT 'isolated'");
    }
    if (!roleCols.some(c => c.name === "model")) {
      database.exec("ALTER TABLE roles ADD COLUMN model TEXT");
    }
    if (!roleCols.some(c => c.name === "max_budget_usd")) {
      database.exec("ALTER TABLE roles ADD COLUMN max_budget_usd REAL");
    }
    if (!roleCols.some(c => c.name === "approval_required")) {
      database.exec("ALTER TABLE roles ADD COLUMN approval_required TEXT");
    }
    if (!roleCols.some(c => c.name === "source")) {
      database.exec("ALTER TABLE roles ADD COLUMN source TEXT DEFAULT 'system'");
    }

    // Drop agents table (SkillProfile storage)
    database.exec("DROP TABLE IF EXISTS agents");

    // Drop role_skills junction table
    database.exec("DROP TABLE IF EXISTS role_skills");

    // Drop skill_id from tasks — recreate without it, copy data
    database.exec(`
      CREATE TABLE IF NOT EXISTS tasks_new (
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
        total_duration_ms INTEGER
      );
    `);
    // Use COALESCE only for NOT NULL columns; nullable columns are selected directly
    const notNullCols = new Set(["id", "status", "prompt", "config", "created_at"]);
    const allTaskCols = ["id","parent_id","status","prompt","config","result","error","sdk_session_id","template_id","original_prompt","role_id","source_session_id","notify_targets","deliver_to","report_to","created_at","started_at","completed_at","cost_usd","token_usage","num_turns","total_duration_ms"];
    // Source table may not have deliver_to/report_to — use NULL fallback for columns that don't exist
    const srcCols = new Set((database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(c => c.name));
    const selectExpr = allTaskCols.map(c => {
      if (!srcCols.has(c)) return "NULL";
      return notNullCols.has(c) ? `COALESCE(${c}, '')` : c;
    }).join(",");
    database.exec(`INSERT INTO tasks_new SELECT ${selectExpr} FROM tasks`);
    database.exec("DROP TABLE tasks");
    database.exec("ALTER TABLE tasks_new RENAME TO tasks");
    database.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_tasks_template_id ON tasks(template_id)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_tasks_role_id ON tasks(role_id)");

    // Drop skill_id from chat_sessions — recreate without it, copy data
    database.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions_new (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
        source_type TEXT NOT NULL,
        source_channel_id TEXT,
        source_chat_id TEXT,
        title TEXT,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        archived_at INTEGER,
        message_count INTEGER DEFAULT 0
      );
    `);
    database.exec("INSERT INTO chat_sessions_new SELECT id,status,source_type,source_channel_id,source_chat_id,title,created_at,last_active_at,archived_at,message_count FROM chat_sessions");
    database.exec("DROP TABLE chat_sessions");
    database.exec("ALTER TABLE chat_sessions_new RENAME TO chat_sessions");
    database.exec("CREATE INDEX IF NOT EXISTS idx_sessions_status ON chat_sessions(status)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON chat_sessions(last_active_at)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_sessions_source ON chat_sessions(source_type, source_channel_id, source_chat_id)");

    // Drop skill_id from task_plans — recreate without it, copy data
    database.exec(`
      CREATE TABLE IF NOT EXISTS task_plans_new (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        plan_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied', 'completed')),
        approval_type TEXT CHECK(approval_type IN ('once', 'permanent')),
        deviation_report_json TEXT,
        learned_rules_json TEXT,
        created_at INTEGER NOT NULL,
        approved_at INTEGER,
        reviewed_at INTEGER
      );
    `);
    database.exec("INSERT INTO task_plans_new SELECT id,task_id,plan_json,status,approval_type,deviation_report_json,learned_rules_json,created_at,approved_at,reviewed_at FROM task_plans");
    database.exec("DROP TABLE task_plans");
    database.exec("ALTER TABLE task_plans_new RENAME TO task_plans");
    database.exec("CREATE INDEX IF NOT EXISTS idx_task_plans_task_id ON task_plans(task_id)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_task_plans_status ON task_plans(status)");

    // task_plugins: rename skill_id → role_id (skip if already migrated)
    const tpCols = database.prepare("PRAGMA table_info(task_plugins)").all() as Array<{ name: string }>;
    if (tpCols.some(c => c.name === "skill_id")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS task_plugins_new (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          plugin_path TEXT NOT NULL,
          plugin_name TEXT NOT NULL,
          role_id TEXT,
          used_at INTEGER NOT NULL
        );
      `);
      database.exec("INSERT INTO task_plugins_new SELECT id,task_id,plugin_path,plugin_name,skill_id,used_at FROM task_plugins");
      database.exec("DROP TABLE task_plugins");
      database.exec("ALTER TABLE task_plugins_new RENAME TO task_plugins");
    }
    database.exec("CREATE INDEX IF NOT EXISTS idx_task_plugins_task_id ON task_plugins(task_id)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_task_plugins_plugin_path ON task_plugins(plugin_path)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_task_plugins_role_id ON task_plugins(role_id)");

    // approval_rules: rename skill_id → role_id (skip if already migrated)
    const arCols = database.prepare("PRAGMA table_info(approval_rules)").all() as Array<{ name: string }>;
    if (arCols.some(c => c.name === "skill_id")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS approval_rules_new (
          id TEXT PRIMARY KEY,
          role_id TEXT,
          task_pattern TEXT NOT NULL,
          max_risk_level TEXT NOT NULL CHECK(max_risk_level IN ('low', 'medium', 'high')),
          created_at INTEGER NOT NULL,
          created_by_task_id TEXT REFERENCES tasks(id)
        );
      `);
      database.exec("INSERT INTO approval_rules_new SELECT id,skill_id,task_pattern,max_risk_level,created_at,created_by_task_id FROM approval_rules");
      database.exec("DROP TABLE approval_rules");
      database.exec("ALTER TABLE approval_rules_new RENAME TO approval_rules");
    }
    database.exec("CREATE INDEX IF NOT EXISTS idx_approval_rules_role_id ON approval_rules(role_id)");

    // manager_decisions: rename skill_id → role_id (skip if already migrated)
    const mdCols = database.prepare("PRAGMA table_info(manager_decisions)").all() as Array<{ name: string }>;
    if (mdCols.some(c => c.name === "skill_id")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS manager_decisions_new (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          role_id TEXT,
          decision_type TEXT NOT NULL,
          boundary_json TEXT,
          reason TEXT,
          created_at INTEGER NOT NULL
        );
      `);
      database.exec("INSERT INTO manager_decisions_new SELECT id,task_id,skill_id,decision_type,boundary_json,reason,created_at FROM manager_decisions");
      database.exec("DROP TABLE manager_decisions");
      database.exec("ALTER TABLE manager_decisions_new RENAME TO manager_decisions");
    }
    database.exec("CREATE INDEX IF NOT EXISTS idx_manager_decisions_task_id ON manager_decisions(task_id)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_manager_decisions_role_id ON manager_decisions(role_id)");

    // channels: rename linked_skill_id → linked_role_id (skip if already migrated)
    const chCols = database.prepare("PRAGMA table_info(channels)").all() as Array<{ name: string }>;
    if (chCols.some(c => c.name === "linked_skill_id")) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS channels_new (
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
      `);
      database.exec("INSERT INTO channels_new SELECT id,name,platform,enabled,status,config,linked_skill_id,allowed_chat_ids,created_at,updated_at,last_message_at,message_count FROM channels");
      database.exec("DROP TABLE channels");
      database.exec("ALTER TABLE channels_new RENAME TO channels");
    }
    database.exec("CREATE INDEX IF NOT EXISTS idx_channels_platform ON channels(platform)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_channels_enabled ON channels(enabled)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_channels_linked_role_id ON channels(linked_role_id)");

    // Create role_plugins junction table
    database.exec(`
      CREATE TABLE IF NOT EXISTS role_plugins (
        role_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        bound_at INTEGER NOT NULL,
        PRIMARY KEY (role_id, plugin_id)
      );
    `);

    database.exec("UPDATE server_state SET schema_version = 10 WHERE id = 1");

    // Re-enable foreign keys after table recreation
    database.exec("PRAGMA foreign_keys = ON");
  }

  // ===== Schema v11: rename task_templates.skill_preference → role_preference (DP-003) =====
  if (currentVersion < 11) {
    try {
      database.exec("ALTER TABLE task_templates RENAME COLUMN skill_preference TO role_preference");
    } catch (err) {
      // Column may already be renamed (e.g. DB created fresh with v11 schema)
      const colRows = database.prepare("PRAGMA table_info(task_templates)").all() as Array<{ name: string }>;
      const hasRolePref = colRows.some(c => c.name === "role_preference");
      const hasSkillPref = colRows.some(c => c.name === "skill_preference");
      if (!hasRolePref && hasSkillPref) {
        throw err; // re-throw if truly missing
      }
      // Otherwise: column already renamed or doesn't exist — non-fatal
    }
    database.exec("UPDATE server_state SET schema_version = 11 WHERE id = 1");
  }

  // ===== Schema v12: Add tools_fingerprint to server_state (session invalidation on tool changes) =====
  if (currentVersion < 12) {
    const ssCols = database.prepare("PRAGMA table_info(server_state)").all() as Array<{ name: string }>;
    if (!ssCols.some(c => c.name === "tools_fingerprint")) {
      database.exec("ALTER TABLE server_state ADD COLUMN tools_fingerprint TEXT");
    }
    database.exec("UPDATE server_state SET schema_version = 12 WHERE id = 1");
  }
  // ===== Schema v13: Add additional_directories to roles (Role multi-directory access) =====
  if (currentVersion < 13) {
    const roleCols13 = database.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>;
    if (!roleCols13.some(c => c.name === "additional_directories")) {
      database.exec("ALTER TABLE roles ADD COLUMN additional_directories TEXT");
    }
    database.exec("UPDATE server_state SET schema_version = 13 WHERE id = 1");
  }
  // ===== Schema v14: Role capabilities (allowed_channels, mcp_servers) + task/goal delivery targets =====
  if (currentVersion < 14) {
    const roleCols14 = database.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>;
    if (!roleCols14.some(c => c.name === "allowed_channels")) {
      database.exec("ALTER TABLE roles ADD COLUMN allowed_channels TEXT");
    }
    if (!roleCols14.some(c => c.name === "mcp_servers")) {
      database.exec("ALTER TABLE roles ADD COLUMN mcp_servers TEXT");
    }
    const taskCols14 = database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!taskCols14.some(c => c.name === "deliver_to")) {
      database.exec("ALTER TABLE tasks ADD COLUMN deliver_to TEXT");
    }
    if (!taskCols14.some(c => c.name === "report_to")) {
      database.exec("ALTER TABLE tasks ADD COLUMN report_to TEXT");
    }
    const goalCols14 = database.prepare("PRAGMA table_info(goals)").all() as Array<{ name: string }>;
    if (!goalCols14.some(c => c.name === "deliver_to")) {
      database.exec("ALTER TABLE goals ADD COLUMN deliver_to TEXT");
    }
    database.exec("UPDATE server_state SET schema_version = 14 WHERE id = 1");
  }
  // ===== Schema v15: Role inheritUserSettings =====
  if (currentVersion < 15) {
    const roleCols15 = database.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>;
    if (!roleCols15.some(c => c.name === "inherit_user_settings")) {
      database.exec("ALTER TABLE roles ADD COLUMN inherit_user_settings INTEGER DEFAULT 0");
    }
    database.exec("UPDATE server_state SET schema_version = 15 WHERE id = 1");
  }
  // ===== Schema v16: task_templates deliver_to (D-005) =====
  if (currentVersion < 16) {
    const templateCols = database.prepare("PRAGMA table_info(task_templates)").all() as Array<{ name: string }>;
    if (!templateCols.some(c => c.name === "deliver_to")) {
      database.exec("ALTER TABLE task_templates ADD COLUMN deliver_to TEXT");
    }
    database.exec("UPDATE server_state SET schema_version = 16 WHERE id = 1");
  }
  // ===== Schema v17: Drop deprecated plugin tables, migrate additionalDirectories (D-005, D-007, D-015) =====
  if (currentVersion < 17) {
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("DROP TABLE IF EXISTS plugins");
    database.exec("DROP TABLE IF EXISTS role_plugins");
    database.exec("DROP TABLE IF EXISTS marketplaces");
    database.exec("DROP INDEX IF EXISTS idx_plugins_source");
    database.exec("DROP INDEX IF EXISTS idx_plugins_enabled");
    // Migrate additional_directories: string[] → { path: string }[]
    try {
      const addDirRows = database.prepare("SELECT id, additional_directories FROM roles WHERE additional_directories IS NOT NULL").all() as Array<{ id: string; additional_directories: string }>;
      for (const row of addDirRows) {
        try {
          const parsed: unknown[] = JSON.parse(row.additional_directories);
          if (parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null && "path" in (parsed[0] as Record<string, unknown>)) {
            continue;
          }
          const migrated = parsed.map((item) => typeof item === "string" ? { path: item } : item);
          database.prepare("UPDATE roles SET additional_directories = ? WHERE id = ?").run(JSON.stringify(migrated), row.id);
        } catch { /* malformed JSON */ }
      }
    } catch { /* table may not exist in fresh DB */ }
    // Safety: ensure tasks.deliver_to and tasks.report_to exist (may be missing if earlier migration had issues)
    const taskCols17 = database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!taskCols17.some(c => c.name === "deliver_to")) {
      database.exec("ALTER TABLE tasks ADD COLUMN deliver_to TEXT");
    }
    if (!taskCols17.some(c => c.name === "report_to")) {
      database.exec("ALTER TABLE tasks ADD COLUMN report_to TEXT");
    }

    // Rename strategies.role → strategies.role_id (pre-existing mismatch)
    const stratCols = database.prepare("PRAGMA table_info(strategies)").all() as Array<{ name: string }>;
    if (stratCols.some(c => c.name === "role") && !stratCols.some(c => c.name === "role_id")) {
      database.exec("ALTER TABLE strategies RENAME COLUMN role TO role_id");
      // Recreate indexes with new column name
      database.exec("DROP INDEX IF EXISTS idx_strategies_role_task_type");
      database.exec("DROP INDEX IF EXISTS idx_strategies_role");
      database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_strategies_role_task_type ON strategies(role_id, task_type, name)");
      database.exec("CREATE INDEX IF NOT EXISTS idx_strategies_role ON strategies(role_id)");
    }

    database.exec("UPDATE server_state SET schema_version = 17 WHERE id = 1");
    database.exec("PRAGMA foreign_keys = ON");
  }

  // ===== Schema v18: safety fixes for columns that may be missing from broken migration chains =====
  if (currentVersion < 18) {
    const taskCols18 = database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!taskCols18.some(c => c.name === "deliver_to")) {
      database.exec("ALTER TABLE tasks ADD COLUMN deliver_to TEXT");
    }
    if (!taskCols18.some(c => c.name === "report_to")) {
      database.exec("ALTER TABLE tasks ADD COLUMN report_to TEXT");
    }
    const stratCols18 = database.prepare("PRAGMA table_info(strategies)").all() as Array<{ name: string }>;
    if (stratCols18.some(c => c.name === "role") && !stratCols18.some(c => c.name === "role_id")) {
      database.exec("ALTER TABLE strategies RENAME COLUMN role TO role_id");
      database.exec("DROP INDEX IF EXISTS idx_strategies_role_task_type");
      database.exec("DROP INDEX IF EXISTS idx_strategies_role");
      database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_strategies_role_task_type ON strategies(role_id, task_type, name)");
      database.exec("CREATE INDEX IF NOT EXISTS idx_strategies_role ON strategies(role_id)");
    }
    database.exec("UPDATE server_state SET schema_version = 18 WHERE id = 1");
  }

  // ===== Schema v19: delivery_log nullable rule_id + source + message_type (OutboundGateway D-002) =====
  // Uses column-existence check (not schema_version) because earlier broken migration may have
  // bumped the version without applying the table changes.
  const logCols19 = database.prepare("PRAGMA table_info(delivery_log)").all() as Array<{ name: string }>;
  if (!logCols19.some(c => c.name === "source")) {
    // Recreate delivery_log: rule_id nullable, add source + message_type
    database.exec(`
      CREATE TABLE IF NOT EXISTS delivery_log_new (
        id TEXT PRIMARY KEY,
        rule_id TEXT REFERENCES delivery_rules(id),
        task_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        target TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        expires_at INTEGER NOT NULL,
        source TEXT,
        message_type TEXT
      )
    `);
    database.exec(`INSERT INTO delivery_log_new (id, rule_id, task_id, status, target, content, attempts, error, created_at, delivered_at, expires_at)
      SELECT id, rule_id, task_id, status, target, content, attempts, error, created_at, delivered_at, expires_at FROM delivery_log`);
    database.exec("DROP TABLE delivery_log");
    database.exec("ALTER TABLE delivery_log_new RENAME TO delivery_log");
    database.exec("CREATE INDEX IF NOT EXISTS idx_delivery_log_rule ON delivery_log(rule_id)");
    database.exec("CREATE INDEX IF NOT EXISTS idx_delivery_log_task ON delivery_log(task_id)");
  }

  // ===== Schema v20: report_to columns for goals + task_templates (OutboundGateway D-007) =====
  const v20Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
  if ((v20Row?.schema_version ?? 0) < 20) {
    const goalCols = database.prepare("PRAGMA table_info(goals)").all() as Array<{ name: string }>;
    if (!goalCols.some(c => c.name === "report_to")) {
      database.exec("ALTER TABLE goals ADD COLUMN report_to TEXT");
    }
    const tmplCols = database.prepare("PRAGMA table_info(task_templates)").all() as Array<{ name: string }>;
    if (!tmplCols.some(c => c.name === "report_to")) {
      database.exec("ALTER TABLE task_templates ADD COLUMN report_to TEXT");
    }
    // D-007 data migration: notifyTargets = status summary = reportTo semantic
    database.exec(`UPDATE goals SET report_to = notify_targets WHERE notify_targets IS NOT NULL`);
    database.exec(`UPDATE task_templates SET report_to = notify_targets WHERE notify_targets IS NOT NULL`);
    database.exec("UPDATE server_state SET schema_version = 20 WHERE id = 1");
  }

  // ===== Schema v21: Add updated_at to config table (Config DB persistence) =====
  const configCols = database.prepare("PRAGMA table_info(config)").all() as Array<{ name: string }>;
  if (!configCols.some(c => c.name === "updated_at")) {
    database.exec("ALTER TABLE config ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
    database.exec("UPDATE server_state SET schema_version = 21 WHERE id = 1");
  }

  // ===== Schema v22: Add tier + superseded_by to memories (Memory Framework Overhaul) =====
  const memCols22 = database.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  if (!memCols22.some(c => c.name === "tier")) {
    database.exec("ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'episodic'");
    database.exec("CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier)");
  }
  if (!memCols22.some(c => c.name === "superseded_by")) {
    database.exec("ALTER TABLE memories ADD COLUMN superseded_by TEXT");
    database.exec("CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by)");
  }
  // Bump version only if both columns now exist
  const memCols22b = database.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  if (memCols22b.some(c => c.name === "tier") && memCols22b.some(c => c.name === "superseded_by")) {
    const v22 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v22?.schema_version ?? 0) < 22) {
      database.exec("UPDATE server_state SET schema_version = 22 WHERE id = 1");
    }
  }

  // ===== Schema v23: Add permissionMode + Bash patterns to roles =====
  {
    const roleCols23 = database.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>;
    if (!roleCols23.some(c => c.name === "permission_mode")) {
      database.exec("ALTER TABLE roles ADD COLUMN permission_mode TEXT DEFAULT NULL");
    }
    if (!roleCols23.some(c => c.name === "allowed_bash_patterns")) {
      database.exec("ALTER TABLE roles ADD COLUMN allowed_bash_patterns TEXT DEFAULT NULL");
    }
    if (!roleCols23.some(c => c.name === "denied_bash_patterns")) {
      database.exec("ALTER TABLE roles ADD COLUMN denied_bash_patterns TEXT DEFAULT NULL");
    }
    const v23 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v23?.schema_version ?? 0) < 23) {
      database.exec("UPDATE server_state SET schema_version = 23 WHERE id = 1");
    }
  }

  // ===== Schema v24: Role env_vars column =====
  {
    const roleCols24 = database.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>;
    if (!roleCols24.some(c => c.name === "env_vars")) {
      database.prepare("ALTER TABLE roles ADD COLUMN env_vars TEXT DEFAULT NULL").run();
    }
    const v24 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v24?.schema_version ?? 0) < 24) {
      database.prepare("UPDATE server_state SET schema_version = 24 WHERE id = 1").run();
    }
  }

  // ===== Schema v25: template_executions table (Issue #154) =====
  if (currentVersion < 25) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS template_executions (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        step_statuses TEXT NOT NULL DEFAULT '{}',
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT,
        FOREIGN KEY (template_id) REFERENCES task_templates(id)
      )
    `);
    database.exec("UPDATE server_state SET schema_version = 25 WHERE id = 1");
  }

  // ===== Schema v26: template_execution_artifacts + artifact_access_log + tasks.step_id =====
  if (currentVersion < 26) {
    const templateExecutionArtifactsSql = `
      CREATE TABLE IF NOT EXISTS template_execution_artifacts (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('json', 'file')),
        value_json TEXT,
        blob_path TEXT,
        mime TEXT,
        size_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(execution_id, step_id, key),
        FOREIGN KEY (execution_id) REFERENCES template_executions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_template_execution_artifacts_execution
        ON template_execution_artifacts (execution_id);
      CREATE INDEX IF NOT EXISTS idx_template_execution_artifacts_step
        ON template_execution_artifacts (execution_id, step_id);
    `;
    const artifactAccessLogSql = `
      CREATE TABLE IF NOT EXISTS artifact_access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        task_id TEXT,
        role_id TEXT,
        execution_id TEXT NOT NULL,
        step_id TEXT,
        tool TEXT NOT NULL,
        artifact_key TEXT,
        artifact_id TEXT,
        size_bytes INTEGER,
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'denied', 'error')),
        error_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_artifact_access_log_execution
        ON artifact_access_log (execution_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_artifact_access_log_role
        ON artifact_access_log (role_id, timestamp);
    `;

    database.exec(templateExecutionArtifactsSql);
    database.exec(artifactAccessLogSql);

    const taskCols26 = database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!taskCols26.some((c) => c.name === "step_id")) {
      database.prepare("ALTER TABLE tasks ADD COLUMN step_id TEXT").run();
    }

    database.exec("UPDATE server_state SET schema_version = 26 WHERE id = 1");
  }

  // ===== Schema v27: role os_capabilities =====
  {
    const roleCols27 = database.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>;
    if (!roleCols27.some((c) => c.name === "os_capabilities")) {
      database.prepare("ALTER TABLE roles ADD COLUMN os_capabilities TEXT DEFAULT NULL").run();
    }
    const v27 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v27?.schema_version ?? 0) < 27) {
      database.prepare("UPDATE server_state SET schema_version = 27 WHERE id = 1").run();
    }
  }

  // ===== Schema v28: manager_decisions admission audit columns =====
  {
    const mdCols28 = database.prepare("PRAGMA table_info(manager_decisions)").all() as Array<{ name: string }>;
    if (!mdCols28.some((c) => c.name === "requirements_json")) {
      database.prepare("ALTER TABLE manager_decisions ADD COLUMN requirements_json TEXT").run();
    }
    if (!mdCols28.some((c) => c.name === "fit_score")) {
      database.prepare("ALTER TABLE manager_decisions ADD COLUMN fit_score REAL").run();
    }
    if (!mdCols28.some((c) => c.name === "candidates_json")) {
      database.prepare("ALTER TABLE manager_decisions ADD COLUMN candidates_json TEXT").run();
    }
    if (!mdCols28.some((c) => c.name === "tie_break_reason")) {
      database.prepare("ALTER TABLE manager_decisions ADD COLUMN tie_break_reason TEXT").run();
    }
    const v28 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v28?.schema_version ?? 0) < 28) {
      database.prepare("UPDATE server_state SET schema_version = 28 WHERE id = 1").run();
    }
  }

  // ===== Code migration: approvalRequired regex → glob =====
  {
    // Converts known default regex patterns to glob equivalents.
    // Unknown patterns are preserved as-is (no data dropped).
    // Glob syntax: `*` matches any characters; no other regex metacharacters.
    const regexToGlob: Array<[RegExp, string[]]> = [
      [/\brm -rf\b/, ["rm -rf *"]],
      [/^git push/, ["git push*"]],
      [/^git reset/, ["git reset*"]],
      [/\bcurl.*POST\b/i, ["curl * -X POST*", "curl * --request POST*"]],
    ];

    const rows = database.prepare("SELECT key, value FROM config WHERE key = 'defaults.approvalRequired'").all() as Array<{ key: string; value: string }>;
    for (const row of rows) {
      try {
        const patterns: string[] = JSON.parse(row.value);
        const migrated: string[] = [];
        for (const p of patterns) {
          let matched = false;
          for (const [re, globs] of regexToGlob) {
            if (re.test(p)) {
              migrated.push(...globs);
              matched = true;
              log.info({ from: p, to: globs }, "Config: migrated approvalRequired pattern from regex to glob");
              break;
            }
          }
          if (!matched) {
            // Preserve unknown patterns (no data dropped)
            if (/[.+?^${}()|[\]\\]/.test(p)) {
              log.warn({ pattern: p }, "Config: approvalRequired pattern contains regex metacharacters that won't work with glob matching; update to glob syntax (use * for wildcards)");
            }
            migrated.push(p);
          }
        }
        // Deduplicate in case migration runs multiple times
        const unique = [...new Set(migrated)];
        database.prepare("UPDATE config SET value = ?, updated_at = ? WHERE key = ?")
          .run(JSON.stringify(unique), Date.now(), row.key);
      } catch { /* skip invalid JSON */ }
    }
  }

  // ===== Schema v31: normalize legacy template trigger types =====
  // Consolidates the original v29/v30 split into one pass.
  {
    const v31 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v31?.schema_version ?? 0) < 31) {
      const legacyCount = database.prepare(
        "SELECT count(*) AS n FROM task_templates WHERE trigger_type IN ('event', 'task_complete')",
      ).get() as { n: number };
      if (legacyCount.n > 0) {
        log.info({ legacyCount: legacyCount.n }, "normalizing legacy template trigger types");
      }
      database.prepare(`
        UPDATE task_templates
        SET trigger_type='template_complete',
            trigger_event=REPLACE(trigger_event, ?, 'template_complete:')
        WHERE trigger_type='event' AND trigger_event LIKE ?
      `).run(LEGACY_TEMPLATE_COMPLETE_PREFIX, `${LEGACY_TEMPLATE_COMPLETE_PREFIX}%`);
      database.prepare(
        "UPDATE task_templates SET trigger_type='template_complete' WHERE trigger_type='event'",
      ).run();
      database.prepare(
        "UPDATE task_templates SET trigger_type='manual' WHERE trigger_type='task_complete'",
      ).run();

      const orphan = database.prepare(
        "SELECT count(*) AS n FROM task_templates WHERE trigger_type IN ('event', 'task_complete')",
      ).get() as { n: number };
      if (orphan.n > 0) {
        log.warn({ orphan: orphan.n }, "migration left orphan legacy trigger_type rows; manual inspection required");
      }

      database.prepare("UPDATE server_state SET schema_version = 31 WHERE id = 1").run();
    }
  }

  // ===== Schema v32: event_defs + events (Event Slot) =====
  {
    const v32 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v32?.schema_version ?? 0) < 32) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS event_defs (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, source_type TEXT NOT NULL,
          source_config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
          description TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_event_defs_source_type ON event_defs(source_type, enabled);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_event_defs_name ON event_defs(name);

        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY, event_def_id TEXT,
          occurred_at TEXT NOT NULL, ingested_at TEXT NOT NULL, user_day TEXT,
          source TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0, dedup_key TEXT NOT NULL,
          related_entities TEXT, trust_level TEXT NOT NULL DEFAULT 'trusted'
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedup ON events(source, dedup_key);
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
        CREATE INDEX IF NOT EXISTS idx_events_def_id ON events(event_def_id, occurred_at);
      `);
      database.prepare("UPDATE server_state SET schema_version = 32 WHERE id = 1").run();
    }
  }

  // v33: add event_id column to template_executions for event to dispatch correlation.
  // Column-existence check per CLAUDE.md §3 migration rules (not relying on schema_version alone).
  // Table-existence check handles fresh DBs where template_executions is created later (or
  // by test seeders that don't include this table yet).
  {
    const v33 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v33?.schema_version ?? 0) < 33) {
      const tableRow = database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name IN ('template_executions', ?)
        ORDER BY CASE name WHEN 'template_executions' THEN 0 ELSE 1 END
        LIMIT 1
      `).get(LEGACY_EXECUTIONS_TABLE) as { name: string } | undefined;
      if (tableRow) {
        const tableName = tableRow.name;
        const cols = database.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
        const hasEventId = cols.some((c) => c.name === "event_id");
        if (!hasEventId) {
          database.prepare(`ALTER TABLE ${tableName} ADD COLUMN event_id TEXT`).run();
        }
        const indexName = tableName === "template_executions"
          ? "idx_template_executions_event_id"
          : LEGACY_EXECUTIONS_EVENT_INDEX;
        database.prepare(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(event_id)`).run();
      }
      database.prepare("UPDATE server_state SET schema_version = 33 WHERE id = 1").run();
    }
  }

  // v34: add block_reason_json column to tasks for the blocked-status feature.
  // Column-existence check per CLAUDE.md §3 migration rules (not relying on schema_version alone).
  {
    const v34 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v34?.schema_version ?? 0) < 34) {
      const cols = database.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      const hasBlockReason = cols.some((c) => c.name === "block_reason_json");
      if (!hasBlockReason) {
        database.prepare("ALTER TABLE tasks ADD COLUMN block_reason_json TEXT").run();
      }
      database.prepare("UPDATE server_state SET schema_version = 34 WHERE id = 1").run();
    }
  }

  // v35: add preset_id to roles; add is_preset + preset_id to task_templates.
  // Column-existence check per CLAUDE.md §3 migration rules.
  {
    const v35 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v35?.schema_version ?? 0) < 35) {
      // roles.preset_id
      const roleCols = database.prepare("PRAGMA table_info(roles)").all() as { name: string }[];
      if (!roleCols.some((c) => c.name === "preset_id")) {
        database.prepare("ALTER TABLE roles ADD COLUMN preset_id TEXT").run();
      }
      // task_templates.is_preset + task_templates.preset_id
      const tmplCols = database.prepare("PRAGMA table_info(task_templates)").all() as { name: string }[];
      if (!tmplCols.some((c) => c.name === "is_preset")) {
        database.prepare("ALTER TABLE task_templates ADD COLUMN is_preset INTEGER NOT NULL DEFAULT 0").run();
      }
      if (!tmplCols.some((c) => c.name === "preset_id")) {
        database.prepare("ALTER TABLE task_templates ADD COLUMN preset_id TEXT").run();
      }
      database.prepare("UPDATE server_state SET schema_version = 35 WHERE id = 1").run();
    }
  }

  // v36: backfill roles.preset_id for the 6 known preset names.
  {
    const v36 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v36?.schema_version ?? 0) < 36) {
      const backfills: [string, string][] = [
        ["Engineer", "engineer"],
        ["Reviewer", "reviewer"],
        ["Researcher", "researcher"],
        ["Writer", "writer"],
        ["Chat Manager", "chat-manager"],
        ["adam-automator", "adam-automator"],
      ];
      for (const [name, presetId] of backfills) {
        database.prepare("UPDATE roles SET preset_id = ? WHERE name = ? AND preset_id IS NULL").run(presetId, name);
      }
      database.prepare("UPDATE server_state SET schema_version = 36 WHERE id = 1").run();
    }
  }

  // v37: create feature_requests table.
  {
    const v37 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v37?.schema_version ?? 0) < 37) {
      const existingTables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feature_requests'").all() as { name: string }[];
      if (existingTables.length === 0) {
        database.exec(`
          CREATE TABLE feature_requests (
            id TEXT PRIMARY KEY,
            source_session_id TEXT,
            source_message_id TEXT,
            extracted_at INTEGER NOT NULL,
            extracted_by_role_id TEXT,
            content TEXT NOT NULL,
            summary TEXT,
            status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewed','dismissed','converted')),
            tags TEXT,
            evidence_quote TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `);
        database.exec("CREATE INDEX IF NOT EXISTS idx_feature_requests_status ON feature_requests(status)");
        database.exec("CREATE INDEX IF NOT EXISTS idx_feature_requests_extracted_at ON feature_requests(extracted_at DESC)");
      }
      database.prepare("UPDATE server_state SET schema_version = 37 WHERE id = 1").run();
    }
  }

  // v38: create mistake_patterns table.
  {
    const v38 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v38?.schema_version ?? 0) < 38) {
      const existingTables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mistake_patterns'").all() as { name: string }[];
      if (existingTables.length === 0) {
        database.exec(`
          CREATE TABLE mistake_patterns (
            id TEXT PRIMARY KEY,
            dimension_type TEXT NOT NULL,
            dimension_value TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 1,
            role_ids TEXT NOT NULL DEFAULT '[]',
            sample_evidence_ids TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','acknowledged','dismissed')),
            first_seen INTEGER NOT NULL,
            last_seen INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `);
        database.exec("CREATE INDEX IF NOT EXISTS idx_mistake_patterns_status ON mistake_patterns(status)");
        database.exec("CREATE INDEX IF NOT EXISTS idx_mistake_patterns_last_seen ON mistake_patterns(last_seen)");
        database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_mistake_patterns_dim ON mistake_patterns(dimension_type, dimension_value)");
      }
      database.prepare("UPDATE server_state SET schema_version = 38 WHERE id = 1").run();
    }
  }

  // ===== Schema v39: GAP-08 — partial UNIQUE index on (source_task_id, type='thought') =====
  // Pre-flight dedupes existing rows (keeps longest content per group),
  // then adds a partial unique index enforcing "max 1 thought memory per task".
  {
    const v39 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v39?.schema_version ?? 0) < 39) {
      // Pre-flight: find duplicate (source_task_id, type='thought') groups
      const dupGroups = database.prepare(
        "SELECT source_task_id, COUNT(*) as cnt FROM memories WHERE source_task_id IS NOT NULL AND type = 'thought' GROUP BY source_task_id HAVING cnt > 1"
      ).all() as Array<{ source_task_id: string; cnt: number }>;

      if (dupGroups.length > 0) {
        console.info(`[db migration v39] dedupe ${dupGroups.length} (source_task_id, type='thought') groups before adding unique index`);
        for (const grp of dupGroups) {
          // Keep the row with longest content; delete the rest
          const rows = database.prepare(
            "SELECT id, length(content) as len FROM memories WHERE source_task_id = ? AND type = 'thought' ORDER BY len DESC, created_at ASC"
          ).all(grp.source_task_id) as Array<{ id: string; len: number }>;
          const keepId = rows[0].id;
          const deleteIds = rows.slice(1).map(r => r.id);
          const placeholders = deleteIds.map(() => '?').join(',');
          database.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...deleteIds);
          console.info(`[db migration v39]   group source_task_id=${grp.source_task_id}: kept ${keepId} (len ${rows[0].len}), deleted ${deleteIds.length}`);
        }
      }

      // Add the partial unique index
      database.prepare(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_thought_per_task ON memories(source_task_id) WHERE source_task_id IS NOT NULL AND type = 'thought'"
      ).run();

      database.prepare("UPDATE server_state SET schema_version = 39 WHERE id = 1").run();
    }
  }

  // ===== Schema v40: S6-A — add trace_id column to 5 tables =====
  // Adds nullable trace_id (UUID v4) to tasks, step_logs, delivery_log,
  // evolution_audit, chat_messages. Allows JOIN across the full request chain.
  // Existing rows get NULL — backfill is not in scope; new rows get IDs going forward.
  {
    const v40 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v40?.schema_version ?? 0) < 40) {
      const TABLES = ["tasks", "step_logs", "delivery_log", "evolution_audit", "chat_messages"];
      for (const table of TABLES) {
        const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (!cols.some((c) => c.name === "trace_id")) {
          database.prepare(`ALTER TABLE ${table} ADD COLUMN trace_id TEXT`).run();
          database.prepare(`CREATE INDEX IF NOT EXISTS idx_${table}_trace_id ON ${table}(trace_id) WHERE trace_id IS NOT NULL`).run();
          console.info(`[db migration v40] added trace_id to ${table}`);
        }
      }
      database.prepare("UPDATE server_state SET schema_version = 40 WHERE id = 1").run();
    }
  }

  // ===== Schema v41: Template-only trigger semantics =====
  // Migrate old completion trigger rows to template_complete and reject the
  // old trigger type in store/API validation after this point.
  {
    const v41 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v41?.schema_version ?? 0) < 41) {
      database.prepare(`
        UPDATE task_templates
        SET trigger_type = 'template_complete'
        WHERE trigger_type = ?
      `).run(LEGACY_TEMPLATE_COMPLETE_TRIGGER);
      database.prepare(`
        UPDATE task_templates
        SET trigger_event = REPLACE(trigger_event, ?, 'template_complete:')
        WHERE trigger_event LIKE ?
      `).run(LEGACY_TEMPLATE_COMPLETE_PREFIX, `${LEGACY_TEMPLATE_COMPLETE_PREFIX}%`);
      database.prepare("UPDATE server_state SET schema_version = 41 WHERE id = 1").run();
    }
  }

  // ===== Schema v42: Rename execution persistence to TemplateExecution =====
  {
    const v42 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v42?.schema_version ?? 0) < 42) {
      const oldTable = database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      ).get(LEGACY_EXECUTIONS_TABLE) as { name: string } | undefined;
      const newTable = database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='template_executions'",
      ).get() as { name: string } | undefined;

      if (oldTable && !newTable) {
        database.prepare(`ALTER TABLE ${LEGACY_EXECUTIONS_TABLE} RENAME TO template_executions`).run();
      }

      database.exec(`
        CREATE TABLE IF NOT EXISTS template_executions (
          id TEXT PRIMARY KEY,
          template_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          step_statuses TEXT NOT NULL DEFAULT '{}',
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          error TEXT,
          event_id TEXT,
          FOREIGN KEY (template_id) REFERENCES task_templates(id)
        )
      `);
      const cols = database.prepare("PRAGMA table_info(template_executions)").all() as { name: string }[];
      if (!cols.some((c) => c.name === "event_id")) {
        database.prepare("ALTER TABLE template_executions ADD COLUMN event_id TEXT").run();
      }
      database.prepare(`DROP INDEX IF EXISTS ${LEGACY_EXECUTIONS_EVENT_INDEX}`).run();
      database.prepare("CREATE INDEX IF NOT EXISTS idx_template_executions_event_id ON template_executions(event_id)").run();
      database.prepare("UPDATE server_state SET schema_version = 42 WHERE id = 1").run();
    }
  }

  // ===== Schema v43: Rename artifacts to TemplateExecutionArtifact and migrate storage root =====
  {
    const v43 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v43?.schema_version ?? 0) < 43) {
      const oldTable = database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      ).get(LEGACY_ARTIFACTS_TABLE) as { name: string } | undefined;
      const newTable = database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='template_execution_artifacts'",
      ).get() as { name: string } | undefined;

      if (oldTable && !newTable) {
        database.prepare(`ALTER TABLE ${LEGACY_ARTIFACTS_TABLE} RENAME TO template_execution_artifacts`).run();
      }

      database.exec(`
        CREATE TABLE IF NOT EXISTS template_execution_artifacts (
          id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          key TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('json', 'file')),
          value_json TEXT,
          blob_path TEXT,
          mime TEXT,
          size_bytes INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(execution_id, step_id, key),
          FOREIGN KEY (execution_id) REFERENCES template_executions(id) ON DELETE CASCADE
        )
      `);
      database.prepare(`DROP INDEX IF EXISTS ${LEGACY_ARTIFACTS_EXECUTION_INDEX}`).run();
      database.prepare(`DROP INDEX IF EXISTS ${LEGACY_ARTIFACTS_STEP_INDEX}`).run();
      database.prepare("CREATE INDEX IF NOT EXISTS idx_template_execution_artifacts_execution ON template_execution_artifacts(execution_id)").run();
      database.prepare("CREATE INDEX IF NOT EXISTS idx_template_execution_artifacts_step ON template_execution_artifacts(execution_id, step_id)").run();
      migrateLegacyTemplateExecutionArtifactStorage(database);
      database.prepare("UPDATE server_state SET schema_version = 43 WHERE id = 1").run();
    }
  }

  // ===== Schema v44: Add error_category to tasks (DP-002: error classification at source) =====
  {
    const v44 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v44?.schema_version ?? 0) < 44) {
      const taskCols = database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      if (!taskCols.some((c) => c.name === "error_category")) {
        database.prepare("ALTER TABLE tasks ADD COLUMN error_category TEXT").run();
      }
      database.prepare("UPDATE server_state SET schema_version = 44 WHERE id = 1").run();
    }
  }

  // ===== Schema v45: Add retry_count + delayed_retries (DP-003: ChatManager error-aware retry) =====
  {
    const v45 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v45?.schema_version ?? 0) < 45) {
      const taskCols = database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      if (!taskCols.some((c) => c.name === "retry_count")) {
        database.prepare("ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0").run();
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS delayed_retries (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          retry_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_delayed_retries_retry_at ON delayed_retries(retry_at)`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_delayed_retries_task_id ON delayed_retries(task_id)`);
      database.prepare("UPDATE server_state SET schema_version = 45 WHERE id = 1").run();
    }
  }

  // ===== Schema v46: Add task_type to role_scores (Task 5: per-task-type performance tracking) =====
  {
    const v46 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v46?.schema_version ?? 0) < 46) {
      const rsCols = database.prepare("PRAGMA table_info(role_scores)").all() as Array<{ name: string }>;
      if (!rsCols.some((c) => c.name === "task_type")) {
        database.prepare("ALTER TABLE role_scores ADD COLUMN task_type TEXT").run();
      }
      database.prepare("UPDATE server_state SET schema_version = 46 WHERE id = 1").run();
    }
  }

  // ===== Schema v47: Add original_filename to template_execution_artifacts =====
  // Records the user-friendly source filename at publish time so downstream channel
  // adapters can render proper extensions instead of the .bin storage suffix.
  {
    const v47 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v47?.schema_version ?? 0) < 47) {
      const columns = database.prepare("PRAGMA table_info(template_execution_artifacts)").all() as Array<{ name: string }>;
      const hasOriginalFilename = columns.some((c) => c.name === "original_filename");
      if (!hasOriginalFilename) {
        database.prepare("ALTER TABLE template_execution_artifacts ADD COLUMN original_filename TEXT").run();
      }
      database.prepare("UPDATE server_state SET schema_version = 47 WHERE id = 1").run();
    }
  }

  // ===== Schema v48: Chat envelope protocol — extend chat_messages =====
  // Adds 10 columns to chat_messages for envelope-shape (kind, threading,
  // approval prompt linkage, attachments JSON, mirror targets, platform msg id, seq).
  // Back-fills `kind` for existing rows: role='user' → 'user_message', role='assistant' → 'assistant_text'.
  {
    const v48 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v48?.schema_version ?? 0) < 48) {
      const cols = database.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>;
      const hasCol = (name: string) => cols.some((c) => c.name === name);

      if (!hasCol("kind")) database.prepare("ALTER TABLE chat_messages ADD COLUMN kind TEXT").run();
      if (!hasCol("parent_message_id")) database.prepare("ALTER TABLE chat_messages ADD COLUMN parent_message_id TEXT").run();
      if (!hasCol("thread_root")) database.prepare("ALTER TABLE chat_messages ADD COLUMN thread_root TEXT").run();
      if (!hasCol("prompt_id")) database.prepare("ALTER TABLE chat_messages ADD COLUMN prompt_id TEXT").run();
      if (!hasCol("approval_shape")) database.prepare("ALTER TABLE chat_messages ADD COLUMN approval_shape TEXT").run();
      if (!hasCol("role_id")) database.prepare("ALTER TABLE chat_messages ADD COLUMN role_id TEXT").run();
      if (!hasCol("attachments")) database.prepare("ALTER TABLE chat_messages ADD COLUMN attachments TEXT").run();
      if (!hasCol("mirrored_to_targets")) database.prepare("ALTER TABLE chat_messages ADD COLUMN mirrored_to_targets TEXT").run();
      if (!hasCol("platform_message_id")) database.prepare("ALTER TABLE chat_messages ADD COLUMN platform_message_id TEXT").run();
      if (!hasCol("seq")) database.prepare("ALTER TABLE chat_messages ADD COLUMN seq INTEGER").run();

      database.prepare(`UPDATE chat_messages SET kind = 'user_message' WHERE kind IS NULL AND role = 'user'`).run();
      database.prepare(`UPDATE chat_messages SET kind = 'assistant_text' WHERE kind IS NULL AND role = 'assistant'`).run();

      database.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_root ON chat_messages(thread_root, created_at) WHERE thread_root IS NOT NULL`).run();
      database.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_prompt_id ON chat_messages(prompt_id) WHERE prompt_id IS NOT NULL`).run();
      database.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_platform_msg ON chat_messages(platform_message_id) WHERE platform_message_id IS NOT NULL`).run();

      database.prepare("UPDATE server_state SET schema_version = 48 WHERE id = 1").run();
      console.info("[db migration v48] chat_messages: added 10 envelope columns + 3 indexes; back-filled kind");
    }
  }

  // ===== Schema v49: Chat envelope protocol — pending_prompts table =====
  {
    const v49 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v49?.schema_version ?? 0) < 49) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS pending_prompts (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          task_id TEXT,
          message_id TEXT NOT NULL,
          shape TEXT NOT NULL CHECK(shape IN ('yes_no','choose_one','free_input')),
          expected_shape_json TEXT,
          asked_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          resolved_at INTEGER,
          resolved_by_message_id TEXT,
          resolved_via TEXT,
          resolved_value TEXT,
          expired_reason TEXT
        )
      `);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_pending_prompts_session_open ON pending_prompts(session_id, expires_at) WHERE resolved_at IS NULL`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_pending_prompts_task ON pending_prompts(task_id) WHERE task_id IS NOT NULL`);

      database.prepare("UPDATE server_state SET schema_version = 49 WHERE id = 1").run();
      console.info("[db migration v49] pending_prompts: created table + 2 indexes");
    }
  }

  // ===== Schema v50: Chat envelope protocol — template_execution_artifacts storage hooks =====
  // Adds 8 columns for future Storage Abstraction Layer.
  // `original_filename` already added by v47 — NOT re-added here.
  {
    const v50 = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v50?.schema_version ?? 0) < 50) {
      // Post-v72: template_execution_artifacts may have been renamed to `artifacts`.
      // When tests stamp schema_version back to <50 to re-run this migration, the legacy
      // table is gone and the ALTERs would fail with "no such table". Skip the ALTER
      // sequence in that case — the column additions are already preserved on the renamed
      // table (v72 INSERT SELECT copies all columns verbatim).
      const legacyTable = database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='template_execution_artifacts'",
      ).get();

      if (legacyTable) {
        const cols = database.prepare("PRAGMA table_info(template_execution_artifacts)").all() as Array<{ name: string }>;
        const hasCol = (name: string) => cols.some((c) => c.name === name);

        if (!hasCol("locator")) database.prepare("ALTER TABLE template_execution_artifacts ADD COLUMN locator TEXT").run();
        if (!hasCol("content_hash")) database.prepare("ALTER TABLE template_execution_artifacts ADD COLUMN content_hash TEXT").run();
        if (!hasCol("retention_hint")) database.prepare("ALTER TABLE template_execution_artifacts ADD COLUMN retention_hint TEXT").run();
        if (!hasCol("encryption_class")) database.prepare("ALTER TABLE template_execution_artifacts ADD COLUMN encryption_class TEXT").run();
        if (!hasCol("purpose")) database.prepare("ALTER TABLE template_execution_artifacts ADD COLUMN purpose TEXT").run();
        if (!hasCol("replaces")) database.prepare("ALTER TABLE template_execution_artifacts ADD COLUMN replaces TEXT").run();
        if (!hasCol("produced_by_role")) database.prepare("ALTER TABLE template_execution_artifacts ADD COLUMN produced_by_role TEXT").run();
        if (!hasCol("access")) database.prepare("ALTER TABLE template_execution_artifacts ADD COLUMN access TEXT").run();

        database.prepare(`CREATE INDEX IF NOT EXISTS idx_artifacts_content_hash ON template_execution_artifacts(content_hash) WHERE content_hash IS NOT NULL`).run();
        database.prepare(`CREATE INDEX IF NOT EXISTS idx_artifacts_replaces ON template_execution_artifacts(replaces) WHERE replaces IS NOT NULL`).run();

        console.info("[db migration v50] template_execution_artifacts: added 8 storage-hook columns + 2 indexes");
      } else {
        console.info("[db migration v50] skipped — template_execution_artifacts already renamed to artifacts in v72");
      }

      database.prepare("UPDATE server_state SET schema_version = 50 WHERE id = 1").run();
    }
  }

  // ===== Schema v51: chat_messages source_channel_id / source_chat_id (Phase 5 inbound) =====
  {
    const v51Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v51Row?.schema_version ?? 0) < 51) {
      const cols = database.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === "source_channel_id")) {
        database.exec("ALTER TABLE chat_messages ADD COLUMN source_channel_id TEXT");
      }
      if (!cols.some(c => c.name === "source_chat_id")) {
        database.exec("ALTER TABLE chat_messages ADD COLUMN source_chat_id TEXT");
      }
      database.prepare("UPDATE server_state SET schema_version = 51 WHERE id = 1").run();
      console.info("[db migration v51] chat_messages: added source_channel_id + source_chat_id columns");
    }
  }

  // ===== Schema v52: audit_violations (Phase 2 contract verifier) =====
  {
    const v52Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v52Row?.schema_version ?? 0) < 52) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS audit_violations (
          id TEXT PRIMARY KEY,
          step_task_id TEXT NOT NULL,
          execution_id TEXT,
          role_id TEXT NOT NULL,
          contract_field TEXT NOT NULL,
          layer TEXT NOT NULL CHECK(layer IN ('A', 'B')),
          severity TEXT NOT NULL CHECK(severity IN ('error', 'warning')),
          message TEXT NOT NULL,
          metadata_json TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_violations_role ON audit_violations(role_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_violations_task ON audit_violations(step_task_id);
        CREATE INDEX IF NOT EXISTS idx_audit_violations_execution ON audit_violations(execution_id, created_at DESC);
      `);
      database.prepare("UPDATE server_state SET schema_version = 52 WHERE id = 1").run();
      console.info("[db migration v52] audit_violations: added contract-violation audit table + 3 indexes");
    }
  }

  // v53: Wrap legacy string[] learned_rules rows into structured LearnedRules object.
  // Column type stays TEXT (JSON); only data shape changes.
  // Idempotent: already-migrated rows are objects, so the array branch never matches.
  {
    const v53Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v53Row?.schema_version ?? 0) < 53) {
      const rows = database.prepare("SELECT id, learned_rules FROM roles").all() as Array<{ id: string; learned_rules: string | null }>;
      const updateStmt = database.prepare("UPDATE roles SET learned_rules = ? WHERE id = ?");
      let migratedCount = 0;
      for (const row of rows) {
        if (!row.learned_rules) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(row.learned_rules); } catch { continue; }
        if (Array.isArray(parsed)) {
          const wrapped = {
            stylePreferences: parsed.filter((r): r is string => typeof r === "string"),
            avoidedActions: [],
            pinnedParameters: [],
          };
          updateStmt.run(JSON.stringify(wrapped), row.id);
          migratedCount += 1;
        }
        // else: already an object (idempotent re-run) — leave as-is
      }
      database.prepare("UPDATE server_state SET schema_version = 53 WHERE id = 1").run();
      console.info(`[db migration v53] learned_rules: wrapped ${migratedCount} legacy string[] rows into structured form`);
    }
  }

  // v54: user-visible delivery ledger and owner viewer backfill.
  {
    const v54Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v54Row?.schema_version ?? 0) < 54) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS user_visible_events (
          id TEXT PRIMARY KEY,
          event_key TEXT NOT NULL UNIQUE,
          source_type TEXT NOT NULL CHECK(source_type IN ('task','template_execution','unknown')),
          source_id TEXT NOT NULL,
          task_id TEXT,
          template_id TEXT,
          template_name TEXT,
          message_type TEXT NOT NULL,
          viewer_key TEXT NOT NULL,
          title TEXT,
          content_preview TEXT NOT NULL,
          attachments_json TEXT NOT NULL DEFAULT '[]',
          targets_json TEXT NOT NULL DEFAULT '[]',
          first_delivered_at INTEGER NOT NULL,
          last_delivered_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          trace_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_user_visible_events_viewer_time
          ON user_visible_events(viewer_key, last_delivered_at DESC);
        CREATE INDEX IF NOT EXISTS idx_user_visible_events_viewer_source
          ON user_visible_events(viewer_key, source_id);
        CREATE INDEX IF NOT EXISTS idx_user_visible_events_trace_id
          ON user_visible_events(trace_id) WHERE trace_id IS NOT NULL;
      `);

      let ownerViewerKey = "local-owner";
      const ownerRow = database.prepare("SELECT value FROM config WHERE key = 'identity.ownerViewerKey'").get() as { value: string } | undefined;
      if (ownerRow) {
        try {
          const parsed = JSON.parse(ownerRow.value) as unknown;
          if (typeof parsed === "string" && parsed.trim().length > 0) ownerViewerKey = parsed;
        } catch {
          if (ownerRow.value.trim().length > 0) ownerViewerKey = ownerRow.value;
        }
      }

      const channelRows = database.prepare("SELECT id, config FROM channels").all() as Array<{ id: string; config: string }>;
      const updateChannelConfig = database.prepare("UPDATE channels SET config = ?, updated_at = ? WHERE id = ?");
      for (const row of channelRows) {
        try {
          const parsed = JSON.parse(row.config) as Record<string, unknown>;
          if (typeof parsed.viewerKey !== "string" || parsed.viewerKey.trim().length === 0) {
            parsed.viewerKey = ownerViewerKey;
            updateChannelConfig.run(JSON.stringify(parsed), Date.now(), row.id);
          }
        } catch {
          // Malformed channel config remains untouched; channel resolution will fail closed.
        }
      }

      database.prepare("UPDATE server_state SET schema_version = 54 WHERE id = 1").run();
      console.info("[db migration v54] user_visible_events: created delivery ledger and backfilled channel viewerKey");
    }
  }

  // v55: audit_diagnostics for non-fatal runtime audit failures.
  {
    const v55Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v55Row?.schema_version ?? 0) < 55) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS audit_diagnostics (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          severity TEXT NOT NULL CHECK(severity IN ('info','warning','error')),
          trace_id TEXT,
          source_id TEXT,
          message TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_diagnostics_source_created
          ON audit_diagnostics(source, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_diagnostics_trace_id
          ON audit_diagnostics(trace_id) WHERE trace_id IS NOT NULL;
      `);
      database.prepare("UPDATE server_state SET schema_version = 55 WHERE id = 1").run();
      console.info("[db migration v55] audit_diagnostics: added diagnostic table + indexes");
    }
  }

  // v56: runtime effects and assistant commitment audit gate.
  {
    const v56Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v56Row?.schema_version ?? 0) < 56) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS runtime_effects (
          id TEXT PRIMARY KEY,
          trace_id TEXT,
          effect_type TEXT NOT NULL,
          effect_category TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT,
          field_path TEXT,
          before_json TEXT,
          after_json TEXT,
          created_at INTEGER NOT NULL,
          actor_role_id TEXT,
          tool_name TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_runtime_effects_trace
          ON runtime_effects(trace_id, created_at) WHERE trace_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_runtime_effects_category
          ON runtime_effects(effect_category, created_at);

        CREATE TABLE IF NOT EXISTS assistant_commitment_audits (
          id TEXT PRIMARY KEY,
          trace_id TEXT,
          session_id TEXT,
          message_id TEXT,
          status TEXT NOT NULL CHECK(status IN ('passed','blocked')),
          claim_type TEXT NOT NULL,
          claim_text TEXT NOT NULL,
          evidence_effect_ids TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_assistant_commitment_audits_trace
          ON assistant_commitment_audits(trace_id, created_at) WHERE trace_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_assistant_commitment_audits_session
          ON assistant_commitment_audits(session_id, created_at) WHERE session_id IS NOT NULL;
      `);
      database.prepare("UPDATE server_state SET schema_version = 56 WHERE id = 1").run();
      console.info("[db migration v56] runtime_effects + assistant_commitment_audits: added audit evidence tables");
    }
  }

  // v57: persisted ChatManager future-delivery commitments.
  {
    const v57Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v57Row?.schema_version ?? 0) < 57) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS assistant_delivery_commitments (
          id TEXT PRIMARY KEY,
          trace_id TEXT,
          session_id TEXT NOT NULL,
          source_message_id TEXT,
          task_id TEXT,
          commitment_type TEXT NOT NULL CHECK(commitment_type IN ('future_delivery')),
          status TEXT NOT NULL CHECK(status IN ('pending','fulfilled','failed','blocked','cancelled')),
          target_json TEXT NOT NULL,
          artifact_expectation_json TEXT,
          evidence_json TEXT,
          failure_reason TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          fulfilled_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_assistant_delivery_commitments_task_status
          ON assistant_delivery_commitments(task_id, status) WHERE task_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_assistant_delivery_commitments_trace
          ON assistant_delivery_commitments(trace_id, created_at) WHERE trace_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_assistant_delivery_commitments_session
          ON assistant_delivery_commitments(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_assistant_delivery_commitments_source_message
          ON assistant_delivery_commitments(source_message_id) WHERE source_message_id IS NOT NULL;
      `);
      database.prepare("UPDATE server_state SET schema_version = 57 WHERE id = 1").run();
      console.info("[db migration v57] assistant_delivery_commitments: added ChatManager delivery commitment table");
    }
  }

  // v58: extract viewerKey from channel config JSON into dedicated viewer_key column.
  // v54 backfilled viewerKey into config for all channels, but email channel config must
  // contain only "address" (enforced by parseMailChannelConfig). Moving viewerKey to its
  // own column fixes the conflict and follows the same pattern as linked_role_id.
  {
    const v58Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v58Row?.schema_version ?? 0) < 58) {
      const viewerKeyCols = database.prepare("PRAGMA table_info(channels)").all() as Array<{ name: string }>;
      if (!viewerKeyCols.some(c => c.name === "viewer_key")) {
        database.exec("ALTER TABLE channels ADD COLUMN viewer_key TEXT");
      }

      let ownerViewerKey = "local-owner";
      const ownerRow = database.prepare("SELECT value FROM config WHERE key = 'identity.ownerViewerKey'").get() as { value: string } | undefined;
      if (ownerRow) {
        try {
          const parsed = JSON.parse(ownerRow.value) as unknown;
          if (typeof parsed === "string" && parsed.trim().length > 0) ownerViewerKey = parsed;
        } catch {
          if (ownerRow.value.trim().length > 0) ownerViewerKey = ownerRow.value;
        }
      }

      const channelRows = database.prepare("SELECT id, config FROM channels").all() as Array<{ id: string; config: string }>;
      const updateChannelConfig = database.prepare("UPDATE channels SET config = ?, viewer_key = ?, updated_at = ? WHERE id = ?");
      for (const row of channelRows) {
        try {
          const parsed = JSON.parse(row.config) as Record<string, unknown>;
          const extractedKey = (typeof parsed.viewerKey === "string" && parsed.viewerKey.trim().length > 0)
            ? parsed.viewerKey
            : ownerViewerKey;
          delete parsed.viewerKey;
          updateChannelConfig.run(JSON.stringify(parsed), extractedKey, Date.now(), row.id);
        } catch {
          database.prepare("UPDATE channels SET viewer_key = ?, updated_at = ? WHERE id = ?").run(ownerViewerKey, Date.now(), row.id);
        }
      }

      database.prepare("UPDATE server_state SET schema_version = 58 WHERE id = 1").run();
      console.info("[db migration v58] channels: extracted viewerKey from config into viewer_key column");
    }
  }

  // v59: seed excludePromptPatterns on existing catch-all delivery rules.
  // Per docs/06-plans/2026-05-12-runtime-audit-fixes-plan.md Task 4: UPDATE existing
  // catch-all rules (where no rule-specifier field is set) with the 3 specific E2E
  // test prompts that exhausted iLink quota. Do NOT create new rules.
  //
  // Default patterns are derived from concrete E2E test fixtures:
  // - "Task assigned to role A/B" → src/__tests__/e2e/role-native-e2e.test.ts:204-205
  // - "List files in the current directory." → role-native-e2e.test.ts:139
  // - "ping role payload" → chatmanager-delivery-commitment-harness.test.ts
  {
    const DEFAULT_E2E_EXCLUDE_PATTERNS = [
      "^Task assigned to role [A-Z]$",
      "^List files in the current directory\\.?$",
      "^ping role payload$",
    ];

    // ---- Repair path for already-v59 DBs that ran the buggy initial migration ----
    // Idempotent: detects the legacy bad seed (rule with E2E_TEST_MODE markers + system author)
    // and removes it, then ensures correct patterns are present on real catch-all rules.
    // Runs every startup so any DB regressed from older code is healed.
    try {
      // Remove the legacy bad rule (channelId="_default_block_" is the unique signature)
      const legacy = database.prepare(
        "SELECT id FROM delivery_rules WHERE created_by = 'system' AND target LIKE '%_default_block_%'"
      ).all() as Array<{ id: string }>;
      for (const row of legacy) {
        database.prepare("DELETE FROM delivery_rules WHERE id = ?").run(row.id);
        console.info(`[db v59 repair] removed legacy bad rule ${row.id}`);
      }

      // Remove the legacy config key (had wrong patterns)
      database.prepare(
        "DELETE FROM config WHERE key = 'delivery.defaultExcludePromptPatterns' AND value LIKE '%E2E_TEST_MODE%'"
      ).run();
    } catch (err) {
      console.warn("[db v59 repair] cleanup of legacy seed failed (non-fatal):", err);
    }

    // ---- Forward path: bump schema_version to 59 by applying the plan-spec UPDATE ----
    const v59Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v59Row?.schema_version ?? 0) < 59) {
      // Robust catch-all detection: parse match_criteria and check all rule-specifier
      // fields are absent. Don't rely on byte-equality with '{}' alone.
      const candidateRows = database.prepare(
        "SELECT id, match_criteria FROM delivery_rules WHERE event_type = 'task_complete'"
      ).all() as Array<{ id: string; match_criteria: string | null }>;

      let updated = 0;
      for (const row of candidateRows) {
        try {
          const mc = row.match_criteria ? JSON.parse(row.match_criteria) : {};
          const isCatchAll =
            !mc.templateId && !mc.roleId && !mc.promptPattern && !mc.taskStatus;
          if (!isCatchAll) continue;

          // Preserve any existing user additions in excludePromptPatterns
          const existing = Array.isArray(mc.excludePromptPatterns) ? mc.excludePromptPatterns : [];
          const merged = [...new Set([...existing, ...DEFAULT_E2E_EXCLUDE_PATTERNS])];
          const newMc = { ...mc, excludePromptPatterns: merged };
          database.prepare("UPDATE delivery_rules SET match_criteria = ? WHERE id = ?").run(
            JSON.stringify(newMc), row.id
          );
          updated++;
        } catch { /* skip malformed row */ }
      }

      database.prepare("UPDATE server_state SET schema_version = 59 WHERE id = 1").run();
      console.info(`[db migration v59] delivery: seeded excludePromptPatterns on ${updated} catch-all rule(s)`);
    }

    // ---- Idempotent post-v59 reconciliation: even on v59 DBs, ensure catch-all rules
    // have the default patterns merged in. This catches DBs that hit v59 via the buggy
    // initial code (which never touched 134ca03f), so the rule still has match_criteria='{}'.
    try {
      const allCatchAll = database.prepare(
        "SELECT id, match_criteria FROM delivery_rules WHERE event_type = 'task_complete'"
      ).all() as Array<{ id: string; match_criteria: string | null }>;

      for (const row of allCatchAll) {
        try {
          const mc = row.match_criteria ? JSON.parse(row.match_criteria) : {};
          const isCatchAll =
            !mc.templateId && !mc.roleId && !mc.promptPattern && !mc.taskStatus;
          if (!isCatchAll) continue;

          const existing = Array.isArray(mc.excludePromptPatterns) ? mc.excludePromptPatterns : [];
          const missing = DEFAULT_E2E_EXCLUDE_PATTERNS.filter((p) => !existing.includes(p));
          if (missing.length === 0) continue;

          const merged = [...existing, ...missing];
          const newMc = { ...mc, excludePromptPatterns: merged };
          database.prepare("UPDATE delivery_rules SET match_criteria = ? WHERE id = ?").run(
            JSON.stringify(newMc), row.id
          );
          console.info(`[db v59 reconcile] added ${missing.length} default exclude pattern(s) to rule ${row.id}`);
        } catch { /* skip malformed */ }
      }
    } catch (err) {
      console.warn("[db v59 reconcile] post-migration repair failed (non-fatal):", err);
    }
  }

  // ===== Migration v60: template_execution_failed event + delivery_log.execution_id =====
  const v60Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
  if ((v60Row?.schema_version ?? 0) < 60) {
    // 60a: add execution_id column if missing
    const dlCols = database.prepare("PRAGMA table_info(delivery_log)").all() as Array<{ name: string }>;
    if (!dlCols.some((c) => c.name === "execution_id")) {
      database.prepare("ALTER TABLE delivery_log ADD COLUMN execution_id TEXT").run();
      database.prepare("CREATE INDEX IF NOT EXISTS idx_delivery_log_execution_id ON delivery_log (execution_id)").run();
    }

    // 60b: seed default rule (idempotent — skip if any rule for this event type exists)
    const existing = database.prepare("SELECT id FROM delivery_rules WHERE event_type = ?").get("template_execution_failed");
    if (!existing) {
      // Robust catch-all detection — parse-and-inspect rather than byte length, because
      // v59 (Task 4) inflates the catch-all rule's match_criteria from '{}' (2 bytes)
      // to ~138 bytes by adding excludePromptPatterns. A byte-length filter would
      // miss the catch-all post-v59. Verifier S1 Concern C.
      // A rule is "catch-all" when no rule-specifier field is set; excludePromptPatterns
      // is a behavioral modifier, not a specifier — its presence does not disqualify.
      const candidateRows = database.prepare(
        "SELECT id, target, match_criteria FROM delivery_rules WHERE event_type = 'task_complete' AND enabled = 1"
      ).all() as Array<{ id: string; target: string; match_criteria: string | null }>;

      let targetChannel: string | null = null;
      for (const row of candidateRows) {
        try {
          const mc = row.match_criteria ? JSON.parse(row.match_criteria) : {};
          const isCatchAll =
            !mc.templateId && !mc.roleId && !mc.promptPattern && !mc.taskStatus;
          if (isCatchAll) {
            const t = JSON.parse(row.target);
            if (t?.type === "channel" && typeof t.channelId === "string") {
              targetChannel = t.channelId;
              break;
            }
          }
        } catch { /* skip malformed row */ }
      }
      const ruleId = `tpl-fail-${Date.now()}`;
      const target = targetChannel
        ? { type: "channel", channelId: targetChannel }
        : { type: "channel", channelId: "REPLACE_ME" };
      const enabled = targetChannel ? 1 : 0;

      database.prepare(
        "INSERT INTO delivery_rules (id, event_type, match_criteria, target, max_per_minute, skip_origin_channel, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        ruleId,
        "template_execution_failed",
        "{}",
        JSON.stringify(target),
        3, // lower rate limit — failures shouldn't spam
        0, // skipOriginChannel: not applicable to cron template failures
        enabled,
        Date.now(),
      );

      if (!targetChannel) {
        console.warn(`[db migration v60] no primary channel found for template_execution_failed rule; created as disabled (channelId=REPLACE_ME)`);
      } else {
        console.info(`[db migration v60] seeded template_execution_failed delivery rule targeting channel ${targetChannel}`);
      }
    }

    database.prepare("UPDATE server_state SET schema_version = 60 WHERE id = 1").run();
  }

  // ---- v61: effect_receipts table (claim-receipt-architecture dev-guide Phase 1) ----
  const v61Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
  if ((v61Row?.schema_version ?? 0) < 61) {
    // Guard: skip CREATE if table already exists (covers re-run-after-failure scenarios).
    const existingTable = database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='effect_receipts'"
    ).get();
    if (!existingTable) {
      database.prepare(`
        CREATE TABLE effect_receipts (
          id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          task_id TEXT,
          session_id TEXT,
          effect_category TEXT NOT NULL CHECK(effect_category IN ('outbound_message','entity_mutation')),
          verb TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT,
          entity_ids_json TEXT,
          target_json TEXT,
          payload_json TEXT,
          field_changes_json TEXT,
          scope_json TEXT,
          actor_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          CHECK ((entity_id IS NULL) OR (entity_ids_json IS NULL))
        )
      `).run();
      database.prepare("CREATE INDEX idx_effect_receipts_trace ON effect_receipts(trace_id, created_at)").run();
      database.prepare("CREATE INDEX idx_effect_receipts_task ON effect_receipts(task_id, created_at) WHERE task_id IS NOT NULL").run();
      database.prepare("CREATE INDEX idx_effect_receipts_entity ON effect_receipts(entity_type, entity_id) WHERE entity_id IS NOT NULL").run();
      database.prepare("CREATE INDEX idx_effect_receipts_category_verb ON effect_receipts(effect_category, verb)").run();
    }

    database.prepare("UPDATE server_state SET schema_version = 61 WHERE id = 1").run();
  }

  // ---- Schema v62: effect_receipts.outcome + template_executions.step_results_json =====
  // Phase 2 DP-002: Add outcome column to effect_receipts (success | failure).
  // Phase 2 DP-001: Add step_results_json column to template_executions for post-hoc
  // redelivery of assembled summaries without re-running steps.
  {
    const v62Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v62Row?.schema_version ?? 0) < 62) {
      // (a) effect_receipts.outcome — Phase 2 DP-002
      // Guard: table may be absent in test seeders that bypass v61.
      const effectReceiptsExists = database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='effect_receipts'"
      ).get();
      if (effectReceiptsExists) {
        const effectReceiptColumns = database.prepare("PRAGMA table_info(effect_receipts)").all() as Array<{ name: string }>;
        if (!effectReceiptColumns.some((c) => c.name === "outcome")) {
          database.prepare(`ALTER TABLE effect_receipts ADD COLUMN outcome TEXT NOT NULL DEFAULT 'success' CHECK(outcome IN ('success','failure'))`).run();
          database.prepare("CREATE INDEX IF NOT EXISTS idx_effect_receipts_outcome ON effect_receipts (effect_category, outcome, trace_id)").run();
        }
      }

      // (b) template_executions.step_results_json — Phase 2 DP-001
      // Guard: table may be absent in test seeders that bypass v25.
      const templateExecutionsExists = database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='template_executions'"
      ).get();
      if (templateExecutionsExists) {
        const teColumns = database.prepare("PRAGMA table_info(template_executions)").all() as Array<{ name: string }>;
        if (!teColumns.some((c) => c.name === "step_results_json")) {
          database.prepare("ALTER TABLE template_executions ADD COLUMN step_results_json TEXT").run();
        }
      }

      database.prepare("UPDATE server_state SET schema_version = 62 WHERE id = 1").run();
    }
  }

  // ===== Schema v63: assistant_claims + assistant_claim_audits =====
  // Phase 3 of claim-receipt-architecture dev-guide. ChatManager / workers persist
  // structured claims via commit_claim tool. Audit rows record claim-vs-receipts
  // verdicts produced by claim-receipt-auditor.
  {
    const v63Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v63Row?.schema_version ?? 0) < 63) {
      // (a) assistant_claims — one row per commit_claim call
      const existingClaimsTable = database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_claims'"
      ).get();
      if (!existingClaimsTable) {
        database.prepare(`
          CREATE TABLE assistant_claims (
            id TEXT PRIMARY KEY,
            trace_id TEXT NOT NULL,
            session_id TEXT,
            task_id TEXT,
            source_message_id TEXT,
            claims_json TEXT NOT NULL,
            declared_at INTEGER NOT NULL
          )
        `).run();
        database.prepare("CREATE INDEX idx_assistant_claims_trace ON assistant_claims(trace_id, declared_at)").run();
        database.prepare("CREATE INDEX idx_assistant_claims_session ON assistant_claims(session_id, declared_at) WHERE session_id IS NOT NULL").run();
      }

      // (b) assistant_claim_audits — one row per auditClaimsForTurn invocation
      const existingAuditsTable = database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_claim_audits'"
      ).get();
      if (!existingAuditsTable) {
        database.prepare(`
          CREATE TABLE assistant_claim_audits (
            id TEXT PRIMARY KEY,
            trace_id TEXT NOT NULL,
            session_id TEXT,
            message_id TEXT,
            status TEXT NOT NULL CHECK(status IN ('passed','blocked')),
            per_claim_json TEXT NOT NULL DEFAULT '[]',
            replacement_text TEXT,
            created_at INTEGER NOT NULL
          )
        `).run();
        database.prepare("CREATE INDEX idx_assistant_claim_audits_trace ON assistant_claim_audits(trace_id, created_at)").run();
        database.prepare("CREATE INDEX idx_assistant_claim_audits_session ON assistant_claim_audits(session_id, created_at) WHERE session_id IS NOT NULL").run();
      }

      database.prepare("UPDATE server_state SET schema_version = 63 WHERE id = 1").run();
    }
  }

  // ===== Schema v64: auditor_divergence_log =====
  // Phase 5 of claim-receipt-architecture dev-guide. Records per-turn divergence
  // between old auditors (commitment-auditor + delivery-claim-auditor) and new
  // claim-receipt-auditor during the dual-write retirement period (≥ 30 days).
  // Table is temporary — slated for deletion after retirement criteria are met.
  {
    const v64Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v64Row?.schema_version ?? 0) < 64) {
      const existing = database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='auditor_divergence_log'"
      ).get();
      if (!existing) {
        database.prepare(`
          CREATE TABLE auditor_divergence_log (
            id TEXT PRIMARY KEY,
            trace_id TEXT NOT NULL,
            session_id TEXT,
            message_id TEXT,
            task_id TEXT,
            wire_point TEXT NOT NULL CHECK(wire_point IN ('message_handler','chat_manager_envelope')),
            old_verdict TEXT NOT NULL CHECK(old_verdict IN ('passed','blocked')),
            new_verdict TEXT NOT NULL CHECK(new_verdict IN ('passed','blocked')),
            divergence_subtype TEXT NOT NULL CHECK(divergence_subtype IN ('old_blocks_new_passes','old_passes_new_blocks')),
            old_replacement_text TEXT,
            new_replacement_text TEXT,
            recorded_at INTEGER NOT NULL
          )
        `).run();
        database.prepare("CREATE INDEX idx_auditor_divergence_trace ON auditor_divergence_log(trace_id, recorded_at)").run();
        database.prepare("CREATE INDEX idx_auditor_divergence_subtype ON auditor_divergence_log(divergence_subtype, recorded_at)").run();
        database.prepare("CREATE INDEX idx_auditor_divergence_session ON auditor_divergence_log(session_id, recorded_at) WHERE session_id IS NOT NULL").run();
      }
      database.prepare("UPDATE server_state SET schema_version = 64 WHERE id = 1").run();
    }
  }

  // ===== Schema v65: claim_source + verdict_pair columns + fixture cleanup =====
  // Phase 6 of claim-receipt-architecture dev-guide.
  // (a) Adds claim_source to assistant_claim_audits (maps to AssistantClaimAudit.claimSource)
  // (b) Adds verdict_pair to auditor_divergence_log (4-way breakdown including agreed_*)
  // (c) Backfills verdict_pair from existing divergence_subtype for the Phase-5 production row
  // (d) Deletes the 10 fixture rows from Phase 4 test pollution
  {
    const v65Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v65Row?.schema_version ?? 0) < 65) {
      try {
        // (a) Add claim_source to assistant_claim_audits
        {
          const cols = database.prepare("PRAGMA table_info(assistant_claim_audits)").all() as Array<{ name: string }>;
          if (!cols.some(c => c.name === "claim_source")) {
            database.prepare(
              "ALTER TABLE assistant_claim_audits ADD COLUMN claim_source TEXT NOT NULL DEFAULT 'vacuous'"
            ).run();
          }
        }

        // (b) Add verdict_pair to auditor_divergence_log
        {
          const cols = database.prepare("PRAGMA table_info(auditor_divergence_log)").all() as Array<{ name: string }>;
          if (!cols.some(c => c.name === "verdict_pair")) {
            database.prepare(
              "ALTER TABLE auditor_divergence_log ADD COLUMN verdict_pair TEXT NOT NULL DEFAULT 'agreed_pass'"
            ).run();
          }
        }

        // (c) Backfill verdict_pair from existing divergence_subtype
        database.prepare(`
          UPDATE auditor_divergence_log
          SET verdict_pair = divergence_subtype
          WHERE verdict_pair IS NULL OR verdict_pair = 'agreed_pass'
            AND divergence_subtype IN ('old_blocks_new_passes', 'old_passes_new_blocks')
        `).run();

        // (d) Delete Phase 4 fixture rows from effect_receipts
        const fixtureCount = database.prepare(
          "DELETE FROM effect_receipts WHERE trace_id LIKE 'trace-%' OR trace_id LIKE 'test-%'"
        ).run().changes;
        if (fixtureCount > 0) {
          console.info(`[db migration] v65: cleaned ${fixtureCount} fixture row(s) from effect_receipts`);
        }

        database.prepare("UPDATE server_state SET schema_version = 65 WHERE id = 1").run();
      } catch (err) {
        throw err;
      }
    }
  }

  // Schema v66: Role effortTier + skills
  {
    const v66Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v66Row?.schema_version ?? 0) < 66) {
      try {
        const cols = database.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>;
        if (!cols.some(c => c.name === "effort_tier")) {
          database.prepare("ALTER TABLE roles ADD COLUMN effort_tier TEXT").run();
        }
        if (!cols.some(c => c.name === "skills")) {
          database.prepare("ALTER TABLE roles ADD COLUMN skills TEXT").run();
        }
        database.prepare("UPDATE server_state SET schema_version = 66 WHERE id = 1").run();
      } catch (err) {
        throw new Error(`Schema v66 migration failed: ${err}`);
      }
    }
  }

  // Schema v67: chat_tool_calls table for ChatManager tool-call observability
  {
    const v67Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v67Row?.schema_version ?? 0) < 67) {
      try {
        const tableExists = database.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='chat_tool_calls'"
        ).get();
        if (!tableExists) {
          database.exec(`
            CREATE TABLE chat_tool_calls (
              id TEXT PRIMARY KEY,
              trace_id TEXT NOT NULL,
              session_id TEXT,
              tool_name TEXT NOT NULL,
              tool_input_json TEXT,
              tool_output_summary TEXT,
              called_at INTEGER NOT NULL
            )
          `);
          database.exec(`
            CREATE INDEX idx_chat_tool_calls_trace ON chat_tool_calls(trace_id, called_at)
          `);
          database.exec(`
            CREATE INDEX idx_chat_tool_calls_session ON chat_tool_calls(session_id, called_at) WHERE session_id IS NOT NULL
          `);
        }
        database.prepare("UPDATE server_state SET schema_version = 67 WHERE id = 1").run();
      } catch (err) {
        throw new Error(`Schema v67 migration failed: ${err}`);
      }
    }
  }

  // Schema v68: beliefs table + memories.kind + roles.last_reflection_at + server_state.last_memory_gc_at
  {
    const v68Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v68Row?.schema_version ?? 0) < 68) {
      try {
        // 1. Add memories.kind column
        const memoriesCols = database.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
        if (!memoriesCols.some((c) => c.name === "kind")) {
          database.exec("ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'observation'");
        }

        // 2. Add roles.last_reflection_at column
        const rolesCols = database.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>;
        if (!rolesCols.some((c) => c.name === "last_reflection_at")) {
          database.exec("ALTER TABLE roles ADD COLUMN last_reflection_at INTEGER");
        }

        // 3. Add server_state.last_memory_gc_at column
        const stateCols = database.prepare("PRAGMA table_info(server_state)").all() as Array<{ name: string }>;
        if (!stateCols.some((c) => c.name === "last_memory_gc_at")) {
          database.exec("ALTER TABLE server_state ADD COLUMN last_memory_gc_at INTEGER");
        }

        // 4. Create beliefs table if missing
        const beliefsExists = database.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='beliefs'"
        ).get();
        if (!beliefsExists) {
          database.exec(`
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
              status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('core','challenger','candidate')),
              trial_count INTEGER NOT NULL DEFAULT 0,
              delta_sum REAL NOT NULL DEFAULT 0,
              expires_at INTEGER,
              success_ema REAL
            )
          `);
          database.exec("CREATE INDEX idx_beliefs_role_id ON beliefs(role_id)");
          database.exec("CREATE INDEX idx_beliefs_role_anti ON beliefs(role_id, is_anti)");
          database.exec("CREATE INDEX idx_beliefs_last_used ON beliefs(last_used_at)");

          // 5. FTS5 virtual table for beliefs
          database.exec(`
            CREATE VIRTUAL TABLE beliefs_fts USING fts5(content, content='beliefs', content_rowid='rowid')
          `);

          // 6. FTS5 sync triggers for beliefs
          database.exec(`
            CREATE TRIGGER beliefs_fts_insert AFTER INSERT ON beliefs BEGIN
              INSERT INTO beliefs_fts(rowid, content) VALUES (new.rowid, new.content);
            END
          `);
          database.exec(`
            CREATE TRIGGER beliefs_fts_delete AFTER DELETE ON beliefs BEGIN
              INSERT INTO beliefs_fts(beliefs_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
            END
          `);
          database.exec(`
            CREATE TRIGGER beliefs_fts_update AFTER UPDATE ON beliefs BEGIN
              INSERT INTO beliefs_fts(beliefs_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
              INSERT INTO beliefs_fts(rowid, content) VALUES (new.rowid, new.content);
            END
          `);
        }

        database.prepare("UPDATE server_state SET schema_version = 68 WHERE id = 1").run();
      } catch (err) {
        throw new Error(`Schema v68 migration failed: ${err}`);
      }
    }
  }

  // Schema v69: tasks.context_meta + roles.memory_budget_tokens
  {
    const v69Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v69Row?.schema_version ?? 0) < 69) {
      try {
        // 1. Add tasks.context_meta column
        const tasksCols = database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
        if (!tasksCols.some((c) => c.name === "context_meta")) {
          database.exec("ALTER TABLE tasks ADD COLUMN context_meta TEXT");
        }

        // 2. Add roles.memory_budget_tokens column
        const rolesCols = database.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>;
        if (!rolesCols.some((c) => c.name === "memory_budget_tokens")) {
          database.exec("ALTER TABLE roles ADD COLUMN memory_budget_tokens INTEGER");
        }

        database.prepare("UPDATE server_state SET schema_version = 69 WHERE id = 1").run();
      } catch (err) {
        throw new Error(`Schema v69 migration failed: ${err}`);
      }
    }
  }

  // Schema v70: task_templates.retryPolicy
  {
    const v70Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v70Row?.schema_version ?? 0) < 70) {
      try {
        const tmplCols = database.prepare("PRAGMA table_info(task_templates)").all() as Array<{ name: string }>;
        if (!tmplCols.some((c) => c.name === "retry_policy")) {
          database.exec("ALTER TABLE task_templates ADD COLUMN retry_policy TEXT");
        }
        database.prepare("UPDATE server_state SET schema_version = 70 WHERE id = 1").run();
      } catch (err) {
        throw new Error(`Schema v70 migration failed: ${err}`);
      }
    }
  }

  // Schema v71: extensions, role_extensions, extension_health tables
  {
    const v71Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v71Row?.schema_version ?? 0) < 71) {
      try {
        database.prepare(`CREATE TABLE IF NOT EXISTS extensions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          version TEXT NOT NULL,
          manifest_json TEXT NOT NULL,
          install_source TEXT NOT NULL DEFAULT 'upload',
          package_hash TEXT NOT NULL,
          default_config_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`).run();
        database.prepare("CREATE INDEX IF NOT EXISTS idx_extensions_name ON extensions(name)").run();
        database.prepare(`CREATE TABLE IF NOT EXISTS role_extensions (
          id TEXT PRIMARY KEY,
          role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
          extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
          enabled INTEGER NOT NULL DEFAULT 1,
          config_override_json TEXT,
          generated_server_name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(role_id, extension_id)
        )`).run();
        database.prepare("CREATE INDEX IF NOT EXISTS idx_role_extensions_role_id ON role_extensions(role_id)").run();
        database.prepare("CREATE INDEX IF NOT EXISTS idx_role_extensions_extension_id ON role_extensions(extension_id)").run();
        database.prepare(`CREATE TABLE IF NOT EXISTS extension_health (
          extension_id TEXT PRIMARY KEY REFERENCES extensions(id) ON DELETE CASCADE,
          last_run_at INTEGER,
          last_status TEXT,
          last_error TEXT,
          last_role_id TEXT,
          last_task_id TEXT
        )`).run();
        database.prepare("UPDATE server_state SET schema_version = 71 WHERE id = 1").run();
      } catch (err) {
        throw new Error(`Schema v71 migration failed: ${err}`);
      }
    }
  }

  // Schema v72: rename template_execution_artifacts → artifacts; add source_kind, task_id,
  // chat_session_id, role_id columns; 3-arm CHECK constraint; 9 indexes; backfill existing rows.
  {
    const v72Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v72Row?.schema_version ?? 0) < 72) {
      try {
        database.exec(`
          CREATE TABLE IF NOT EXISTS artifacts (
            id TEXT PRIMARY KEY,
            source_kind TEXT NOT NULL CHECK (source_kind IN ('template_step', 'task_published', 'chat_sent')),
            execution_id TEXT REFERENCES template_executions(id) ON DELETE CASCADE,
            task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
            chat_session_id TEXT REFERENCES chat_sessions(id) ON DELETE CASCADE,
            step_id TEXT,
            role_id TEXT,
            key TEXT,
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
            CHECK (
              (source_kind = 'template_step' AND execution_id IS NOT NULL AND task_id IS NULL AND chat_session_id IS NULL AND step_id IS NOT NULL)
              OR (source_kind = 'task_published' AND task_id IS NOT NULL AND execution_id IS NULL AND chat_session_id IS NULL)
              OR (source_kind = 'chat_sent' AND chat_session_id IS NOT NULL AND task_id IS NULL AND execution_id IS NULL)
            )
          )
        `);

        // Backfill from legacy table if it exists
        const legacyTable = database.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='template_execution_artifacts'"
        ).get();
        if (legacyTable) {
          const legacyCount = (database.prepare(
            "SELECT COUNT(*) AS n FROM template_execution_artifacts",
          ).get() as { n: number }).n;

          database.exec(`
            INSERT INTO artifacts (
              id, source_kind, execution_id, task_id, chat_session_id, step_id, role_id,
              key, kind, value_json, blob_path, mime, original_filename, size_bytes, created_at,
              locator, content_hash, retention_hint, encryption_class, purpose, replaces, produced_by_role, access
            )
            SELECT
              id,
              'template_step' AS source_kind,
              execution_id,
              NULL AS task_id,
              NULL AS chat_session_id,
              step_id,
              produced_by_role AS role_id,
              key, kind, value_json, blob_path, mime, original_filename, size_bytes, created_at,
              locator, content_hash, retention_hint, encryption_class, purpose, replaces, produced_by_role, access
            FROM template_execution_artifacts
          `);

          // Defense-in-depth: assert row count parity before dropping the legacy table.
          // SQLite throws on bad INSERTs (CHECK / FK / NOT NULL violations), so this guard
          // only fires if the SELECT silently returned fewer rows than expected (e.g. a future
          // change to the SELECT predicate). Explicit signal beats silent partial migration.
          const migratedCount = (database.prepare(
            "SELECT COUNT(*) AS n FROM artifacts WHERE source_kind = 'template_step'",
          ).get() as { n: number }).n;
          if (migratedCount !== legacyCount) {
            throw new Error(
              `v72 migration row-count mismatch: legacy=${legacyCount}, migrated=${migratedCount}`,
            );
          }

          database.exec("DROP TABLE template_execution_artifacts");
        }

        // 9 indexes
        database.prepare("CREATE INDEX IF NOT EXISTS idx_artifacts_execution_id ON artifacts(execution_id) WHERE execution_id IS NOT NULL").run();
        database.prepare("CREATE INDEX IF NOT EXISTS idx_artifacts_task_id ON artifacts(task_id) WHERE task_id IS NOT NULL").run();
        database.prepare("CREATE INDEX IF NOT EXISTS idx_artifacts_chat_session_id ON artifacts(chat_session_id) WHERE chat_session_id IS NOT NULL").run();
        database.prepare("CREATE INDEX IF NOT EXISTS idx_artifacts_role_id ON artifacts(role_id) WHERE role_id IS NOT NULL").run();
        database.prepare("CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at DESC)").run();
        database.prepare("CREATE INDEX IF NOT EXISTS idx_artifacts_source_kind ON artifacts(source_kind)").run();
        database.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_template_step_key ON artifacts(execution_id, step_id, key) WHERE source_kind = 'template_step'").run();
        database.prepare("CREATE INDEX IF NOT EXISTS idx_artifacts_replaces ON artifacts(replaces) WHERE replaces IS NOT NULL").run();
        database.prepare("CREATE INDEX IF NOT EXISTS idx_artifacts_content_hash ON artifacts(content_hash) WHERE content_hash IS NOT NULL").run();

        database.prepare("UPDATE server_state SET schema_version = 72 WHERE id = 1").run();
      } catch (err) {
        throw new Error(`Schema v72 migration failed: ${err}`);
      }
    }
  }

  {
    const v73Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v73Row?.schema_version ?? 0) < 73) {
      try {
        const cols = database.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
        const hasPriority = cols.some((c) => c.name === "priority");
        if (!hasPriority) {
          database.prepare("ALTER TABLE artifacts ADD COLUMN priority INTEGER").run();
        }
        database.prepare("UPDATE server_state SET schema_version = 73 WHERE id = 1").run();
      } catch (err) {
        throw new Error(`Schema v73 migration failed: ${err}`);
      }
    }
  }

  {
    const v74Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v74Row?.schema_version ?? 0) < 74) {
      try {
        const cols = database.prepare("PRAGMA table_info(channels)").all() as Array<{ name: string }>;
        const hasCapMap = cols.some((c) => c.name === "recipient_cap_map_json");
        const hasDefault = cols.some((c) => c.name === "default_recipient_cap_bytes");
        if (!hasCapMap) {
          database.prepare("ALTER TABLE channels ADD COLUMN recipient_cap_map_json TEXT").run();
        }
        if (!hasDefault) {
          database.prepare("ALTER TABLE channels ADD COLUMN default_recipient_cap_bytes INTEGER").run();
        }
        database.prepare("UPDATE server_state SET schema_version = 74 WHERE id = 1").run();
      } catch (err) {
        throw new Error(`Schema v74 migration failed: ${err}`);
      }
    }
  }

  // ===== Schema v75: extend audit_violations.layer CHECK to include 'C' =====
  // Phase 1 of podcast customAssertions added Layer C semantic verification. TypeScript
  // AuditViolation.layer union was extended to "A" | "B" | "C", but the production DB CHECK
  // constraint was originally CHECK(layer IN ('A', 'B')). Without this migration, every
  // Layer C violation insert would fail at runtime.
  //
  // SQLite cannot ALTER a column's CHECK constraint, so per Adam CLAUDE.md "SQLite Migration
  // Rules" #3 (table recreation for constraint changes): create new table → INSERT SELECT
  // FROM old → DROP old → RENAME → recreate indexes. All existing audit_violations rows are
  // preserved (rule #1: never DROP or DELETE user data).
  {
    const v75Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v75Row?.schema_version ?? 0) < 75) {
      try {
        // Guard with table-existence check per migration rule #4 (never trust schema_version alone).
        const tableInfo = database.prepare("PRAGMA table_info(audit_violations)").all() as Array<{ name: string }>;
        if (tableInfo.length > 0) {
          // Sniff current CHECK constraint from sqlite_master. If 'C' is already present (e.g.,
          // prior manual repair), skip recreation but still bump schema_version.
          const tableSql = database.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_violations'"
          ).get() as { sql: string } | undefined;
          const alreadyHasC = tableSql?.sql.includes("'A', 'B', 'C'") ?? false;

          if (!alreadyHasC) {
            // Recreate via temp table with new CHECK constraint.
            database.prepare(`
              CREATE TABLE audit_violations_new (
                id TEXT PRIMARY KEY,
                step_task_id TEXT NOT NULL,
                execution_id TEXT,
                role_id TEXT NOT NULL,
                contract_field TEXT NOT NULL,
                layer TEXT NOT NULL CHECK(layer IN ('A', 'B', 'C')),
                severity TEXT NOT NULL CHECK(severity IN ('error', 'warning')),
                message TEXT NOT NULL,
                metadata_json TEXT,
                created_at INTEGER NOT NULL
              )
            `).run();
            database.prepare(`
              INSERT INTO audit_violations_new
                (id, step_task_id, execution_id, role_id, contract_field, layer, severity, message, metadata_json, created_at)
              SELECT
                id, step_task_id, execution_id, role_id, contract_field, layer, severity, message, metadata_json, created_at
              FROM audit_violations
            `).run();
            database.prepare("DROP TABLE audit_violations").run();
            database.prepare("ALTER TABLE audit_violations_new RENAME TO audit_violations").run();
            database.prepare("CREATE INDEX IF NOT EXISTS idx_audit_violations_role ON audit_violations(role_id, created_at DESC)").run();
            database.prepare("CREATE INDEX IF NOT EXISTS idx_audit_violations_task ON audit_violations(step_task_id)").run();
            database.prepare("CREATE INDEX IF NOT EXISTS idx_audit_violations_execution ON audit_violations(execution_id, created_at DESC)").run();
          }
        }
        database.prepare("UPDATE server_state SET schema_version = 75 WHERE id = 1").run();
        console.info("[db migration v75] audit_violations.layer CHECK extended to include 'C' for Phase 1 customAssertions");
      } catch (err) {
        throw new Error(`Schema v75 migration failed: ${err}`);
      }
    }
  }

  // ===== Schema v76: task_files table =====
  // Stores per-task filesystem inventory (added/modified/deleted files) produced by
  // ExecutionManager workspace snapshot diff at task start/end. Consumers: nudge prompt,
  // failed-delivery fallback, audit, retention. FK CASCADE to tasks for automatic cleanup.
  {
    const v76Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v76Row?.schema_version ?? 0) < 76) {
      try {
        // Guard with table-existence check per migration rule #4 (never trust schema_version alone).
        const taskFilesExists = (database.prepare(
          "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='task_files'"
        ).get() as { cnt: number }).cnt > 0;
        if (!taskFilesExists) {
          database.prepare(`
            CREATE TABLE task_files (
              id TEXT PRIMARY KEY,
              task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
              path TEXT NOT NULL,
              op TEXT NOT NULL CHECK(op IN ('added','modified','deleted')),
              mtime_ns INTEGER,
              size_bytes INTEGER,
              inode INTEGER,
              created_at INTEGER NOT NULL
            )
          `).run();
          database.prepare("CREATE INDEX idx_task_files_task_id ON task_files(task_id)").run();
          database.prepare("CREATE INDEX idx_task_files_path ON task_files(path)").run();
        }
        database.prepare("UPDATE server_state SET schema_version = 76 WHERE id = 1").run();
        console.info("[db migration v76] task_files table created for workspace snapshot inventory");
      } catch (err) {
        throw new Error(`Schema v76 migration failed: ${err}`);
      }
    }
  }

  // ===== Schema v77: editor_scores table (podcast Phase 2 — 钱钟书 review-editor) =====
  // One row per scored candidate in a parallel-N podcast run. Consumer: the Phase 2
  // retrospective query — AVG(scores) GROUP BY brief_diff across many runs reveals which
  // brief perturbation yields the highest insight density, feeding back into SKILL.md tuning.
  // template_run_id is a plain column, NOT a FK CASCADE to template_executions: editor_scores
  // is retrospective/analytics data that must outlive run-record pruning by the dbMaintenance
  // watchdog. A CASCADE would delete the retrospective substrate along with old run rows.
  {
    const v77Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v77Row?.schema_version ?? 0) < 77) {
      try {
        // Guard with table-existence check per migration rule #4 (never trust schema_version alone).
        const editorScoresExists = (database.prepare(
          "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='editor_scores'"
        ).get() as { cnt: number }).cnt > 0;
        if (!editorScoresExists) {
          database.prepare(`
            CREATE TABLE editor_scores (
              id TEXT PRIMARY KEY,
              template_run_id TEXT NOT NULL,
              candidate_id TEXT NOT NULL,
              scores TEXT NOT NULL,
              selected INTEGER NOT NULL DEFAULT 0,
              editor_notes TEXT,
              brief_diff TEXT,
              created_at INTEGER NOT NULL
            )
          `).run();
          database.prepare("CREATE INDEX idx_editor_scores_template_run_id ON editor_scores(template_run_id)").run();
          database.prepare("CREATE INDEX idx_editor_scores_created_at ON editor_scores(created_at)").run();
        }
        database.prepare("UPDATE server_state SET schema_version = 77 WHERE id = 1").run();
        console.info("[db migration v77] editor_scores table created for podcast Phase 2 retrospective");
      } catch (err) {
        throw new Error(`Schema v77 migration failed: ${err}`);
      }
    }
  }

  // ===== Schema v78: artifacts.artifact_role column (outputContract.expectedArtifacts) =====
  // Records the logical artifact role declared by a step's outputContract.expectedArtifacts.
  // publish_artifact_file counts artifacts per (execution_id, step_id, artifact_role) to
  // enforce the per-role count contract at the tool boundary. Nullable — back-compatible
  // with all existing artifacts and steps that declare no expectedArtifacts.
  {
    const v78Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v78Row?.schema_version ?? 0) < 78) {
      try {
        // Guard with column-existence check per migration rule #4 (never trust schema_version alone).
        const artifactsCols = database.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
        if (!artifactsCols.some((c) => c.name === "artifact_role")) {
          database.prepare("ALTER TABLE artifacts ADD COLUMN artifact_role TEXT").run();
        }
        database.prepare("UPDATE server_state SET schema_version = 78 WHERE id = 1").run();
        console.info("[db migration v78] artifacts.artifact_role column added for expectedArtifacts contract");
      } catch (err) {
        throw new Error(`Schema v78 migration failed: ${err}`);
      }
    }
  }

  // ===== Schema v79: beliefs scope/status columns + belief_scopes table =====
  {
    const v79Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v79Row?.schema_version ?? 0) < 79) {
      try {
        const beliefsCols = database.prepare("PRAGMA table_info(beliefs)").all() as Array<{ name: string }>;
        if (!beliefsCols.some((c) => c.name === "scope_key")) {
          database.prepare("ALTER TABLE beliefs ADD COLUMN scope_key TEXT").run();
        }
        if (!beliefsCols.some((c) => c.name === "status")) {
          database.prepare("ALTER TABLE beliefs ADD COLUMN status TEXT NOT NULL DEFAULT 'candidate'").run();
        }
        if (!beliefsCols.some((c) => c.name === "trial_count")) {
          database.prepare("ALTER TABLE beliefs ADD COLUMN trial_count INTEGER NOT NULL DEFAULT 0").run();
        }
        if (!beliefsCols.some((c) => c.name === "delta_sum")) {
          database.prepare("ALTER TABLE beliefs ADD COLUMN delta_sum REAL NOT NULL DEFAULT 0").run();
        }
        if (!beliefsCols.some((c) => c.name === "expires_at")) {
          database.prepare("ALTER TABLE beliefs ADD COLUMN expires_at INTEGER").run();
        }
        if (!beliefsCols.some((c) => c.name === "success_ema")) {
          database.prepare("ALTER TABLE beliefs ADD COLUMN success_ema REAL").run();
        }
        database.exec(`
          CREATE TABLE IF NOT EXISTS belief_scopes (
            scope_key TEXT PRIMARY KEY,
            role_id TEXT NOT NULL,
            step_kind TEXT NOT NULL,
            score_ema REAL,
            score_var_ema REAL NOT NULL DEFAULT 0,
            sample_count INTEGER NOT NULL DEFAULT 0,
            current_challenger_id TEXT,
            updated_at INTEGER NOT NULL
          )
        `);
        database.exec("CREATE INDEX IF NOT EXISTS idx_beliefs_scope_status ON beliefs(scope_key, status)");
        database.exec("CREATE INDEX IF NOT EXISTS idx_beliefs_expires ON beliefs(expires_at)");
        const candidateTtlMs = 14 * 86400 * 1000;
        const expiresAt = Date.now() + candidateTtlMs;
        database.prepare(
          "UPDATE beliefs SET scope_key = role_id || '::pool', status = 'candidate', expires_at = ? WHERE scope_key IS NULL"
        ).run(expiresAt);
        database.prepare("UPDATE server_state SET schema_version = 79 WHERE id = 1").run();
        console.info("[db migration v79] beliefs scope/status columns + belief_scopes table created");
      } catch (err) {
        throw new Error(`Schema v79 migration failed: ${err}`);
      }
    }
  }

  // ===== Schema v80: user_feedback table =====
  {
    const v80Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v80Row?.schema_version ?? 0) < 80) {
      try {
        database.exec(`
          CREATE TABLE IF NOT EXISTS user_feedback (
            id TEXT PRIMARY KEY,
            execution_id TEXT NOT NULL,
            step_id TEXT,
            rating TEXT NOT NULL CHECK(rating IN ('good','bad')),
            created_at INTEGER NOT NULL
          )
        `);
        database.prepare("UPDATE server_state SET schema_version = 80 WHERE id = 1").run();
        console.info("[db migration v80] user_feedback table created");
      } catch (err) {
        throw new Error(`Schema v80 migration failed: ${err}`);
      }
    }
  }

  // ===== Schema v81: belief evolution v3 — three-state collapse + task_seq clock + DP-001 inject_count =====
  {
    const v81Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v81Row?.schema_version ?? 0) < 81) {
      try {
        // 1. roles.task_seq — monotonic clock driving belief decay
        const rolesCols = database.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>;
        if (!rolesCols.some((c) => c.name === "task_seq")) {
          database.exec("ALTER TABLE roles ADD COLUMN task_seq INTEGER NOT NULL DEFAULT 0");
        }

        // 2. DROP FTS5 triggers + virtual table BEFORE dropping beliefs
        //    (postmortem 2026-04-05: FTS5 trigger references must be removed before table drop)
        database.prepare("DROP TRIGGER IF EXISTS beliefs_fts_insert").run();
        database.prepare("DROP TRIGGER IF EXISTS beliefs_fts_delete").run();
        database.prepare("DROP TRIGGER IF EXISTS beliefs_fts_update").run();
        database.prepare("DROP TABLE IF EXISTS beliefs_fts").run();

        // 3. Recreate beliefs table: drop 6 dead columns, tighten status to two-state,
        //    add inject_count (DP-001 Option A)
        database.exec(`
          CREATE TABLE beliefs_new (
            id TEXT PRIMARY KEY,
            role_id TEXT NOT NULL,
            content TEXT NOT NULL,
            is_anti INTEGER NOT NULL DEFAULT 0 CHECK(is_anti IN (0, 1)),
            evidence_obs_ids TEXT,
            embedding BLOB,
            superseded_by TEXT,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER NOT NULL,
            last_validated_at INTEGER NOT NULL,
            scope_key TEXT,
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
            success_ema REAL,
            inject_count INTEGER NOT NULL DEFAULT 0
          )
        `);

        // Seed during INSERT SELECT:
        //   - all rows -> status='active' (v2 three-state collapsed)
        //   - success_ema -> COALESCE(success_ema, 0.5) (seed NULL with 0.5)
        //   - last_used_at -> 0 (reset to role.task_seq=0; roles.task_seq starts at 0)
        //   - inject_count -> 0 (new column)
        database.exec(`
          INSERT INTO beliefs_new (id, role_id, content, is_anti, evidence_obs_ids, embedding, superseded_by,
                                   created_at, last_used_at, last_validated_at, scope_key, status, success_ema, inject_count)
          SELECT id, role_id, content, is_anti, evidence_obs_ids, embedding, superseded_by,
                 created_at, 0, last_validated_at, scope_key, 'active',
                 COALESCE(success_ema, 0.5), 0
          FROM beliefs
        `);

        database.exec("DROP TABLE beliefs");
        database.exec("ALTER TABLE beliefs_new RENAME TO beliefs");

        // Recreate indexes
        database.exec("CREATE INDEX IF NOT EXISTS idx_beliefs_role ON beliefs(role_id)");
        database.exec("CREATE INDEX IF NOT EXISTS idx_beliefs_last_used ON beliefs(last_used_at)");
        database.exec("CREATE INDEX IF NOT EXISTS idx_beliefs_status ON beliefs(status)");
        database.exec("CREATE INDEX IF NOT EXISTS idx_beliefs_scope ON beliefs(scope_key)");

        // 4. Recreate FTS5 virtual table + triggers (same structure as v68)
        database.exec(`
          CREATE VIRTUAL TABLE beliefs_fts USING fts5(content, content='beliefs', content_rowid='rowid')
        `);
        database.exec(`
          CREATE TRIGGER beliefs_fts_insert AFTER INSERT ON beliefs BEGIN
            INSERT INTO beliefs_fts(rowid, content) VALUES (new.rowid, new.content);
          END
        `);
        database.exec(`
          CREATE TRIGGER beliefs_fts_delete AFTER DELETE ON beliefs BEGIN
            INSERT INTO beliefs_fts(beliefs_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
          END
        `);
        database.exec(`
          CREATE TRIGGER beliefs_fts_update AFTER UPDATE ON beliefs BEGIN
            INSERT INTO beliefs_fts(beliefs_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
            INSERT INTO beliefs_fts(rowid, content) VALUES (new.rowid, new.content);
          END
        `);

        // 5. Backfill FTS5 index (triggers only fire on future writes; existing rows must be seeded)
        database.exec("INSERT INTO beliefs_fts(rowid, content) SELECT rowid, content FROM beliefs");

        // 6. Drop belief_scopes table (v2 mechanism removed)
        database.exec("DROP TABLE IF EXISTS belief_scopes");

        // 7. CRITICAL: schema_version UPDATE inside guard (KB postmortem 2026-04-05)
        database.prepare("UPDATE server_state SET schema_version = 81 WHERE id = 1").run();
        console.info("[db migration v81] belief evolution v3: three-state collapse + task_seq clock + inject_count (DP-001) + FTS5 rebuild");
      } catch (err) {
        throw new Error(`Schema v81 migration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ===== Schema v82: belief evolution v3 — data normalization (post-review-fix data residue) =====
  //
  // Cleans up two residues left by the v3 forward-only fixes:
  // 1. scope_key='<role>::pool' on 1257+ legacy migrated rows — the v81 migration preserved the
  //    old scope shape, forcing belief-injection + reflection mergedScopeKey to carry endsWith("::pool")
  //    band-aid clauses to keep the rows visible. After v82 these rows have scope_key=NULL like all
  //    new reflection writes; the band-aid clauses are removed in the same change.
  // 2. last_used_at as ms-timestamp (~1.7e12) on beliefs written during the bug #2 window — these
  //    rows have delta=max(0, role.task_seq − 1.7e12)=0 forever, never decaying and never archiving.
  //    Clamp last_used_at to role.task_seq so they re-enter the normal decay path on next touch.
  {
    const v82Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v82Row?.schema_version ?? 0) < 82) {
      try {
        // 1. Normalize legacy ::pool scope_key to NULL (matches new reflection writes)
        const poolUpdate = database.prepare(
          "UPDATE beliefs SET scope_key = NULL WHERE scope_key LIKE '%::pool'"
        ).run();

        // 2. Clamp ms-timestamp last_used_at to per-role task_seq.
        // Threshold 1e9 picked because role.task_seq is realistically <1e7 even for the most active
        // roles, and any Date.now() value is >1e12 — wide gap, no false positives. Falls back to 0
        // when role row missing (defensive; shouldn't happen).
        const clampUpdate = database.prepare(
          "UPDATE beliefs SET last_used_at = COALESCE((SELECT task_seq FROM roles WHERE roles.id = beliefs.role_id), 0) WHERE last_used_at > 1000000000"
        ).run();

        database.prepare("UPDATE server_state SET schema_version = 82 WHERE id = 1").run();
        console.info(`[db migration v82] belief data normalization: ${poolUpdate.changes} ::pool rows nulled, ${clampUpdate.changes} ms-timestamp last_used_at clamped`);
      } catch (err) {
        throw new Error(`Schema v82 migration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ===== Schema v83: tasks.cost_breakdown — per-model cost attribution + provenance =====
  {
    const v83Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v83Row?.schema_version ?? 0) < 83) {
      try {
        const cols = database.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
        if (!cols.some(c => c.name === "cost_breakdown")) {
          database.exec("ALTER TABLE tasks ADD COLUMN cost_breakdown TEXT");
        }
        database.prepare("UPDATE server_state SET schema_version = 83 WHERE id = 1").run();
        console.info("[db migration v83] tasks.cost_breakdown column added");
      } catch (err) {
        throw new Error(`Schema v83 migration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ===== Schema v84: llm_costs table (unified LLM cost store) + DP-001=A backfill =====
  {
    const v84Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v84Row?.schema_version ?? 0) < 84) {
      try {
        // Create llm_costs table if not present
        database.exec(`
          CREATE TABLE IF NOT EXISTS llm_costs (
            id TEXT PRIMARY KEY,
            call_id TEXT NOT NULL,
            source TEXT NOT NULL,
            model TEXT NOT NULL,
            role_id TEXT,
            task_id TEXT,
            session_id TEXT,
            message_id TEXT,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd REAL NOT NULL DEFAULT 0,
            priced INTEGER NOT NULL DEFAULT 0,
            estimated INTEGER NOT NULL DEFAULT 0,
            sdk_total_cost_usd REAL,
            num_turns INTEGER,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_llm_costs_created ON llm_costs(created_at);
          CREATE INDEX IF NOT EXISTS idx_llm_costs_source ON llm_costs(source);
          CREATE INDEX IF NOT EXISTS idx_llm_costs_model ON llm_costs(model);
          CREATE INDEX IF NOT EXISTS idx_llm_costs_role ON llm_costs(role_id);
        `);

        // DP-001=A backfill: populate llm_costs from existing tasks rows
        // (source=task only; historical chat/eval costs were never captured)
        const taskRows = database.prepare(
          "SELECT id, cost_usd, token_usage, cost_breakdown, created_at FROM tasks WHERE cost_usd IS NOT NULL"
        ).all() as Array<{
          id: string;
          cost_usd: number;
          token_usage: string | null;
          cost_breakdown: string | null;
          created_at: number;
        }>;

        const insertRow = database.prepare(`
          INSERT OR IGNORE INTO llm_costs
            (id, call_id, source, model, role_id, task_id, session_id, message_id,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
             cost_usd, priced, estimated, sdk_total_cost_usd, num_turns, created_at)
          VALUES
            (?, ?, 'task', ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
        `);

        let backfillCount = 0;
        for (const task of taskRows) {
          const callId = `backfill-${task.id}`;
          let tokenUsage: { input?: number; output?: number } = {};
          if (task.token_usage) {
            try { tokenUsage = JSON.parse(task.token_usage); } catch { /* ignore */ }
          }

          let breakdown: { perModel?: Array<{
            model: string; priced: boolean; estimated: boolean;
            inputTokens: number; outputTokens: number;
            cacheReadTokens: number; cacheCreationTokens: number;
            costUsd: number;
          }> } | null = null;
          if (task.cost_breakdown) {
            try { breakdown = JSON.parse(task.cost_breakdown); } catch { /* ignore */ }
          }

          if (breakdown && Array.isArray(breakdown.perModel) && breakdown.perModel.length > 0) {
            // Insert one row per perModel entry
            for (let i = 0; i < breakdown.perModel.length; i++) {
              const pm = breakdown.perModel[i];
              const rowId = `${callId}-${i}`;
              insertRow.run(
                rowId, callId, pm.model, task.id,
                pm.inputTokens ?? 0, pm.outputTokens ?? 0,
                pm.cacheReadTokens ?? 0, pm.cacheCreationTokens ?? 0,
                pm.costUsd ?? 0, pm.priced ? 1 : 0, pm.estimated ? 1 : 0,
                task.created_at ?? Date.now()
              );
              backfillCount++;
            }
          } else {
            // No breakdown: insert single fallback row
            // Non-zero cost_usd means it was a real (priced) call even if model is unrecoverable
            const rowId = `${callId}-0`;
            const priced = task.cost_usd > 0 ? 1 : 0;
            insertRow.run(
              rowId, callId, "unknown", task.id,
              tokenUsage.input ?? 0, tokenUsage.output ?? 0,
              0, 0, task.cost_usd, priced, 0,
              task.created_at ?? Date.now()
            );
            backfillCount++;
          }
        }

        database.prepare("UPDATE server_state SET schema_version = 84 WHERE id = 1").run();
        console.info(`[db migration v84] llm_costs table created + ${backfillCount} rows backfilled from tasks`);
      } catch (err) {
        throw new Error(`Schema v84 migration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ===== Schema v85: chat_messages cost columns (cost_usd, token_usage, model) =====
  {
    const v85Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v85Row?.schema_version ?? 0) < 85) {
      try {
        const cols = database.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>;
        const hasCol = (name: string) => cols.some(c => c.name === name);
        if (!hasCol("cost_usd")) {
          database.exec("ALTER TABLE chat_messages ADD COLUMN cost_usd REAL");
        }
        if (!hasCol("token_usage")) {
          database.exec("ALTER TABLE chat_messages ADD COLUMN token_usage TEXT");
        }
        if (!hasCol("model")) {
          database.exec("ALTER TABLE chat_messages ADD COLUMN model TEXT");
        }
        database.prepare("UPDATE server_state SET schema_version = 85 WHERE id = 1").run();
        console.info("[db migration v85] chat_messages cost columns added (cost_usd, token_usage, model)");
      } catch (err) {
        throw new Error(`Schema v85 migration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ===== Schema v87: drift repair — re-assert cost columns that v83/v85 failed to add =====
  // Root cause: during development the cost migrations were renumbered, so a real DB could
  // reach schema_version 86 while tasks.cost_breakdown (v83) and chat_messages.cost_usd/
  // token_usage/model (v85) were never applied — the version-gated v83/v85 blocks are then
  // skipped forever (86 >= their guard). Per CLAUDE.md SQLite rule #4, column-existence is the
  // primary guard here; the version bump to 87 only stops healthy DBs from re-checking.
  // Symptom this fixes: `SqliteError: table tasks has no column named cost_breakdown` on task INSERT.
  {
    const v87Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v87Row?.schema_version ?? 0) < 87) {
      try {
        const taskCols = database.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
        if (!taskCols.some(c => c.name === "cost_breakdown")) {
          database.exec("ALTER TABLE tasks ADD COLUMN cost_breakdown TEXT");
          console.info("[db migration v87] tasks.cost_breakdown re-added (drift repair)");
        }
        const msgCols = database.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>;
        const hasMsgCol = (name: string) => msgCols.some(c => c.name === name);
        if (!hasMsgCol("cost_usd")) {
          database.exec("ALTER TABLE chat_messages ADD COLUMN cost_usd REAL");
          console.info("[db migration v87] chat_messages.cost_usd re-added (drift repair)");
        }
        if (!hasMsgCol("token_usage")) {
          database.exec("ALTER TABLE chat_messages ADD COLUMN token_usage TEXT");
          console.info("[db migration v87] chat_messages.token_usage re-added (drift repair)");
        }
        if (!hasMsgCol("model")) {
          database.exec("ALTER TABLE chat_messages ADD COLUMN model TEXT");
          console.info("[db migration v87] chat_messages.model re-added (drift repair)");
        }
        database.prepare("UPDATE server_state SET schema_version = 87 WHERE id = 1").run();
      } catch (err) {
        throw new Error(`Schema v87 migration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ===== Schema v88: add sdk_session_id to chat_sessions for per-session resume =====
  // Each chat session may maintain a long-lived Claude Code process; sdk_session_id
  // survives server restarts so the next message can resume instead of starting fresh.
  // NULL = no live SDK session yet → fresh-create on next message (safe default).
  {
    const v88Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v88Row?.schema_version ?? 0) < 88) {
      try {
        const chatSessionCols = database.prepare("PRAGMA table_info(chat_sessions)").all() as Array<{ name: string }>;
        if (!chatSessionCols.some(c => c.name === "sdk_session_id")) {
          database.exec("ALTER TABLE chat_sessions ADD COLUMN sdk_session_id TEXT");
          console.info("[db migration v88] chat_sessions.sdk_session_id added");
        }
        database.prepare("UPDATE server_state SET schema_version = 88 WHERE id = 1").run();
      } catch (err) {
        throw new Error(`Schema v88 migration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Idempotent code-level migration (every startup): auto-repair enabled templates
  // whose steps have neither roleId nor autoSelectRole AND whose template lacks
  // rolePreference. Patches each such step with autoSelectRole=true, requirements={}
  // so the template can actually dispatch (admission gate at task-admission.ts:263+274).
  //
  // NOT a schema version bump -- schema unchanged, only row data mutated. Runs every
  // startup so broken templates imported later (e.g., restored from backup, created by
  // older clients) are also healed without requiring another version bump.
  {
    try {
      const rows = database.prepare(
        "SELECT id, name, steps, role_preference FROM task_templates WHERE enabled = 1",
      ).all() as Array<{ id: string; name: string; steps: string; role_preference: string | null }>;
      let repairedCount = 0;
      for (const row of rows) {
        if (row.role_preference) continue; // template-level default covers all steps
        let steps: Array<Record<string, unknown>>;
        try {
          steps = JSON.parse(row.steps);
        } catch {
          continue;
        }
        if (!Array.isArray(steps)) continue;
        let mutated = false;
        for (const step of steps) {
          const hasRole = typeof step.roleId === "string" && (step.roleId as string).length > 0;
          const hasAuto = step.autoSelectRole === true;
          if (!hasRole && !hasAuto) {
            step.autoSelectRole = true;
            if (step.requirements === undefined) step.requirements = {};
            mutated = true;
          }
        }
        if (mutated) {
          database.prepare("UPDATE task_templates SET steps = ?, updated_at = ? WHERE id = ?").run(
            JSON.stringify(steps),
            Date.now(),
            row.id,
          );
          repairedCount += 1;
          // Use console.info (logger may not be initialized at migration time).
          console.info(`[db migration] template auto-repaired: id=${row.id} name=${row.name}`);
        }
      }
      if (repairedCount > 0) {
        console.info(`[db migration] auto-repaired ${repairedCount} enabled template(s) with missing role config`);
      }
    } catch (err) {
      console.error("[db migration] template auto-repair failed:", err);
    }
  }

  // ===== Schema v89: template_versions (Phase 0.5 template auto-versioning) =====
  // Each content-changing update of a task_templates row (or its delete) snapshots
  // the full pre-change detail into template_versions. Supports list/diff/restore
  // from store choke-point (covers both adam-tools and WebUI REST PATCH paths).
  //
  // No hard FK on template_id → after task_templates row is deleted, the version
  // history is preserved so restore-after-delete can still locate the snapshot.
  // The store layer is responsible for not letting a deleted-id template be
  // scheduled/rendered, but reads of historical versions remain valid.
  {
    const v89Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v89Row?.schema_version ?? 0) < 89) {
      try {
        database.exec(`
          CREATE TABLE IF NOT EXISTS template_versions (
            id TEXT PRIMARY KEY,
            template_id TEXT NOT NULL,
            version_no INTEGER NOT NULL,
            snapshot_json TEXT NOT NULL,
            reason TEXT NOT NULL,
            author TEXT,
            trace_id TEXT,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_template_versions_template_version
            ON template_versions(template_id, version_no);
          CREATE INDEX IF NOT EXISTS idx_template_versions_template_created
            ON template_versions(template_id, created_at);
        `);
        database.prepare("UPDATE server_state SET schema_version = 89 WHERE id = 1").run();
        console.info("[db migration v89] template_versions table created");
      } catch (err) {
        throw new Error(`Schema v89 migration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ===== Schema v90: beliefs(kind + prediction ledger columns) =====
  // Add a `kind` discriminator (behavior|prediction) so the same table holds both
  // stable behavior beliefs and falsifiable predictions, plus nullable prediction-
  // specific columns. Existing rows get kind='behavior' via DEFAULT. New columns
  // are added one-at-a-time with PRAGMA table_info guards (idempotent).
  {
    const v90Row = database.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number } | undefined;
    if ((v90Row?.schema_version ?? 0) < 90) {
      try {
        const existingCols = new Set(
          (database.prepare("PRAGMA table_info(beliefs)").all() as { name: string }[]).map(
            (c) => c.name,
          ),
        );
        const addCol = (name: string, decl: string) => {
          if (!existingCols.has(name)) {
            database.exec(`ALTER TABLE beliefs ADD COLUMN ${name} ${decl}`);
          }
        };
        addCol("kind", "TEXT NOT NULL DEFAULT 'behavior' CHECK(kind IN ('behavior','prediction'))");
        addCol("prediction_confidence", "REAL");
        addCol("falsify_condition", "TEXT");
        addCol("prediction_date", "TEXT");
        addCol(
          "settlement_status",
          "TEXT CHECK(settlement_status IS NULL OR settlement_status IN ('unsettled','confirmed','refuted','partial'))",
        );
        addCol("settled_at", "INTEGER");
        addCol("settled_outcome", "TEXT");
        database.exec(
          "CREATE INDEX IF NOT EXISTS idx_beliefs_kind ON beliefs(kind)",
        );
        database.prepare("UPDATE server_state SET schema_version = 90 WHERE id = 1").run();
        console.info("[db migration v90] beliefs kind + prediction columns added");
      } catch (err) {
        throw new Error(`Schema v90 migration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = process.env.ADAM_DB_PATH || DB_PATH;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Required for FTS5 content-sync triggers to work inside triggers.
  // Without this, SQLite blocks virtual table writes in triggers (since 3.31.0),
  // causing silent INSERT rollbacks on the memories table.
  db.pragma("trusted_schema = ON");

  runMigrations(db);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
