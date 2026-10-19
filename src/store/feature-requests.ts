/**
 * Feature requests CRUD store.
 *
 * Stores feature requests extracted by the feature-miner Role.
 * Terminal store (Phase 3 scope): no event emission, no delivery_rules hook.
 */

import { getDb } from "./db.js";

/** Feature request status values. */
export type FeatureRequestStatus = "new" | "reviewed" | "dismissed" | "converted";

export interface FeatureRequest {
  id: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  extractedAt: number;
  extractedByRoleId?: string;
  content: string;
  summary?: string;
  status: FeatureRequestStatus;
  tags?: string[];
  evidenceQuote?: string;
  createdAt: number;
  updatedAt: number;
}

interface FeatureRequestRow {
  id: string;
  source_session_id: string | null;
  source_message_id: string | null;
  extracted_at: number;
  extracted_by_role_id: string | null;
  content: string;
  summary: string | null;
  status: string;
  tags: string | null;
  evidence_quote: string | null;
  created_at: number;
  updated_at: number;
}

function rowToFeatureRequest(row: FeatureRequestRow): FeatureRequest {
  return {
    id: row.id,
    sourceSessionId: row.source_session_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    extractedAt: row.extracted_at,
    extractedByRoleId: row.extracted_by_role_id ?? undefined,
    content: row.content,
    summary: row.summary ?? undefined,
    status: row.status as FeatureRequestStatus,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    evidenceQuote: row.evidence_quote ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Parameterized statements (created once, reused per call)
// ---------------------------------------------------------------------------

const INSERT_STMT = `
  INSERT INTO feature_requests
    (id, source_session_id, source_message_id, extracted_at, extracted_by_role_id,
     content, summary, status, tags, evidence_quote, created_at, updated_at)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`.trim();

const UPDATE_STATUS_STMT = `
  UPDATE feature_requests SET status = ?, updated_at = ? WHERE id = ?
`.trim();

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Creates a new feature request.
 * All fields from the input are inserted; tags are JSON-serialized.
 */
export function createFeatureRequest(req: FeatureRequest): void {
  const db = getDb();
  db.prepare(INSERT_STMT).run(
    req.id,
    req.sourceSessionId ?? null,
    req.sourceMessageId ?? null,
    req.extractedAt,
    req.extractedByRoleId ?? null,
    req.content,
    req.summary ?? null,
    req.status,
    req.tags ? JSON.stringify(req.tags) : null,
    req.evidenceQuote ?? null,
    req.createdAt,
    req.updatedAt,
  );
}

/**
 * Returns feature requests ordered by extracted_at DESC.
 * When status is provided, filters at SQL level (correct pagination per DP-005).
 */
export function listFeatureRequests(
  status?: FeatureRequestStatus,
  limit = 100,
  offset = 0,
): FeatureRequest[] {
  const db = getDb();
  const rows = status
    ? db.prepare(
        "SELECT * FROM feature_requests WHERE status = ? ORDER BY extracted_at DESC LIMIT ? OFFSET ?",
      ).all(status, limit, offset) as FeatureRequestRow[]
    : db.prepare(
        "SELECT * FROM feature_requests ORDER BY extracted_at DESC LIMIT ? OFFSET ?",
      ).all(limit, offset) as FeatureRequestRow[];
  return rows.map(rowToFeatureRequest);
}

/**
 * Returns a single feature request by id, or undefined.
 */
export function getFeatureRequest(id: string): FeatureRequest | undefined {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM feature_requests WHERE id = ?",
  ).get(id) as FeatureRequestRow | undefined;
  return row ? rowToFeatureRequest(row) : undefined;
}

/**
 * Updates the status of a feature request.
 */
export function updateFeatureRequestStatus(
  id: string,
  status: FeatureRequestStatus,
): void {
  const db = getDb();
  db.prepare(UPDATE_STATUS_STMT).run(status, Date.now(), id);
}
