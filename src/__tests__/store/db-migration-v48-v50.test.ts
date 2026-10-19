import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../store/db.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.prepare(
    `CREATE TABLE IF NOT EXISTS server_state (
       id INTEGER PRIMARY KEY CHECK(id = 1),
       schema_version INTEGER DEFAULT 0
     )`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO server_state (id, schema_version) VALUES (1, 0)`,
  ).run();
});

afterEach(() => {
  db.close();
});

describe("db migrations v48-v50 (Chat envelope foundation)", () => {
  it("ux-017-chat-messages-new-columns-and-indexes: chat_messages gets 10 new columns + 3 indexes", () => {
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("kind");
    expect(names).toContain("parent_message_id");
    expect(names).toContain("thread_root");
    expect(names).toContain("prompt_id");
    expect(names).toContain("approval_shape");
    expect(names).toContain("role_id");
    expect(names).toContain("attachments");
    expect(names).toContain("mirrored_to_targets");
    expect(names).toContain("platform_message_id");
    expect(names).toContain("seq");

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='chat_messages'").all() as Array<{ name: string }>;
    const idxNames = indexes.map((i) => i.name);
    expect(idxNames).toContain("idx_chat_messages_thread_root");
    expect(idxNames).toContain("idx_chat_messages_prompt_id");
    expect(idxNames).toContain("idx_chat_messages_platform_msg");
  });

  it("ux-001-kind-backfill-by-role: existing rows back-filled with kind based on role", () => {
    runMigrations(db);
    // Seed a chat_sessions row so the chat_messages FK on session_id is satisfied.
    db.prepare(
      `INSERT INTO chat_sessions (id, status, source_type, created_at, last_active_at, message_count)
       VALUES ('s1', 'active', 'web', 1000, 1000, 0)`,
    ).run();
    db.prepare("UPDATE chat_messages SET kind = NULL").run();
    db.prepare(`INSERT INTO chat_messages (id, session_id, role, content, source_type, created_at, kind) VALUES ('m-user', 's1', 'user', 'hi', 'web', 1000, NULL)`).run();
    db.prepare(`INSERT INTO chat_messages (id, session_id, role, content, source_type, created_at, kind) VALUES ('m-bot', 's1', 'assistant', 'hello', 'web', 1001, NULL)`).run();

    db.prepare("UPDATE server_state SET schema_version = 47 WHERE id = 1").run();
    runMigrations(db);

    const userRow = db.prepare("SELECT kind FROM chat_messages WHERE id = 'm-user'").get() as { kind: string };
    const botRow = db.prepare("SELECT kind FROM chat_messages WHERE id = 'm-bot'").get() as { kind: string };
    expect(userRow.kind).toBe("user_message");
    expect(botRow.kind).toBe("assistant_text");
  });

  it("v49: pending_prompts table + 2 indexes created", () => {
    runMigrations(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_prompts'").all();
    expect(tables).toHaveLength(1);

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pending_prompts'").all() as Array<{ name: string }>;
    const idxNames = indexes.map((i) => i.name);
    expect(idxNames).toContain("idx_pending_prompts_session_open");
    expect(idxNames).toContain("idx_pending_prompts_task");
  });

  it("v50: template_execution_artifacts (renamed to artifacts in v72) gets 8 new columns (no duplicate original_filename)", () => {
    runMigrations(db);
    // Post-v72 the table is renamed to `artifacts`; the v50 columns are preserved verbatim.
    const cols = db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("locator");
    expect(names).toContain("content_hash");
    expect(names).toContain("retention_hint");
    expect(names).toContain("encryption_class");
    expect(names).toContain("purpose");
    expect(names).toContain("replaces");
    expect(names).toContain("produced_by_role");
    expect(names).toContain("access");

    expect(names.filter((n) => n === "original_filename")).toHaveLength(1);
  });

  it("migrations are idempotent — second run does not double-add columns or fail", () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();

    const ver = db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number };
    expect(ver.schema_version).toBeGreaterThanOrEqual(50);
  });
});
