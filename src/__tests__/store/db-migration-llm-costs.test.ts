/**
 * Schema v84 migration tests: llm_costs table + DP-001=A backfill.
 *
 * Tests run against the REAL runMigrations() from store/db.ts.
 * Pre-impl: all tests FAIL because runMigrations only reaches v83
 * (no llm_costs table, no v84 block).
 * Post-impl (Task 1-impl): all tests pass.
 *
 * The backfill test seeds a tasks row with cost_usd + cost_breakdown
 * BEFORE running migrations, then asserts that the v84 backfill
 * inserted a matching llm_costs row.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../store/db.js";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";

// Initialize test DB for drift checks (test-db vs prod schema)
setupTestDb();

/**
 * Build an in-memory DB at schema_version=83 with all tables that
 * unguarded migration blocks reference, all pre-seeded with v83-era columns.
 * runMigrations() will only need to execute the v84 (and v85) blocks.
 *
 * The `tasks` table is pre-seeded with cost_breakdown already present
 * (that was the v83 migration).
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

    -- roles: created only in v4 block (skipped at v83); must be pre-seeded
    -- with all columns added by unguarded blocks up through v83.
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

// ─── Migration tests ─────────────────────────────────────────────────────────

describe("Schema v84 migration — llm_costs table + DP-001 backfill", () => {
  it("migrates schema_version 83 -> 85 (fresh DB)", () => {
    const db = freshDbAtV83();
    runMigrations(db);

    const row = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(row.schema_version).toBe(90);
  });

  it("llm_costs table exists after v84 migration", () => {
    const db = freshDbAtV83();
    runMigrations(db);

    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'llm_costs'"
    ).get() as { name: string } | undefined;
    expect(table).toBeDefined();
    expect(table!.name).toBe("llm_costs");
  });

  it("llm_costs table has all 18 required columns", () => {
    const db = freshDbAtV83();
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(llm_costs)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);

    const expected = [
      "id",
      "call_id",
      "source",
      "model",
      "role_id",
      "task_id",
      "session_id",
      "message_id",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_creation_tokens",
      "cost_usd",
      "priced",
      "estimated",
      "sdk_total_cost_usd",
      "num_turns",
      "created_at",
    ];

    for (const col of expected) {
      expect(names, `llm_costs missing column: ${col}`).toContain(col);
    }
    expect(names).toHaveLength(18);
  });

  it("llm_costs table has 4 required indices", () => {
    const db = freshDbAtV83();
    runMigrations(db);

    const indices = db.prepare("PRAGMA index_list(llm_costs)").all() as Array<{ name: string }>;
    const indexNames = indices.map((i) => i.name);

    expect(indexNames).toContain("idx_llm_costs_created");
    expect(indexNames).toContain("idx_llm_costs_source");
    expect(indexNames).toContain("idx_llm_costs_model");
    expect(indexNames).toContain("idx_llm_costs_role");
  });

  it("DP-001=A backfill: existing task with cost_breakdown inserts per-model llm_costs rows", () => {
    // Build a full schema first, then rewind to v83 and insert a task row
    // (simulating a pre-existing task before v84 migration runs)
    const db = freshDbAtV83();
    runMigrations(db); // runs v84+v85 — creates tasks and all tables

    // Now rewind schema_version to 83 to simulate a pre-existing tasks row
    // before the v84 backfill runs
    db.prepare("UPDATE server_state SET schema_version = 83 WHERE id = 1").run();

    // Drop the llm_costs table so we can test backfill from scratch
    db.exec("DROP TABLE IF EXISTS llm_costs");

    // Insert a task row with cost_usd + cost_breakdown
    const breakdown = JSON.stringify({
      perModel: [
        {
          model: "claude-sonnet-4-6",
          priced: true,
          estimated: false,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.05,
        },
      ],
      pricingStatus: "priced",
      costUsd: 0.05,
      unknownModels: [],
      sdkTotalCostUsd: 0.05,
    });

    db.prepare(
      `INSERT INTO tasks (id, status, prompt, config, created_at, retry_count, cost_usd, cost_breakdown)
       VALUES ('backfill-task-1', 'completed', 'test prompt', '{}', ${Date.now()}, 0, 0.05, ?)`
    ).run(breakdown);

    // Re-run migrations — v84 fires again and backfills llm_costs
    runMigrations(db);

    const rows = db.prepare(
      "SELECT * FROM llm_costs WHERE task_id = 'backfill-task-1'"
    ).all() as Array<{
      source: string;
      task_id: string;
      cost_usd: number;
      model: string;
      priced: number;
      call_id: string;
    }>;

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect(row.source).toBe("task");
    expect(row.task_id).toBe("backfill-task-1");
    expect(row.cost_usd).toBeCloseTo(0.05, 6);
    expect(row.model).toBe("claude-sonnet-4-6");
    expect(row.priced).toBe(1);
    expect(row.call_id).toContain("backfill-");
  });

  it("DP-001=A backfill: task without cost_breakdown inserts single fallback row", () => {
    const db = freshDbAtV83();
    runMigrations(db);

    db.prepare("UPDATE server_state SET schema_version = 83 WHERE id = 1").run();
    db.exec("DROP TABLE IF EXISTS llm_costs");

    // Task with cost_usd but NO cost_breakdown
    db.prepare(
      `INSERT INTO tasks (id, status, prompt, config, created_at, retry_count, cost_usd)
       VALUES ('backfill-task-2', 'completed', 'test prompt 2', '{}', ${Date.now()}, 0, 0.10)`
    ).run();

    runMigrations(db);

    const rows = db.prepare(
      "SELECT * FROM llm_costs WHERE task_id = 'backfill-task-2'"
    ).all() as Array<{
      source: string;
      task_id: string;
      cost_usd: number;
      model: string;
      priced: number;
    }>;

    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("task");
    expect(rows[0].model).toBe("unknown");
    expect(rows[0].cost_usd).toBeCloseTo(0.10, 6);
    // Non-zero stored cost was a KNOWN cost even if model is now unrecoverable
    expect(rows[0].priced).toBe(1);
  });

  it("backfill does NOT insert for tasks with cost_usd IS NULL", () => {
    const db = freshDbAtV83();
    runMigrations(db);

    db.prepare("UPDATE server_state SET schema_version = 83 WHERE id = 1").run();
    db.exec("DROP TABLE IF EXISTS llm_costs");

    // Task with NULL cost_usd — should be skipped
    db.prepare(
      `INSERT INTO tasks (id, status, prompt, config, created_at, retry_count)
       VALUES ('no-cost-task', 'completed', 'test', '{}', ${Date.now()}, 0)`
    ).run();

    runMigrations(db);

    const count = (db.prepare(
      "SELECT COUNT(*) AS cnt FROM llm_costs WHERE task_id = 'no-cost-task'"
    ).get() as { cnt: number }).cnt;

    expect(count).toBe(0);
  });

  it("is idempotent: second runMigrations does not throw or double-insert", () => {
    const db = freshDbAtV83();
    runMigrations(db);

    // Insert a task that would be backfilled
    db.prepare("UPDATE server_state SET schema_version = 83 WHERE id = 1").run();
    db.exec("DROP TABLE IF EXISTS llm_costs");
    db.prepare(
      `INSERT INTO tasks (id, status, prompt, config, created_at, retry_count, cost_usd)
       VALUES ('idempotent-task', 'completed', 'test', '{}', ${Date.now()}, 0, 0.02)`
    ).run();

    runMigrations(db); // first run — creates llm_costs + backfills
    const countAfterFirst = (db.prepare(
      "SELECT COUNT(*) AS cnt FROM llm_costs WHERE task_id = 'idempotent-task'"
    ).get() as { cnt: number }).cnt;

    // Second run — should NOT throw; schema_version guard prevents re-backfill
    expect(() => runMigrations(db)).not.toThrow();
    const countAfterSecond = (db.prepare(
      "SELECT COUNT(*) AS cnt FROM llm_costs WHERE task_id = 'idempotent-task'"
    ).get() as { cnt: number }).cnt;

    expect(countAfterFirst).toBeGreaterThanOrEqual(1);
    expect(countAfterSecond).toBe(countAfterFirst); // no double-insert
  });

  it("no drift: test-db schema includes llm_costs table with all required columns", () => {
    const prodDb = freshDbAtV83();
    runMigrations(prodDb);

    const testDb = getTestDb();

    // Verify test-db has the llm_costs table
    const testTable = testDb.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'llm_costs'"
    ).get() as { name: string } | undefined;

    expect(testTable, "test-db missing llm_costs table").toBeDefined();

    // Verify column alignment
    const prodCols = (prodDb.prepare("PRAGMA table_info(llm_costs)").all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();
    const testCols = (testDb.prepare("PRAGMA table_info(llm_costs)").all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();

    for (const col of prodCols) {
      expect(testCols, `test-db missing column: ${col}`).toContain(col);
    }
  });
});
