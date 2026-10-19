/**
 * Schema v83 migration tests: tasks.cost_breakdown column.
 *
 * Migration tests use a fresh DB (no pre-seeded tables other than server_state
 * and roles) so runMigrations() creates remaining tables itself. The preservation
 * test additionally pre-creates a minimal v82-shape `tasks` table and inserts a row
 * BEFORE runMigrations, proving the v83 ADD COLUMN preserves existing data.
 *
 * Round-trip tests use setupTestDb() + vi.mock to route createTask/getTask
 * through the in-memory test DB.
 */

import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";

// Set up test DB first (before vi.mock factory runs)
setupTestDb();

vi.mock(import("../../store/db.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getDb: () => getTestDb(),
    closeDb: () => {},
  };
});

// Imports that use getDb() must come AFTER vi.mock
import { createTask, getTask, updateTask } from "../../store/tasks.js";
import type { Task } from "../../shared/types.js";
import type { CostRecompute } from "../../lib/cost-pricing.js";
import { runMigrations } from "../../store/db.js";

// ─── Migration tests (fresh DB approach) ─────────────────────────────────────

/**
 * Create an in-memory DB at schema_version=82 with all tables that
 * version-unguarded migration blocks reference (roles, task_templates, etc.),
 * all carrying their v82-era columns so unguarded column-existence checks skip
 * the ALTER TABLE calls. runMigrations() then only needs to execute the v83
 * block (which adds cost_breakdown to tasks).
 *
 * `roles` is special: created only in the version-4-guarded block, so it must
 * be pre-seeded here (with all v82 columns) since v4 is skipped at schema 82.
 */
