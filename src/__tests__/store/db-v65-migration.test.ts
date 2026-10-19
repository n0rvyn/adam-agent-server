import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

/** Builds a minimal v64 schema (no claim_source / no verdict_pair) in-memory */
function buildV64Schema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Minimal server_state (needed to gate migrations)
  db.exec(`CREATE TABLE IF NOT EXISTS server_state (id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`INSERT OR IGNORE INTO server_state (id, schema_version) VALUES ('1', 64)`);

  // Minimal assistant_claim_audits WITHOUT claim_source
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_claim_audits (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      session_id TEXT,
      message_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('passed','blocked')),
      per_claim_json TEXT NOT NULL DEFAULT '[]',
      replacement_text TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  // Minimal auditor_divergence_log WITHOUT verdict_pair, with one existing row
  db.exec(`
    CREATE TABLE IF NOT EXISTS auditor_divergence_log (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      session_id TEXT,
      message_id TEXT,
      task_id TEXT,
      wire_point TEXT NOT NULL,
      old_verdict TEXT NOT NULL,
      new_verdict TEXT NOT NULL,
      divergence_subtype TEXT NOT NULL,
      old_replacement_text TEXT,
      new_replacement_text TEXT,
      recorded_at INTEGER NOT NULL
    )
  `);

  // Minimal effect_receipts with 2 fixture rows (trace-foo / test-bar)
  db.exec(`
    CREATE TABLE IF NOT EXISTS effect_receipts (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      session_id TEXT,
      task_id TEXT,
      effect_category TEXT NOT NULL,
      verb TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      entity_ids_json TEXT,
      target_json TEXT,
      payload_json TEXT,
      scope_json TEXT,
      field_changes_json TEXT,
      outcome TEXT NOT NULL,
      text_chars INTEGER,
      attachment_count INTEGER,
      actor_json TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  // Seed 2 fixture rows (the Phase 4 test pollution)
  db.exec(`
    INSERT INTO effect_receipts (id, trace_id, effect_category, verb, entity_type, outcome, created_at)
    VALUES
      ('fixture-1', 'trace-foo', 'entity_mutation', 'create', 'role', 'success', 1700000000000),
      ('fixture-2', 'test-bar', 'outbound_message', 'send', 'channel', 'success', 1700000001000)
  `);

  // Seed one auditor_divergence_log row with divergence_subtype=old_blocks_new_passes
  db.exec(`
    INSERT INTO auditor_divergence_log
      (id, trace_id, wire_point, old_verdict, new_verdict, divergence_subtype, recorded_at)
    VALUES
      ('existing-div', 'trace-div-1', 'message_handler', 'blocked', 'passed', 'old_blocks_new_passes', 1700000002000)
  `);
}

/** Apply the same v65 migration logic as db.ts */
function applyV65(db: Database.Database): void {
  const colsClaim = db.prepare("PRAGMA table_info(assistant_claim_audits)").all() as Array<{ name: string }>;
  if (!colsClaim.some(c => c.name === "claim_source")) {
    db.prepare("ALTER TABLE assistant_claim_audits ADD COLUMN claim_source TEXT NOT NULL DEFAULT 'vacuous'").run();
  }
  const colsDiv = db.prepare("PRAGMA table_info(auditor_divergence_log)").all() as Array<{ name: string }>;
  if (!colsDiv.some(c => c.name === "verdict_pair")) {
    db.prepare("ALTER TABLE auditor_divergence_log ADD COLUMN verdict_pair TEXT NOT NULL DEFAULT 'agreed_pass'").run();
  }
  db.prepare(`
    UPDATE auditor_divergence_log
    SET verdict_pair = divergence_subtype
    WHERE verdict_pair IS NULL OR verdict_pair = 'agreed_pass'
      AND divergence_subtype IN ('old_blocks_new_passes', 'old_passes_new_blocks')
  `).run();
  db.prepare("DELETE FROM effect_receipts WHERE trace_id LIKE 'trace-%' OR trace_id LIKE 'test-%'").run();
  db.prepare("UPDATE server_state SET schema_version = 65 WHERE id = 1").run();
}

describe("db v65 migration", () => {
  it("migrates v64 → v65: adds claim_source + verdict_pair columns, cleans fixtures, backfills verdict_pair", () => {
    const db = new Database(":memory:");
    buildV64Schema(db);

    // Verify pre-migration state
    const preClaimSource = (db.prepare("PRAGMA table_info(assistant_claim_audits)").all() as Array<{ name: string }>).map(c => c.name);
    expect(preClaimSource).not.toContain("claim_source");

    const preVerdictPair = (db.prepare("PRAGMA table_info(auditor_divergence_log)").all() as Array<{ name: string }>).map(c => c.name);
    expect(preVerdictPair).not.toContain("verdict_pair");

    expect((db.prepare("SELECT COUNT(*) as cnt FROM effect_receipts WHERE trace_id LIKE 'trace-%' OR trace_id LIKE 'test-%'").get() as { cnt: number }).cnt).toBe(2);
    expect((db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number }).schema_version).toBe(64);

    applyV65(db);

    // Assert: claim_source column present
    const postClaimSource = (db.prepare("PRAGMA table_info(assistant_claim_audits)").all() as Array<{ name: string }>).map(c => c.name);
    expect(postClaimSource).toContain("claim_source");

    // Assert: verdict_pair column present
    const postVerdictPair = (db.prepare("PRAGMA table_info(auditor_divergence_log)").all() as Array<{ name: string }>).map(c => c.name);
    expect(postVerdictPair).toContain("verdict_pair");

    // Assert: no fixtures remain
    expect((db.prepare("SELECT COUNT(*) as cnt FROM effect_receipts WHERE trace_id LIKE 'trace-%' OR trace_id LIKE 'test-%'").get() as { cnt: number }).cnt).toBe(0);

    // Assert: schema version bumped
    expect((db.prepare("SELECT schema_version FROM server_state WHERE id = 1").get() as { schema_version: number }).schema_version).toBe(65);

    // Assert: existing divergence row backfilled correctly
    const backfillRow = db.prepare("SELECT verdict_pair, divergence_subtype FROM auditor_divergence_log WHERE id = 'existing-div'").get() as { verdict_pair: string; divergence_subtype: string };
    expect(backfillRow.verdict_pair).toBe("old_blocks_new_passes");
    expect(backfillRow.divergence_subtype).toBe("old_blocks_new_passes");

    db.close();
  });

  it("idempotent: re-running v65 is a no-op", () => {
    const db = new Database(":memory:");
    buildV64Schema(db);
    applyV65(db);
    applyV65(db);

    // claim_source should exist exactly once (not re-added)
    const claimSourceCount = (db.prepare("PRAGMA table_info(assistant_claim_audits)").all() as Array<{ name: string }>).filter(c => c.name === "claim_source").length;
    expect(claimSourceCount).toBe(1);

    const verdictPairCount = (db.prepare("PRAGMA table_info(auditor_divergence_log)").all() as Array<{ name: string }>).filter(c => c.name === "verdict_pair").length;
    expect(verdictPairCount).toBe(1);

    // Fixtures already gone
    expect((db.prepare("SELECT COUNT(*) as cnt FROM effect_receipts WHERE trace_id LIKE 'trace-%' OR trace_id LIKE 'test-%'").get() as { cnt: number }).cnt).toBe(0);

    db.close();
  });
});
