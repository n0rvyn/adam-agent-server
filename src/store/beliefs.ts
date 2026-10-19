import { getDb } from "./db.js";
import type { Belief, BeliefVectorSearchResult } from "../shared/types.js";
import { cosineSimilarity } from "./memories.js";
import { getRoleTaskSeq } from "./roles.js";

/**
 * Input shape for createBelief: lastUsedAt is optional and auto-derived from
 * the role's current task_seq when omitted. Removes unit-confusion risk —
 * callers can't accidentally pass a ms timestamp (bug #2) by forgetting the
 * conversion. Pass lastUsedAt explicitly only when seeding test data or
 * back-dating beliefs.
 */
export type CreateBeliefInput = Omit<Belief, "lastUsedAt"> & { lastUsedAt?: number };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BeliefRow {
  id: string;
  role_id: string;
  content: string;
  is_anti: number;
  evidence_obs_ids: string | null;
  embedding: Buffer | null;
  superseded_by: string | null;
  created_at: number;
  last_used_at: number;
  last_validated_at: number;
  scope_key: string | null;
  status: string;
  success_ema: number | null;
  inject_count: number;
  // v90: prediction ledger columns
  kind?: string | null;
  prediction_confidence?: number | null;
  falsify_condition?: string | null;
  prediction_date?: string | null;
  settlement_status?: string | null;
  settled_at?: number | null;
  settled_outcome?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToBelief(row: BeliefRow): Belief {
  return {
    id: row.id,
    roleId: row.role_id,
    content: row.content,
    isAnti: row.is_anti === 1,
    evidenceObsIds: row.evidence_obs_ids ? JSON.parse(row.evidence_obs_ids) : [],
    embedding: row.embedding
      ? new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
      : undefined,
    supersededBy: row.superseded_by ?? undefined,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    lastValidatedAt: row.last_validated_at,
    scopeKey: row.scope_key ?? undefined,
    status: row.status as Belief["status"],
    successEma: row.success_ema ?? undefined,
    injectCount: row.inject_count ?? 0,
    // v90 prediction fields — back-compat default 'behavior' for pre-v90 rows
    kind: (row.kind === "prediction" || row.kind === "behavior" ? row.kind : "behavior") as
      | "behavior"
      | "prediction",
    predictionConfidence: row.prediction_confidence ?? undefined,
    falsifyCondition: row.falsify_condition ?? undefined,
    predictionDate: row.prediction_date ?? undefined,
    settlementStatus: (row.settlement_status as Belief["settlementStatus"]) ?? undefined,
    settledAt: row.settled_at ?? undefined,
    settledOutcome: row.settled_outcome ?? undefined,
  };
}

function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function createBelief(b: CreateBeliefInput): void {
  const db = getDb();
  const lastUsedAt = b.lastUsedAt ?? getRoleTaskSeq(b.roleId);
  db.prepare(`
    INSERT INTO beliefs (id, role_id, content,
      is_anti, evidence_obs_ids, embedding, superseded_by,
      created_at, last_used_at, last_validated_at,
      scope_key, status, success_ema, inject_count,
      kind, prediction_confidence, falsify_condition, prediction_date,
      settlement_status, settled_at, settled_outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    b.id,
    b.roleId,
    b.content,
    b.isAnti ? 1 : 0,
    JSON.stringify(b.evidenceObsIds),
    b.embedding ? serializeEmbedding(b.embedding) : null,
    b.supersededBy ?? null,
    b.createdAt,
    lastUsedAt,
    b.lastValidatedAt,
    b.scopeKey ?? null,
    b.status ?? "active",
    b.successEma ?? null,
    b.injectCount ?? 0,
    b.kind ?? "behavior",
    b.predictionConfidence ?? null,
    b.falsifyCondition ?? null,
    b.predictionDate ?? null,
    b.settlementStatus ?? null,
    b.settledAt ?? null,
    b.settledOutcome ?? null,
  );
}

export function getBelief(id: string): Belief | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM beliefs WHERE id = ?").get(id) as BeliefRow | undefined;
  return row ? rowToBelief(row) : undefined;
}

export function listBeliefsByRole(
  roleId: string,
  opts?: {
    includeSuperseded?: boolean;
    includeAnti?: boolean;
    onlyActive?: boolean;
    /**
     * v90 kind discriminator. Default = 'behavior' so existing callers
     * (injection, reflection, memory-gc, role debug view) NEVER see prediction
     * rows. The prediction-ledger pipeline passes 'prediction' explicitly via
     * listPredictionsByOwner. Pass 'any' to bypass the filter (admin only).
     */
    kind?: "behavior" | "prediction" | "any";
  },
): Belief[] {
  const db = getDb();
  const conditions = ["role_id = ?"];
  const params: unknown[] = [roleId];

  if (!opts?.includeSuperseded) {
    conditions.push("superseded_by IS NULL");
  }
  if (opts?.includeAnti === false) {
    conditions.push("is_anti = 0");
  }
  if (opts?.onlyActive) {
    conditions.push("status = 'active'");
  }
  const kindFilter = opts?.kind ?? "behavior";
  if (kindFilter !== "any") {
    conditions.push("kind = ?");
    params.push(kindFilter);
  }

  const rows = db
    .prepare(
      `SELECT * FROM beliefs WHERE ${conditions.join(" AND ")} ORDER BY last_used_at DESC`,
    )
    .all(...params) as BeliefRow[];

  return rows.map(rowToBelief);
}

export function searchBeliefsByVector(
  roleId: string,
  queryEmbedding: Float32Array,
  topK: number,
  opts?: {
    /**
     * v90 kind discriminator. Default = 'behavior' so callers (belief injection,
     * reflection neighbor search) never see prediction rows. Pass 'prediction'
     * to search only predictions; 'any' to bypass (admin only).
     */
    kind?: "behavior" | "prediction" | "any";
  },
): BeliefVectorSearchResult[] {
  const db = getDb();

  const kindFilter = opts?.kind ?? "behavior";
  const kindClause = kindFilter === "any" ? "" : "AND kind = ?";
  const kindParam = kindFilter === "any" ? [] : [kindFilter];

  const candidates = db
    .prepare(
      `SELECT * FROM beliefs
       WHERE role_id = ? ${kindClause} AND embedding IS NOT NULL AND superseded_by IS NULL AND status = 'active'
       ORDER BY last_used_at DESC
       LIMIT ?`,
    )
    .all(roleId, ...kindParam, Math.min(topK * 10, 1000)) as BeliefRow[];

  const scored = candidates
    .map((row) => ({
      node: rowToBelief(row),
      cosine: row.embedding
        ? cosineSimilarity(
            queryEmbedding,
            new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4),
          )
        : 0,
    }))
    .filter((r) => r.cosine >= 0);

  scored.sort((a, b) => b.cosine - a.cosine);
  return scored.slice(0, topK);
}

export function markBeliefSuperseded(oldId: string, newId: string): void {
  const db = getDb();
  db.prepare("UPDATE beliefs SET superseded_by = ? WHERE id = ?").run(newId, oldId);
}

// ---------------------------------------------------------------------------
// v90: prediction ledger read/write (kind='prediction' only)
// ---------------------------------------------------------------------------

/**
 * Read predictions owned by `ownerId` (a show/template scope id, not a role).
 * When `onlyUnsettled` is true, restricts to settlement_status='unsettled'.
 * Behavior rows are NEVER returned (the function name says it).
 */
export function listPredictionsByOwner(
  ownerId: string,
  opts?: { onlyUnsettled?: boolean },
): Belief[] {
  const db = getDb();
  const where = ["role_id = ?", "kind = 'prediction'"];
  const params: unknown[] = [ownerId];
  if (opts?.onlyUnsettled) {
    where.push("settlement_status = 'unsettled'");
  }
  const rows = db
    .prepare(
      `SELECT * FROM beliefs WHERE ${where.join(" AND ")} ORDER BY created_at DESC`,
    )
    .all(...params) as BeliefRow[];
  return rows.map(rowToBelief);
}

/**
 * Vector search over predictions only (kind='prediction'). Same semantics as
 * `searchBeliefsByVector` but excludes behavior rows so that prediction
 * similarity never bleeds into behavior injection.
 */
export function searchPredictionsByVector(
  ownerId: string,
  queryEmbedding: Float32Array,
  topK: number,
): BeliefVectorSearchResult[] {
  const db = getDb();
  const candidates = db
    .prepare(
      `SELECT * FROM beliefs
       WHERE role_id = ? AND kind = 'prediction'
         AND embedding IS NOT NULL
         AND superseded_by IS NULL
         AND status = 'active'
       ORDER BY last_used_at DESC
       LIMIT ?`,
    )
    .all(ownerId, Math.min(topK * 10, 1000)) as BeliefRow[];

  const scored = candidates
    .map((row) => ({
      node: rowToBelief(row),
      cosine: row.embedding
        ? cosineSimilarity(
            queryEmbedding,
            new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4),
          )
        : 0,
    }))
    .filter((r) => r.cosine >= 0);

  scored.sort((a, b) => b.cosine - a.cosine);
  return scored.slice(0, topK);
}

/**
 * Stamp settlement fields on an existing prediction (the OLD row, which is
 * about to be superseded). Does NOT change `content` or `prediction_confidence`
 * — those live on the NEW row created via `createBelief` + `markBeliefSuperseded`.
 */
export function settleBeliefPrediction(
  id: string,
  settlement: {
    status: "confirmed" | "refuted" | "partial";
    settledOutcome: string;
    settledAt: number;
  },
): void {
  const db = getDb();
  db.prepare(
    `UPDATE beliefs
     SET settlement_status = ?,
         settled_outcome = ?,
         settled_at = ?
     WHERE id = ? AND kind = 'prediction'`,
  ).run(settlement.status, settlement.settledOutcome, settlement.settledAt, id);
}

/**
 * Rewrite belief content and mark it as an anti-pattern.
 * Used by the anti-flip feature after Haiku successfully rewrites the content.
 */
export function updateBeliefContentAndMarkAnti(id: string, newContent: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE beliefs SET content = ?, is_anti = 1, last_validated_at = ? WHERE id = ?",
  ).run(newContent, Date.now(), id);
}

export function deleteBelief(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM beliefs WHERE id = ?").run(id);
}

/** Update a belief's status and optionally its scope_key. */
export function updateBeliefStatus(
  id: string,
  status: "active" | "archived",
  opts?: { scopeKey?: string },
): void {
  const db = getDb();
  if (opts?.scopeKey !== undefined) {
    db.prepare(
      "UPDATE beliefs SET status = ?, scope_key = COALESCE(?, scope_key) WHERE id = ?"
    ).run(status, opts?.scopeKey ?? null, id);
  } else {
    db.prepare("UPDATE beliefs SET status = ? WHERE id = ?").run(status, id);
  }
}

/**
 * EMA write-back + sync last_used_at (= task_seq in v81 semantics). Does NOT touch inject_count.
 * Shared by materializeOnTouch (belief-mechanism) and applyFitnessUpdate.
 * DP-002 Option B: inject_count is managed separately via bumpInjectCount.
 */
export function setBeliefSuccessEmaAndSeq(id: string, ema: number, seq: number): void {
  getDb()
    .prepare("UPDATE beliefs SET success_ema = ?, last_used_at = ?, last_validated_at = ? WHERE id = ?")
    .run(ema, seq, Date.now(), id);
}

/**
 * Increment inject_count by exactly 1. Called only from selectInjectionBeliefs, strictly once per inject.
 * DP-001 Option A + DP-002 Option B: inject counting is decoupled from EMA writes.
 */
export function bumpInjectCount(id: string): void {
  getDb().prepare("UPDATE beliefs SET inject_count = inject_count + 1 WHERE id = ?").run(id);
}
