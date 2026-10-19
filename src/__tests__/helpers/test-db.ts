import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

let testDb: BetterSqlite3.Database;

/**
 * Creates an in-memory SQLite database with the same schema as production.
 * Call this in beforeAll() and use the returned cleanup function in afterAll().
 */
export function setupTestDb(): { db: BetterSqlite3.Database; cleanup: () => void } {
  const ownsRuntimeDir = !process.env.ADAM_TEST_DIR;
  const runtimeDir = process.env.ADAM_TEST_DIR
    ?? mkdtempSync(join(tmpdir(), "adam-test-runtime-"));
  if (ownsRuntimeDir) {
    process.env.ADAM_TEST_DIR = runtimeDir;
  }

  testDb = new Database(":memory:");
  testDb.pragma("journal_mode = WAL");
  testDb.pragma("foreign_keys = ON");

  testDb.exec(`
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
      context_meta TEXT,
      cost_breakdown TEXT
    );

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
      plan_step_index INTEGER,
      trace_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_step_logs_task_index
      ON step_logs (task_id, "index");
    CREATE INDEX IF NOT EXISTS idx_step_logs_trace_id ON step_logs(trace_id) WHERE trace_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_template_id ON tasks(template_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_role_id ON tasks(role_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_trace_id ON tasks(trace_id) WHERE trace_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS evolution_audit (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      old_rules TEXT,
      new_rules TEXT,
      diff TEXT,
      trigger_task_id TEXT,
      role_id TEXT,
      source TEXT DEFAULT 'reflection',
      trace_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_audit_trace_id ON evolution_audit(trace_id) WHERE trace_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS mistake_patterns (
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
    );

    CREATE INDEX IF NOT EXISTS idx_mistake_patterns_status ON mistake_patterns(status);
    CREATE INDEX IF NOT EXISTS idx_mistake_patterns_last_seen ON mistake_patterns(last_seen);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mistake_patterns_dim ON mistake_patterns(dimension_type, dimension_value);

    CREATE TABLE IF NOT EXISTS server_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      sdk_session_id TEXT,
      user_task_session_id TEXT,
      workspace_path TEXT,
      schema_version INTEGER DEFAULT 72,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER,
      last_memory_gc_at INTEGER
    );

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
      retrieved_count INTEGER DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'observation',
      tier TEXT NOT NULL DEFAULT 'episodic',
      superseded_by TEXT
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_thought_per_task
      ON memories(source_task_id)
      WHERE source_task_id IS NOT NULL AND type = 'thought';

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
      source_session_id TEXT,
      notify_targets TEXT,
      deliver_to TEXT,
      report_to TEXT
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
      report_to TEXT,
      goal_ids TEXT,
      is_preset INTEGER NOT NULL DEFAULT 0,
      preset_id TEXT,
      retry_policy TEXT
    );

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

    CREATE TABLE IF NOT EXISTS template_executions (
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
    );
    CREATE INDEX IF NOT EXISTS idx_template_executions_event_id ON template_executions(event_id);

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
      priority INTEGER,
      artifact_role TEXT,
      CHECK (
        (source_kind = 'template_step' AND execution_id IS NOT NULL AND task_id IS NULL AND chat_session_id IS NULL AND step_id IS NOT NULL)
        OR (source_kind = 'task_published' AND task_id IS NOT NULL AND execution_id IS NULL AND chat_session_id IS NULL)
        OR (source_kind = 'chat_sent' AND chat_session_id IS NOT NULL AND task_id IS NULL AND execution_id IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_execution_id ON artifacts(execution_id) WHERE execution_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_artifacts_task_id ON artifacts(task_id) WHERE task_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_artifacts_chat_session_id ON artifacts(chat_session_id) WHERE chat_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_artifacts_role_id ON artifacts(role_id) WHERE role_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_source_kind ON artifacts(source_kind);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_template_step_key ON artifacts(execution_id, step_id, key) WHERE source_kind = 'template_step';
    CREATE INDEX IF NOT EXISTS idx_artifacts_replaces ON artifacts(replaces) WHERE replaces IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_artifacts_content_hash ON artifacts(content_hash) WHERE content_hash IS NOT NULL;

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
    );

    CREATE INDEX IF NOT EXISTS idx_pending_prompts_session_open
      ON pending_prompts(session_id, expires_at) WHERE resolved_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_pending_prompts_task
      ON pending_prompts(task_id) WHERE task_id IS NOT NULL;

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
      ON artifact_access_log(execution_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_artifact_access_log_role
      ON artifact_access_log(role_id, timestamp);

    CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL DEFAULT 'config',
      enabled INTEGER NOT NULL DEFAULT 1,
      description TEXT,
      config TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_plugins_source ON plugins(source);
    CREATE INDEX IF NOT EXISTS idx_plugins_enabled ON plugins(enabled);

    CREATE TABLE IF NOT EXISTS marketplaces (
      name TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      added_at INTEGER NOT NULL
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

    -- v68+v81+v90: beliefs table + FTS5 mirror (v81: three-state collapse + task_seq clock + inject_count + no belief_scopes; v90: kind discriminator + prediction columns)
    CREATE TABLE IF NOT EXISTS beliefs (
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
      inject_count INTEGER NOT NULL DEFAULT 0,
      -- v90: prediction ledger columns
      kind TEXT NOT NULL DEFAULT 'behavior' CHECK(kind IN ('behavior','prediction')),
      prediction_confidence REAL,
      falsify_condition TEXT,
      prediction_date TEXT,
      settlement_status TEXT CHECK(settlement_status IS NULL OR settlement_status IN ('unsettled','confirmed','refuted','partial')),
      settled_at INTEGER,
      settled_outcome TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_beliefs_role ON beliefs(role_id);
    CREATE INDEX IF NOT EXISTS idx_beliefs_last_used ON beliefs(last_used_at);
    CREATE INDEX IF NOT EXISTS idx_beliefs_status ON beliefs(status);
    CREATE INDEX IF NOT EXISTS idx_beliefs_scope ON beliefs(scope_key);
    CREATE INDEX IF NOT EXISTS idx_beliefs_kind ON beliefs(kind);

    CREATE TABLE IF NOT EXISTS user_feedback (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      step_id TEXT,
      rating TEXT NOT NULL CHECK(rating IN ('good','bad')),
      created_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS beliefs_fts USING fts5(content, content='beliefs', content_rowid='rowid');

    CREATE TRIGGER IF NOT EXISTS beliefs_fts_insert AFTER INSERT ON beliefs BEGIN
      INSERT INTO beliefs_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS beliefs_fts_delete AFTER DELETE ON beliefs BEGIN
      INSERT INTO beliefs_fts(beliefs_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS beliefs_fts_update AFTER UPDATE ON beliefs BEGIN
      INSERT INTO beliefs_fts(beliefs_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO beliefs_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    -- Chat & Channels tables

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
      message_count INTEGER DEFAULT 0,
      sdk_session_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_status ON chat_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON chat_sessions(last_active_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_source ON chat_sessions(source_type, source_channel_id, source_chat_id);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      source_type TEXT NOT NULL,
      task_id TEXT,
      channel_message_id TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      trace_id TEXT,
      kind TEXT,
      parent_message_id TEXT,
      thread_root TEXT,
      prompt_id TEXT,
      approval_shape TEXT,
      role_id TEXT,
      attachments TEXT,
      mirrored_to_targets TEXT,
      platform_message_id TEXT,
      seq INTEGER,
      source_channel_id TEXT,
      source_chat_id TEXT,
      cost_usd REAL,
      token_usage TEXT,
      model TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_task ON chat_messages(task_id);
    CREATE INDEX IF NOT EXISTS idx_messages_trace_id ON chat_messages(trace_id) WHERE trace_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_root ON chat_messages(thread_root, created_at) WHERE thread_root IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_messages_prompt_id ON chat_messages(prompt_id) WHERE prompt_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_messages_platform_msg ON chat_messages(platform_message_id) WHERE platform_message_id IS NOT NULL;

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
      message_count INTEGER DEFAULT 0,
      recipient_cap_map_json TEXT,
      default_recipient_cap_bytes INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_channels_platform ON channels(platform);
    CREATE INDEX IF NOT EXISTS idx_channels_enabled ON channels(enabled);
    CREATE INDEX IF NOT EXISTS idx_channels_linked_role_id ON channels(linked_role_id);

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

    CREATE TABLE IF NOT EXISTS effect_receipts (
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
      outcome TEXT NOT NULL DEFAULT 'success' CHECK(outcome IN ('success','failure')),
      created_at INTEGER NOT NULL,
      CHECK ((entity_id IS NULL) OR (entity_ids_json IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_effect_receipts_trace
      ON effect_receipts(trace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_effect_receipts_task
      ON effect_receipts(task_id, created_at) WHERE task_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_effect_receipts_entity
      ON effect_receipts(entity_type, entity_id) WHERE entity_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_effect_receipts_category_verb
      ON effect_receipts(effect_category, verb);
    CREATE INDEX IF NOT EXISTS idx_effect_receipts_outcome
      ON effect_receipts(effect_category, outcome, trace_id);

    -- Phase 3: assistant_claims (one row per commit_claim call)
    CREATE TABLE IF NOT EXISTS assistant_claims (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      session_id TEXT,
      task_id TEXT,
      source_message_id TEXT,
      claims_json TEXT NOT NULL,
      declared_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_claims_trace
      ON assistant_claims(trace_id, declared_at);
    CREATE INDEX IF NOT EXISTS idx_assistant_claims_session
      ON assistant_claims(session_id, declared_at) WHERE session_id IS NOT NULL;

    -- Phase 3: assistant_claim_audits (one row per auditClaimsForTurn invocation)
    CREATE TABLE IF NOT EXISTS assistant_claim_audits (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      session_id TEXT,
      message_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('passed','blocked')),
      per_claim_json TEXT NOT NULL DEFAULT '[]',
      replacement_text TEXT,
      created_at INTEGER NOT NULL,
      claim_source TEXT NOT NULL DEFAULT 'vacuous'
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_claim_audits_trace
      ON assistant_claim_audits(trace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_assistant_claim_audits_session
      ON assistant_claim_audits(session_id, created_at) WHERE session_id IS NOT NULL;

    -- Phase 5: auditor_divergence_log
    CREATE TABLE IF NOT EXISTS auditor_divergence_log (
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
      recorded_at INTEGER NOT NULL,
      verdict_pair TEXT NOT NULL DEFAULT 'agreed_pass'
    );
    CREATE INDEX IF NOT EXISTS idx_auditor_divergence_trace ON auditor_divergence_log(trace_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_auditor_divergence_subtype ON auditor_divergence_log(divergence_subtype, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_auditor_divergence_session ON auditor_divergence_log(session_id, recorded_at) WHERE session_id IS NOT NULL;

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

    -- Phase 3: Plan-Approve-Execute-Review-Learn

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

    -- Phase 5: Monitor agent scores

    CREATE TABLE IF NOT EXISTS role_scores (
      id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      task_type TEXT,
      score_json TEXT NOT NULL,
      ema_score REAL NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_role_scores_role_id ON role_scores(role_id);

    -- Phase 6: Manager decision audit

    CREATE TABLE IF NOT EXISTS manager_decisions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      role_id TEXT,
      decision_type TEXT NOT NULL,
      boundary_json TEXT,
      reason TEXT,
      requirements_json TEXT,
      fit_score REAL,
      candidates_json TEXT,
      tie_break_reason TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_manager_decisions_task_id ON manager_decisions(task_id);
    CREATE INDEX IF NOT EXISTS idx_manager_decisions_role_id ON manager_decisions(role_id);

    -- Delivery Rules

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
      rule_id TEXT REFERENCES delivery_rules(id),
      task_id TEXT,
      execution_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'failed', 'expired')),
      target TEXT NOT NULL,
      content TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      expires_at INTEGER NOT NULL,
      source TEXT,
      message_type TEXT,
      trace_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_delivery_log_status ON delivery_log(status);
    CREATE INDEX IF NOT EXISTS idx_delivery_log_expires ON delivery_log(expires_at);
    CREATE INDEX IF NOT EXISTS idx_delivery_log_rule_id ON delivery_log(rule_id);
    CREATE INDEX IF NOT EXISTS idx_delivery_log_trace_id ON delivery_log(trace_id) WHERE trace_id IS NOT NULL;

    -- Schema v32: event_defs + events (Event Slot)

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

    -- Schema v76: task_files table (workspace snapshot inventory)
    CREATE TABLE IF NOT EXISTS task_files (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      op TEXT NOT NULL CHECK(op IN ('added','modified','deleted')),
      mtime_ns INTEGER,
      size_bytes INTEGER,
      inode INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_files_task_id ON task_files(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_files_path ON task_files(path);

    -- Schema v77: editor_scores table (podcast Phase 2 retrospective)
    CREATE TABLE IF NOT EXISTS editor_scores (
      id TEXT PRIMARY KEY,
      template_run_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      scores TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0,
      editor_notes TEXT,
      brief_diff TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_editor_scores_template_run_id ON editor_scores(template_run_id);
    CREATE INDEX IF NOT EXISTS idx_editor_scores_created_at ON editor_scores(created_at);

    -- Schema v84: llm_costs table (unified LLM cost store)
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

  testDb.exec(`
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

    -- Schema v37: feature_requests table
    CREATE TABLE IF NOT EXISTS feature_requests (
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
    );
    CREATE INDEX IF NOT EXISTS idx_feature_requests_status ON feature_requests(status);
    CREATE INDEX IF NOT EXISTS idx_feature_requests_extracted_at ON feature_requests(extracted_at DESC);

    -- Schema v4+v10: Role entity with absorbed Skill fields

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
      permission_mode TEXT,
      allowed_bash_patterns TEXT,
      denied_bash_patterns TEXT,
      env_vars TEXT,
      os_capabilities TEXT,
      preset_id TEXT,
      effort_tier TEXT,
      skills TEXT,
      last_reflection_at INTEGER,
      memory_budget_tokens INTEGER,
      task_seq INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_roles_status ON roles(status);
    CREATE INDEX IF NOT EXISTS idx_roles_name ON roles(name);

    CREATE TABLE IF NOT EXISTS delayed_retries (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      retry_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delayed_retries_retry_at ON delayed_retries(retry_at);
    CREATE INDEX IF NOT EXISTS idx_delayed_retries_task_id ON delayed_retries(task_id);

    -- Schema v52: audit_violations (Phase 2 contract verifier)
    CREATE TABLE IF NOT EXISTS audit_violations (
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
    );
    CREATE INDEX IF NOT EXISTS idx_audit_violations_role ON audit_violations(role_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_violations_task ON audit_violations(step_task_id);
    CREATE INDEX IF NOT EXISTS idx_audit_violations_execution ON audit_violations(execution_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS chat_tool_calls (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      session_id TEXT,
      tool_name TEXT NOT NULL,
      tool_input_json TEXT,
      tool_output_summary TEXT,
      called_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_tool_calls_trace ON chat_tool_calls(trace_id, called_at);
    CREATE INDEX IF NOT EXISTS idx_chat_tool_calls_session ON chat_tool_calls(session_id, called_at) WHERE session_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS extensions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      version TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      install_source TEXT NOT NULL DEFAULT 'upload',
      package_hash TEXT NOT NULL,
      default_config_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_extensions_name ON extensions(name);

    CREATE TABLE IF NOT EXISTS role_extensions (
      id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_override_json TEXT,
      generated_server_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(role_id, extension_id)
    );
    CREATE INDEX IF NOT EXISTS idx_role_extensions_role_id ON role_extensions(role_id);
    CREATE INDEX IF NOT EXISTS idx_role_extensions_extension_id ON role_extensions(extension_id);

    CREATE TABLE IF NOT EXISTS extension_health (
      extension_id TEXT PRIMARY KEY REFERENCES extensions(id) ON DELETE CASCADE,
      last_run_at INTEGER,
      last_status TEXT,
      last_error TEXT,
      last_role_id TEXT,
      last_task_id TEXT
    );
  `);

  return {
    db: testDb,
    cleanup: () => {
      testDb.close();
      if (ownsRuntimeDir) {
        if (process.env.ADAM_TEST_DIR === runtimeDir) {
          delete process.env.ADAM_TEST_DIR;
        }
        rmSync(runtimeDir, { recursive: true, force: true });
      }
    },
  };
}

/** Clear all data but keep schema intact. Defensive: skips tables whose schema was already dropped by a sibling test's cleanup(). */
export function clearTestDb(): void {
  const tables = [
    "feature_requests", "task_plugins", "chat_messages", "chat_sessions",
    "channels", "user_visible_events", "audit_diagnostics",
    "assistant_commitment_audits", "assistant_delivery_commitments",
    "runtime_effects", "effect_receipts", "assistant_claims",
    "assistant_claim_audits", "auditor_divergence_log", "trials", "strategies", "metric_tree",
    "goals", "step_logs", "delivery_log", "delivery_rules",
    "calibration_history", "manager_decisions", "role_scores",
    "task_files", "editor_scores", "delayed_retries", "approval_rules", "task_plans", "tasks",
    "config", "evolution_audit", "audit_violations", "server_state",
    "memories", "beliefs", "user_feedback", "roles", "template_executions", "chat_tool_calls",
    "artifacts", "artifact_access_log",
    "template_execution_step_results",
    "template_executions", "task_templates", "pending_prompts",
    "plugins", "marketplaces", "task_plugins",
    "extension_health", "role_extensions", "extensions",
    "llm_costs",
  ];
  const clear = (name: string) => { try { testDb.exec("DELETE FROM " + name); } catch { /* dropped */ } };
  tables.forEach(clear);
}

/** Returns the current test database instance. */
export function getTestDb(): BetterSqlite3.Database {
  return testDb;
}
