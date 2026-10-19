/**
 * Mistake patterns CRUD store.
 *
 * Stores cross-role mistake patterns produced by the mistake aggregator.
 * Terminal store (Phase 4 scope): no event emission, no delivery_rules hook.
 */

import { getDb } from "./db.js";
import type { MistakePattern, MistakePatternStatus, MistakeDimensionType } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Evidence ID shape
// ---------------------------------------------------------------------------

type EvidenceSource = "evolution_audit" | "role_scores" | "delivery_log";

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

interface MistakePatternRow {
  id: string;
  dimension_type: string;
  dimension_value: string;
  count: number;
  role_ids: string;
  sample_evidence_ids: string;
  status: string;
  first_seen: number;
  last_seen: number;
  created_at: number;
  updated_at: number;
}

function rowToMistakePattern(row: MistakePatternRow): MistakePattern {
  return {
    id: row.id,
    dimensionType: row.dimension_type as MistakeDimensionType,
    dimensionValue: row.dimension_value,
    count: row.count,
    roleIds: JSON.parse(row.role_ids),
    sampleEvidenceIds: JSON.parse(row.sample_evidence_ids),
    status: row.status as MistakePatternStatus,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Parameterized statements
// ---------------------------------------------------------------------------

const INSERT_STMT = `
  INSERT INTO mistake_patterns
    (id, dimension_type, dimension_value, count, role_ids, sample_evidence_ids,
     status, first_seen, last_seen, created_at, updated_at)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`.trim();

const UPDATE_STATUS_STMT = `
  UPDATE mistake_patterns SET status = ?, updated_at = ? WHERE id = ?
`.trim();

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Creates a new mistake pattern (insert only — use upsertMistakePattern for dedup).
 */
export function createMistakePattern(pattern: MistakePattern): void {
  const db = getDb();
  db.prepare(INSERT_STMT).run(
    pattern.id,
    pattern.dimensionType,
    pattern.dimensionValue,
    pattern.count,
    JSON.stringify(pattern.roleIds),
    JSON.stringify(pattern.sampleEvidenceIds),
    pattern.status,
    pattern.firstSeen,
    pattern.lastSeen,
    pattern.createdAt,
    pattern.updatedAt,
  );
}

/**
 * Upserts a mistake pattern by (dimension_type, dimension_value) bucket.
 *
 * - On new bucket: inserts with count=1.
 * - On existing bucket: increments count, merges role_ids as a set (no duplicates),
 *   merges sample_evidence_ids (cap at 10 most-recent, DP-4.9), updates last_seen.
 *
 * The caller wraps this in a transaction for fail-closed semantics.
 *
 * Returns the row after upsert.
 */
export function upsertMistakePattern(
  bucket: Pick<MistakePattern, "dimensionType" | "dimensionValue" | "roleIds" | "sampleEvidenceIds" | "lastSeen" | "firstSeen">,
): MistakePattern {
  const db = getDb();
  const now = Date.now();

  const cappedEvidence = bucket.sampleEvidenceIds.slice(-10);

  const existing = db.prepare(
    "SELECT * FROM mistake_patterns WHERE dimension_type = ? AND dimension_value = ?",
  ).get(bucket.dimensionType, bucket.dimensionValue) as MistakePatternRow | undefined;

  if (existing) {
    // Merge role_ids as set (no duplicates)
    const existingRoleIds: string[] = JSON.parse(existing.role_ids);
    const mergedRoleIds = Array.from(new Set([...existingRoleIds, ...bucket.roleIds]));

    // Merge evidence_ids, cap at 10 most-recent
    const existingEvidence: Array<{ source: string; id: string }> = JSON.parse(existing.sample_evidence_ids);
    const mergedEvidence = [...existingEvidence, ...cappedEvidence].slice(-10);

    db.prepare(`
      UPDATE mistake_patterns SET
        count = count + 1,
        role_ids = ?,
        sample_evidence_ids = ?,
        last_seen = ?,
        updated_at = ?
      WHERE dimension_type = ? AND dimension_value = ?
    `).run(
      JSON.stringify(mergedRoleIds),
      JSON.stringify(mergedEvidence),
      bucket.lastSeen,
      now,
      bucket.dimensionType,
      bucket.dimensionValue,
    );
  } else {
    db.prepare(INSERT_STMT).run(
      `mp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      bucket.dimensionType,
      bucket.dimensionValue,
      1,
      JSON.stringify(bucket.roleIds),
      JSON.stringify(cappedEvidence),
      "new",
      bucket.firstSeen,
      bucket.lastSeen,
      now,
      now,
    );
  }

  const row = db.prepare(
    "SELECT * FROM mistake_patterns WHERE dimension_type = ? AND dimension_value = ?",
  ).get(bucket.dimensionType, bucket.dimensionValue) as MistakePatternRow;
  return rowToMistakePattern(row);
}

/**
 * Returns mistake patterns ordered by last_seen DESC.
 * When status is provided, filters at SQL level.
 */
export function listMistakePatterns(
  status?: MistakePatternStatus,
  limit = 100,
  offset = 0,
): MistakePattern[] {
  const db = getDb();
  const rows = status
    ? db.prepare(
        "SELECT * FROM mistake_patterns WHERE status = ? ORDER BY last_seen DESC LIMIT ? OFFSET ?",
      ).all(status, limit, offset) as MistakePatternRow[]
    : db.prepare(
        "SELECT * FROM mistake_patterns ORDER BY last_seen DESC LIMIT ? OFFSET ?",
      ).all(limit, offset) as MistakePatternRow[];
  return rows.map(rowToMistakePattern);
}

/**
 * Returns a single mistake pattern by id, or undefined.
 */
export function getMistakePattern(id: string): MistakePattern | undefined {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM mistake_patterns WHERE id = ?",
  ).get(id) as MistakePatternRow | undefined;
  return row ? rowToMistakePattern(row) : undefined;
}

/**
 * Updates the status of a mistake pattern.
 */
export function updateMistakePatternStatus(
  id: string,
  status: MistakePatternStatus,
): void {
  const db = getDb();
  db.prepare(UPDATE_STATUS_STMT).run(status, Date.now(), id);
}
