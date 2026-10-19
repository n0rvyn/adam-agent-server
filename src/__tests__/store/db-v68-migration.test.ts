import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../store/db.js";

/** Minimum pre-v68 schema needed for migrations to run. */
function seedPreV68(db: Database.Database): void {
  db.exec(`
    CREATE TABLE server_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      schema_version INTEGER DEFAULT 67
    );
    INSERT INTO server_state (id, schema_version) VALUES (1, 67);

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
      skills TEXT
    );

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
      retrieved_count INTEGER DEFAULT 0,
      tier TEXT NOT NULL DEFAULT 'episodic',
      superseded_by TEXT
    );

    CREATE VIRTUAL TABLE memories_fts USING fts5(
      content,
      keywords,
      content='memories',
      content_rowid='rowid'
    );

    CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.rowid, new.content, new.keywords);
    END;
    CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES ('delete', old.rowid, old.content, old.keywords);
    END;
    CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES ('delete', old.rowid, old.content, old.keywords);
      INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.rowid, new.content, new.keywords);
    END;
  `);
}

describe("store/db v68 migration", () => {
  it("beliefs table has all expected columns", () => {
    const db = new Database(":memory:");
    db.pragma("trusted_schema = ON");
    seedPreV68(db);
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(beliefs)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    // Post-v81: confidence / use_count / success_count / trial_count / delta_sum / expires_at dropped (belief evolution v3 collapse).
    // Added: inject_count (DP-001/DP-002 for anti-flip touch count).
    // v90 (Belief Ledger): kind + 6 prediction-specific columns added.
    const expected = [
      "id", "role_id", "content",
      "is_anti", "evidence_obs_ids", "embedding", "superseded_by",
      "created_at", "last_used_at", "last_validated_at",
      "scope_key", "status", "success_ema", "inject_count",
      "kind", "prediction_confidence", "falsify_condition", "prediction_date",
      "settlement_status", "settled_at", "settled_outcome",
    ];
    for (const name of expected) {
      expect(colNames).toContain(name);
    }
    expect(colNames).toHaveLength(21);
  });

  it("memories.kind exists with observation default", () => {
    const db = new Database(":memory:");
    db.pragma("trusted_schema = ON");
    seedPreV68(db);
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "kind")).toBe(true);

    db.prepare(`
      INSERT INTO memories (id, role_id, type, content, importance, source_type, created_at, last_accessed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("m1", "r1", "event", "test content", 3, "agent_event", Date.now(), Date.now());

    const row = db.prepare("SELECT kind FROM memories WHERE id = 'm1'").get() as { kind: string };
    expect(row.kind).toBe("observation");
  });

  it("roles.last_reflection_at exists", () => {
    const db = new Database(":memory:");
    db.pragma("trusted_schema = ON");
    seedPreV68(db);
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "last_reflection_at")).toBe(true);
  });

  it("server_state.last_memory_gc_at exists", () => {
    const db = new Database(":memory:");
    db.pragma("trusted_schema = ON");
    seedPreV68(db);
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(server_state)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "last_memory_gc_at")).toBe(true);
  });

  it("beliefs FTS5 round-trip works under trusted_schema", () => {
    const db = new Database(":memory:");
    db.pragma("trusted_schema = ON");
    seedPreV68(db);
    runMigrations(db);

    // Post-v81 schema: no confidence/use_count/success_count columns
    db.prepare(`
      INSERT INTO beliefs (id, role_id, content,
        is_anti, evidence_obs_ids, created_at, last_used_at, last_validated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "b1", "r1",
      "TTS audio must pass an audibility check",
      0, "[]",
      Date.now(), Date.now(), Date.now(),
    );

    const rawCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM beliefs WHERE role_id = 'r1'"
    ).get() as { cnt: number };
    expect(rawCount.cnt).toBe(1);

    const ftsCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM beliefs_fts WHERE beliefs_fts MATCH 'audibility'"
    ).get() as { cnt: number };
    expect(ftsCount.cnt).toBeGreaterThanOrEqual(1);

    const version = db.prepare(
      "SELECT schema_version FROM server_state WHERE id = 1"
    ).get() as { schema_version: number };
    // initDatabase() applies every migration up to the latest version. Phase 2
    // shipped v69, so the version after init is ≥ 68. The intent of this
    // assertion is "v68 block ran", which is now better captured by the
    // structural assertions above (beliefs table exists + FTS5 round-trip works).
    expect(version.schema_version).toBeGreaterThanOrEqual(68);
  });
});
