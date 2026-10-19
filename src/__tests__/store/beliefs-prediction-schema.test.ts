/**
 * beliefs v90 schema tests (kind + prediction columns).
 *
 * Pre-impl: tests FAIL because test-db.ts lacks the new columns.
 * Post-impl (Task 1-impl): all tests pass.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { createBelief, getBelief } from "../../store/beliefs.js";
import type { Belief } from "../../shared/types.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function getColumn(name: string): ColumnInfo {
  const cols = getTestDb()
    .prepare("PRAGMA table_info(beliefs)")
    .all() as ColumnInfo[];
  const col = cols.find((c) => c.name === name);
  if (!col) throw new Error(`column ${name} not found in beliefs`);
  return col;
}

describe("beliefs v90 — kind + prediction columns", () => {
  it("kind column exists with NOT NULL default 'behavior'", () => {
    const col = getColumn("kind");
    expect(col.notnull).toBe(1);
    expect(col.dflt_value).toBe("'behavior'");
  });

  it("prediction_confidence column exists (nullable)", () => {
    const col = getColumn("prediction_confidence");
    expect(col.notnull).toBe(0);
  });

  it("falsify_condition column exists (nullable)", () => {
    const col = getColumn("falsify_condition");
    expect(col.notnull).toBe(0);
  });

  it("prediction_date column exists (nullable)", () => {
    const col = getColumn("prediction_date");
    expect(col.notnull).toBe(0);
  });

  it("settlement_status column exists (nullable with CHECK)", () => {
    const col = getColumn("settlement_status");
    expect(col.notnull).toBe(0);
  });

  it("settled_at column exists (nullable)", () => {
    const col = getColumn("settled_at");
    expect(col.notnull).toBe(0);
  });

  it("settled_outcome column exists (nullable)", () => {
    const col = getColumn("settled_outcome");
    expect(col.notnull).toBe(0);
  });

  it("idx_beliefs_kind index exists", () => {
    const idx = getTestDb()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_beliefs_kind'",
      )
      .get();
    expect(idx).toBeTruthy();
  });

  it("insert behavior row without prediction columns succeeds and defaults kind='behavior'", () => {
    const now = Date.now();
    const belief: Belief = {
      id: "b-behavior",
      roleId: "r-behavior",
      content: "old behavior belief",
      isAnti: false,
      evidenceObsIds: [],
      createdAt: now,
      lastUsedAt: now,
      lastValidatedAt: now,
      status: "active",
      injectCount: 0,
    };
    expect(() => createBelief(belief)).not.toThrow();
    const row = getTestDb()
      .prepare("SELECT * FROM beliefs WHERE id = ?")
      .get("b-behavior") as Record<string, unknown>;
    expect(row.kind).toBe("behavior");
    expect(row.prediction_confidence).toBeNull();
    expect(row.settlement_status).toBeNull();
    expect(row.settled_at).toBeNull();
    expect(row.settled_outcome).toBeNull();
    // round-trip
    const fetched = getBelief("b-behavior");
    expect(fetched).toBeDefined();
    expect(fetched!.content).toBe("old behavior belief");
  });

  it("insert prediction row with confidence/falsify/date succeeds", () => {
    const now = Date.now();
    const belief: Belief = {
      id: "b-pred-1",
      roleId: "show-owner",
      content: "AI agents will be mainstream by end of 2026",
      isAnti: false,
      evidenceObsIds: [],
      createdAt: now,
      lastUsedAt: now,
      lastValidatedAt: now,
      status: "active",
      injectCount: 0,
      // v90 prediction fields (forwarded to DB columns)
      kind: "prediction",
      predictionConfidence: 0.6,
      falsifyCondition: "if no agent product reaches 1M DAU by 2026-12-31",
      predictionDate: "2026-06-04",
      settlementStatus: "unsettled",
    };
    expect(() => createBelief(belief)).not.toThrow();
    const row = getTestDb()
      .prepare("SELECT * FROM beliefs WHERE id = ?")
      .get("b-pred-1") as Record<string, unknown>;
    expect(row.kind).toBe("prediction");
    expect(row.prediction_confidence).toBe(0.6);
    expect(row.falsify_condition).toBe("if no agent product reaches 1M DAU by 2026-12-31");
    expect(row.prediction_date).toBe("2026-06-04");
    expect(row.settlement_status).toBe("unsettled");
  });

  it("CHECK constraint rejects invalid kind values", () => {
    const now = Date.now();
    expect(() => {
      getTestDb()
        .prepare(
          `INSERT INTO beliefs (id, role_id, content, is_anti, evidence_obs_ids,
            embedding, superseded_by, created_at, last_used_at, last_validated_at,
            scope_key, status, success_ema, inject_count, kind)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "bad-1",
          "r-bad",
          "x",
          0,
          null,
          null,
          null,
          now,
          now,
          now,
          null,
          "active",
          null,
          0,
          "nonsense",
        );
    }).toThrow(/CHECK/);
  });

  it("CHECK constraint rejects invalid settlement_status values", () => {
    const now = Date.now();
    expect(() => {
      getTestDb()
        .prepare(
          `INSERT INTO beliefs (id, role_id, content, is_anti, evidence_obs_ids,
            embedding, superseded_by, created_at, last_used_at, last_validated_at,
            scope_key, status, success_ema, inject_count, kind, settlement_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "bad-2",
          "r-bad2",
          "x",
          0,
          null,
          null,
          null,
          now,
          now,
          now,
          null,
          "active",
          null,
          0,
          "prediction",
          "nonsense",
        );
    }).toThrow(/CHECK/);
  });
});