function freshDbAtV82(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("trusted_schema = ON");
  db.exec(`
    CREATE TABLE server_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      schema_version INTEGER DEFAULT 0,
      tools_fingerprint TEXT
    );
    INSERT INTO server_state (id, schema_version) VALUES (1, 82);

    -- roles: created only in v4 block (skipped at v82); must be pre-seeded
    -- with all columns added by unguarded blocks v13/v14/v15/v23/v24/v27 etc.
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

describe("Schema v83 migration — tasks.cost_breakdown", () => {
  it("migrates schema_version 82 -> 83 (fresh DB)", () => {
    const db = freshDbAtV82();
    runMigrations(db);

    const row = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(row.schema_version).toBe(90);
  });

  it("adds cost_breakdown column after migration", () => {
    const db = freshDbAtV82();
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === "cost_breakdown")).toBe(true);
  });

  it("preserves a PRE-EXISTING task row across the v83 ALTER (non-destructive)", () => {
    // Build the FULL tasks schema via runMigrations (a minimal hand-rolled table breaks
    // unguarded blocks that reference columns like template_id). Then simulate the pre-v83
    // state: drop the column, rewind schema_version to 82, and insert a row — so the second
    // runMigrations re-adds cost_breakdown against an already-populated table. This is the
    // plan-required v81-pattern preservation check: proving the v83 ADD COLUMN keeps user data.
    const db = freshDbAtV82();
    runMigrations(db); // full tasks table, reaches v83 with cost_breakdown

    db.exec("ALTER TABLE tasks DROP COLUMN cost_breakdown"); // SQLite >=3.35 (bundled)
    db.prepare("UPDATE server_state SET schema_version = 82 WHERE id = 1").run();
    db.prepare(
      `INSERT INTO tasks (id, status, prompt, config, created_at, retry_count)
       VALUES ('task-pre-v83', 'completed', 'pre-existing prompt', '{}', 999, 0)`
    ).run();

    runMigrations(db); // re-applies v83 ADD COLUMN against the populated table

    const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === "cost_breakdown")).toBe(true);
    const row = db.prepare(
      "SELECT id, prompt, cost_breakdown FROM tasks WHERE id = 'task-pre-v83'"
    ).get() as { id: string; prompt: string; cost_breakdown: string | null };
    expect(row.id).toBe("task-pre-v83");
    expect(row.prompt).toBe("pre-existing prompt"); // data intact across the ALTER
    expect(row.cost_breakdown).toBeNull();          // new column NULL for the pre-existing row
  });

  it("is idempotent: second runMigrations does not throw", () => {
    const db = freshDbAtV82();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    const row = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(row.schema_version).toBe(90);
  });

  it("no drift: test-db tasks columns ⊇ production tasks columns incl cost_breakdown", () => {
    const prodDb = freshDbAtV82();
    runMigrations(prodDb);

    const testDb = getTestDb();
    const prodCols = (prodDb.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>)
      .map(c => c.name)
      .sort();
    const testCols = (testDb.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>)
      .map(c => c.name)
      .sort();

    for (const col of prodCols) {
      expect(testCols, `test-db missing column: ${col}`).toContain(col);
    }
    expect(prodCols).toContain("cost_breakdown");
    expect(testCols).toContain("cost_breakdown");
  });

  // ─── Round-trip tests (via setupTestDb + vi.mock) ───────────────────────────

  it("round-trip: createTask with costBreakdown → getTask reads it back", () => {
    const breakdown: CostRecompute = {
      costUsd: 0.001234,
      perModel: [
        {
          model: "MiniMax-M2.7-highspeed",
          priced: true,
          estimated: false,
          inputTokens: 117,
          outputTokens: 334,
          cacheReadTokens: 20081,
          cacheCreationTokens: 9086,
          costUsd: 0.001234,
        },
      ],
      pricingStatus: "priced",
      unknownModels: [],
      sdkTotalCostUsd: 0.075763,
    };

    const task: Task = {
      id: "rt-task-1",
      status: "completed",
      prompt: "test",
      config: { workspacePath: "/tmp", timeout: 60, approvalRequired: [], approvalTimeout: 30 },
      createdAt: Date.now(),
      costUsd: 0.001234,
      costBreakdown: breakdown,
      retryCount: 0,
    };

    createTask(task);
    const loaded = getTask("rt-task-1");

    expect(loaded).toBeDefined();
    expect(loaded!.costBreakdown).toBeDefined();
    expect(loaded!.costBreakdown!.costUsd).toBeCloseTo(0.001234, 8);
    expect(loaded!.costBreakdown!.pricingStatus).toBe("priced");
    expect(loaded!.costBreakdown!.sdkTotalCostUsd).toBe(0.075763);
    expect(loaded!.costBreakdown!.perModel[0].model).toBe("MiniMax-M2.7-highspeed");
  });

  it("legacy row (no costBreakdown on create) → getTask returns costBreakdown=undefined", () => {
    const task: Task = {
      id: "legacy-task-1",
      status: "completed",
      prompt: "test",
      config: { workspacePath: "/tmp", timeout: 60, approvalRequired: [], approvalTimeout: 30 },
      createdAt: Date.now(),
      retryCount: 0,
    };

    createTask(task);
    const loaded = getTask("legacy-task-1");
    expect(loaded).toBeDefined();
    expect(loaded!.costBreakdown).toBeUndefined();
  });

  it("updateTask with costBreakdown → persists and reads back correctly", () => {
    const task: Task = {
      id: "update-task-1",
      status: "running",
      prompt: "test",
      config: { workspacePath: "/tmp", timeout: 60, approvalRequired: [], approvalTimeout: 30 },
      createdAt: Date.now(),
      retryCount: 0,
    };

    createTask(task);

    const breakdown: CostRecompute = {
      costUsd: 0.005,
      perModel: [],
      pricingStatus: "none",
      unknownModels: [],
    };

    updateTask("update-task-1", { status: "completed", costBreakdown: breakdown });

    const loaded = getTask("update-task-1");
    expect(loaded!.costBreakdown).toBeDefined();
    expect(loaded!.costBreakdown!.costUsd).toBe(0.005);
    expect(loaded!.costBreakdown!.pricingStatus).toBe("none");
  });
});
