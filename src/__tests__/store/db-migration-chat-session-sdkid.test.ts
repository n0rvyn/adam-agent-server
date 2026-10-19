/**
 * Schema v88 migration tests: chat_sessions.sdk_session_id column.
 *
 * Covers:
 * 1. Column is added after migration (fresh DB at v87).
 * 2. Pre-existing rows get NULL for the new column (non-destructive).
 * 3. updateSessionSdkId round-trip: write + read back via getSession.
 * 4. Existing rows without sdk_session_id → sdkSessionId=undefined.
 * 5. Idempotent: second runMigrations does not throw.
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

import { runMigrations } from "../../store/db.js";
import { updateSessionSdkId, createSession, getSession } from "../../store/sessions.js";
import type { ChatSession } from "../../shared/types.js";

// ─── Fresh DB helpers ─────────────────────────────────────────────────────────

/**
 * Build an in-memory DB with schema_version=87 and a minimal chat_sessions table
 * (without sdk_session_id) that has a pre-existing row.
 */
function freshDbAtV87WithRow(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("trusted_schema = ON");
  db.exec(`
    CREATE TABLE server_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      schema_version INTEGER DEFAULT 0,
      tools_fingerprint TEXT
    );
    INSERT INTO server_state (id, schema_version) VALUES (1, 87);

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

    -- chat_sessions at pre-v88 schema (no sdk_session_id column)
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

    -- Insert a pre-existing row before migration
    INSERT INTO chat_sessions (id, status, source_type, created_at, last_active_at)
    VALUES ('pre-existing-session', 'active', 'web', 1000000, 1000000);
  `);
  return db;
}

// ─── Migration tests ──────────────────────────────────────────────────────────

describe("Schema v88 migration — chat_sessions.sdk_session_id", () => {
  it("adds sdk_session_id column after migration", () => {
    const db = freshDbAtV87WithRow();
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(chat_sessions)").all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === "sdk_session_id")).toBe(true);
  });

  it("bumps schema_version to 88", () => {
    const db = freshDbAtV87WithRow();
    runMigrations(db);

    const row = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(row.schema_version).toBe(90);
  });

  it("preserves pre-existing rows with NULL sdk_session_id (non-destructive)", () => {
    const db = freshDbAtV87WithRow();
    runMigrations(db);

    const row = db.prepare(
      "SELECT id, sdk_session_id FROM chat_sessions WHERE id = 'pre-existing-session'"
    ).get() as { id: string; sdk_session_id: string | null };
    expect(row.id).toBe("pre-existing-session");
    expect(row.sdk_session_id).toBeNull();
  });

  it("is idempotent: second runMigrations does not throw", () => {
    const db = freshDbAtV87WithRow();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    const row = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(row.schema_version).toBe(90);
  });

  it("test-db chat_sessions includes sdk_session_id (schema drift guard)", () => {
    const testDb = getTestDb();
    const cols = (testDb.prepare("PRAGMA table_info(chat_sessions)").all() as Array<{ name: string }>)
      .map(c => c.name);
    expect(cols).toContain("sdk_session_id");
  });
});

// ─── Round-trip tests (via setupTestDb + vi.mock) ────────────────────────────

describe("updateSessionSdkId round-trip", () => {
  it("writes sdk_session_id and getSession reads it back as sdkSessionId", () => {
    const now = Date.now();
    const session: ChatSession = {
      id: `rt-sdkid-${now}`,
      status: "active",
      source: { type: "web" },
      createdAt: now,
      lastActiveAt: now,
      messageCount: 0,
    };

    createSession(session);
    updateSessionSdkId(session.id, "sdk-abc-123");
    const loaded = getSession(session.id);

    expect(loaded).toBeDefined();
    expect(loaded!.sdkSessionId).toBe("sdk-abc-123");
  });

  it("getSession returns sdkSessionId=undefined for rows without sdk_session_id set", () => {
    const now = Date.now();
    const session: ChatSession = {
      id: `rt-sdkid-null-${now}`,
      status: "active",
      source: { type: "web" },
      createdAt: now,
      lastActiveAt: now,
      messageCount: 0,
    };

    createSession(session);
    const loaded = getSession(session.id);

    expect(loaded).toBeDefined();
    expect(loaded!.sdkSessionId).toBeUndefined();
  });
});
