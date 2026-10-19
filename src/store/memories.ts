import { getDb } from "./db.js";
import { getRole } from "./roles.js";
import type { MemoryNode, MemoryNodeType, MemorySourceType } from "../shared/types.js";

interface MemoryRow {
  id: string;
  role_id: string;
  type: string;
  content: string;
  embedding: Buffer | null;
  keywords: string | null;
  importance: number;
  source_type: string;
  source_task_id: string | null;
  evidence: string | null;
  created_at: number;
  last_accessed: number;
  retrieved_count: number;
  tier: string;
  superseded_by: string | null;
}

function rowToMemory(row: MemoryRow): MemoryNode {
  return {
    id: row.id,
    roleId: row.role_id,
    type: row.type as MemoryNodeType,
    content: row.content,
    embedding: row.embedding
      ? new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
      : undefined,
    keywords: row.keywords ? JSON.parse(row.keywords) : [],
    importance: row.importance,
    sourceType: row.source_type as MemorySourceType,
    sourceTaskId: row.source_task_id ?? undefined,
    evidence: row.evidence ? JSON.parse(row.evidence) : undefined,
    createdAt: row.created_at,
    lastAccessed: row.last_accessed,
    retrievedCount: row.retrieved_count,
    tier: row.tier as import("../shared/types.js").MemoryTier,
    supersededBy: row.superseded_by ?? undefined,
  };
}

function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

export function createMemory(memory: MemoryNode): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO memories (id, role_id, type, content, embedding, keywords,
      importance, source_type, source_task_id, evidence,
      created_at, last_accessed, retrieved_count, tier, superseded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memory.id,
    memory.roleId,
    memory.type,
    memory.content,
    memory.embedding ? serializeEmbedding(memory.embedding) : null,
    JSON.stringify(memory.keywords),
    memory.importance,
    memory.sourceType,
    memory.sourceTaskId ?? null,
    memory.evidence ? JSON.stringify(memory.evidence) : null,
    memory.createdAt,
    memory.lastAccessed,
    memory.retrievedCount,
    memory.tier,
    memory.supersededBy ?? null,
  );
}

export function getMemory(id: string): MemoryNode | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
    | MemoryRow
    | undefined;
  return row ? rowToMemory(row) : undefined;
}

/**
 * Update a memory's mutable fields. Returns false if the memory doesn't exist.
 * Embedding is caller-provided (regenerate via generateEmbedding if content changes).
 */
export function updateMemory(id: string, updates: {
  content?: string;
  embedding?: Float32Array;
  keywords?: string[];
  importance?: number;
  type?: MemoryNodeType;
}): boolean {
  const db = getDb();
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.content !== undefined) {
    setClauses.push("content = ?");
    params.push(updates.content);
  }
  if (updates.embedding !== undefined) {
    setClauses.push("embedding = ?");
    params.push(serializeEmbedding(updates.embedding));
  }
  if (updates.keywords !== undefined) {
    setClauses.push("keywords = ?");
    params.push(JSON.stringify(updates.keywords));
  }
  if (updates.importance !== undefined) {
    setClauses.push("importance = ?");
    params.push(updates.importance);
  }
  if (updates.type !== undefined) {
    setClauses.push("type = ?");
    params.push(updates.type);
  }

  if (setClauses.length === 0) return true;

  // Always update last_accessed on mutation
  setClauses.push("last_accessed = ?");
  params.push(Date.now());

  params.push(id);
  const result = db.prepare(`UPDATE memories SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);
  return result.changes > 0;
}

export function updateMemoryRetrievalCount(id: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE memories SET retrieved_count = retrieved_count + 1, last_accessed = ? WHERE id = ?",
  ).run(Date.now(), id);
}

export function markSuperseded(memoryIds: string[], supersededById: string): number {
  const db = getDb();
  const stmt = db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?");
  let updated = 0;
  for (const id of memoryIds) {
    const result = stmt.run(supersededById, id);
    updated += result.changes;
  }
  return updated;
}

export function countMemoriesByRole(roleId: string): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM memories WHERE role_id = ?").get(roleId) as { count: number };
  return row.count;
}

export function listMemoriesByRole(
  roleId: string,
  limit = 100,
  offset = 0,
): MemoryNode[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM memories WHERE role_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .all(roleId, limit, offset) as MemoryRow[];
  return rows.map(rowToMemory);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Candidate returned from a vector search, carrying the cosine magnitude
 * so callers (searchHybrid, queryMemory) can rank without recomputing.
 * cosine is clamped to [0,1]; the raw dot-product is not exposed.
 */
export interface VectorSearchResult {
  node: MemoryNode;
  cosine: number;
}

export function searchByVector(
  roleId: string | undefined,
  queryEmbedding: Float32Array,
  topK: number,
  options?: { tiers?: string[]; excludeSuperseded?: boolean },
): VectorSearchResult[] {
  const db = getDb();

  // Pre-filter by role, tier, and superseded status in SQL
  // Only load embeddings for candidates that pass the filter
  const conditions: string[] = ["embedding IS NOT NULL"];
  const params: unknown[] = [];

  if (roleId) {
    conditions.push("role_id = ?");
    params.push(roleId);
  }
  if (options?.excludeSuperseded) {
    conditions.push("superseded_by IS NULL");
  }
  if (options?.tiers && options.tiers.length > 0) {
    conditions.push(`tier IN (${options.tiers.map(() => "?").join(",")})`);
    params.push(...options.tiers);
  }

  // Limit candidates to reduce JS-side computation
  // Use recency + importance as pre-sort to bias toward recent, important memories
  // DP-002: cap at 1000 candidates (Issue #112: make configurable later)
  const sql = `SELECT * FROM memories WHERE ${conditions.join(" AND ")}
    ORDER BY importance DESC, created_at DESC
    LIMIT ?`;
  params.push(Math.min(topK * 10, 1000));

  const rows = db.prepare(sql).all(...params) as MemoryRow[];

  const scored = rows
    .map((row) => {
      const embedding = new Float32Array(
        row.embedding!.buffer,
        row.embedding!.byteOffset,
        row.embedding!.byteLength / 4,
      );
      const rawCosine = cosineSimilarity(queryEmbedding, embedding);
      const cosine = Math.min(1, Math.max(0, rawCosine));
      return { row, cosine };
    })
    .sort((a, b) => b.cosine - a.cosine)
    .slice(0, topK);

  return scored.map((s) => ({ node: rowToMemory(s.row), cosine: s.cosine }));
}

/**
 * Sanitize input for FTS5 MATCH queries.
 * Each token is individually quoted to prevent FTS5 operator injection
 * (AND, OR, NOT, *, etc.) while preserving OR semantics for multi-word recall.
 * e.g. "orpheus music" → "orpheus" OR "music" (matches either word)
 */
function sanitizeFts5Query(query: string): string {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  // Quote each token individually, escape internal double quotes
  const quoted = tokens.map((t) => `"${t.replace(/"/g, '""')}"`);
  return quoted.join(" OR ");
}

/**
 * Candidate returned from a BM25 search, carrying the FTS5 score magnitude.
 * bm25 is a positive-higher-is-better value (SQLite FTS5's rank column is
 * negative-lower-is-better; we negate for natural min-max normalization).
 */
export interface Bm25SearchResult {
  node: MemoryNode;
  bm25: number;
}

type Bm25Row = MemoryRow & { bm25_score: number };

export function searchByBM25(
  roleId: string | undefined,
  query: string,
  topK: number,
): Bm25SearchResult[] {
  const db = getDb();
  const safeQuery = sanitizeFts5Query(query);
  // SQLite FTS5 `rank` equals `bm25(memories_fts)` and is negative
  // (closer to 0 = better match). Select it explicitly so we can expose the
  // magnitude; ORDER BY rank still gives best-first ordering.
  const rows = roleId
    ? db
        .prepare(`
          SELECT m.*, rank AS bm25_score FROM memories m
          JOIN memories_fts fts ON m.rowid = fts.rowid
          WHERE memories_fts MATCH ? AND m.role_id = ?
          ORDER BY rank
          LIMIT ?
        `)
        .all(safeQuery, roleId, topK) as Bm25Row[]
    : db
        .prepare(`
          SELECT m.*, rank AS bm25_score FROM memories m
          JOIN memories_fts fts ON m.rowid = fts.rowid
          WHERE memories_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `)
        .all(safeQuery, topK) as Bm25Row[];
  // Negate so higher = better, matching the intuitive direction for
  // downstream combination with cosine.
  return rows.map((row) => ({ node: rowToMemory(row), bm25: -row.bm25_score }));
}

export function deleteMemory(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
}

// ===== Smallville Scoring =====

export interface ScoringWeights {
  recency: number;
  relevance: number;
  importance: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  recency: 0.5,
  relevance: 3.0,
  importance: 2.0,
};

const RECENCY_DECAY = 0.9;

export function calculateRecency(createdAt: number): number {
  const now = Date.now();
  const daysAgo = (now - createdAt) / (1000 * 60 * 60 * 24);
  return Math.min(1, Math.max(0, Math.pow(RECENCY_DECAY, daysAgo)));
}

export function calculateSmallvilleScore(
  createdAt: number,
  relevance: number,
  importance: number,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): number {
  const recencyNorm = calculateRecency(createdAt);
  const relevanceNorm = Math.min(1, Math.max(0, relevance));
  const importanceNorm = importance / 5;

  return (
    weights.recency * recencyNorm +
    weights.relevance * relevanceNorm +
    weights.importance * importanceNorm
  );
}

export function getRoleScoringWeights(roleId: string): ScoringWeights {
  const role = getRole(roleId);
  const prefs = role?.preferences as { scoringWeights?: ScoringWeights } | undefined;
  return prefs?.scoringWeights ?? DEFAULT_SCORING_WEIGHTS;
}

// ===== Hybrid Search =====

export interface HybridSearchConfig {
  vectorWeight: number;
  bm25Weight: number;
}

export const DEFAULT_HYBRID_CONFIG: HybridSearchConfig = {
  vectorWeight: 0.6,
  bm25Weight: 0.4,
};

/**
 * Clean up old memories beyond retention limits.
 * Multi-phase cleanup strategy (GAP-07, GAP-12):
 * Phase 1: Remove superseded memories older than 7 days (audit trail kept briefly)
 * Phase 2: Remove unretrieved low-importance memories older than 30 days
 * Phase 3: Age-based removal (preserve importance >= 4)
 * Phase 4: Count-based overflow (protect semantic tier + high importance)
 * @param roleId - Role whose memories to clean
 * @param maxMemories - max memories per role (default 10000)
 * @param maxAgeDays - max age in days (default 90)
 */
export function cleanupMemories(
  roleId: string,
  maxMemories = 10000,
  maxAgeDays = 90,
): number {
  const db = getDb();
  let deleted = 0;

  // Phase 1: Remove superseded memories older than 7 days (keep recent superseded for audit)
  const supersededCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const sup = db.prepare(
    "DELETE FROM memories WHERE role_id = ? AND superseded_by IS NOT NULL AND created_at < ?"
  ).run(roleId, supersededCutoff);
  deleted += sup.changes;

  // Phase 2: Remove unretrieved low-importance memories older than 30 days
  const unretrievedCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const unret = db.prepare(
    "DELETE FROM memories WHERE role_id = ? AND retrieved_count = 0 AND importance <= 2 AND created_at < ?"
  ).run(roleId, unretrievedCutoff);
  deleted += unret.changes;

  // Phase 3: Age-based removal (preserve importance >= 4)
  const ageCutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const aged = db.prepare(
    "DELETE FROM memories WHERE role_id = ? AND importance < 4 AND created_at < ?"
  ).run(roleId, ageCutoff);
  deleted += aged.changes;

  // Phase 4: Count-based overflow (protect semantic tier + high importance)
  const countRow = db.prepare(
    "SELECT COUNT(*) as cnt FROM memories WHERE role_id = ?"
  ).get(roleId) as { cnt: number };

  if (countRow.cnt > maxMemories) {
    const excess = countRow.cnt - maxMemories;
    db.prepare(`
      DELETE FROM memories WHERE id IN (
        SELECT id FROM memories WHERE role_id = ? AND tier != 'semantic'
        ORDER BY importance ASC, retrieved_count ASC, created_at ASC
        LIMIT ?
      )
    `).run(roleId, excess);
    deleted += excess;
  }

  return deleted;
}

/**
 * Candidate returned from a hybrid search. Carries both raw signal magnitudes
 * so downstream Smallville scoring can reason about absolute relevance rather
 * than rank positions.
 *
 * cosine: [0,1], 0 when the memory has no embedding or was BM25-only.
 * bm25:   raw positive-higher-is-better score, 0 when the memory was vector-only.
 * combinedRelevance: [0,1], convex combination of normalized cosine and
 *   min-max-normalized BM25 using HybridSearchConfig weights.
 */
export interface HybridSearchResult {
  node: MemoryNode;
  cosine: number;
  bm25: number;
  combinedRelevance: number;
}

export function searchHybrid(
  roleId: string | undefined,
  queryEmbedding: Float32Array,
  query: string,
  topK: number,
  config: HybridSearchConfig = DEFAULT_HYBRID_CONFIG,
  options?: { tiers?: string[]; excludeSuperseded?: boolean },
): HybridSearchResult[] {
  const vectorResults = searchByVector(roleId, queryEmbedding, topK * 2, options);
  const bm25Results = searchByBM25(roleId, query, topK * 2);

  // Merge by node id, preserving magnitudes from each pass.
  // Vector-only memories carry bm25=0; BM25-only memories carry cosine=0.
  const merged = new Map<string, { node: MemoryNode; cosine: number; bm25: number }>();

  for (const { node, cosine } of vectorResults) {
    merged.set(node.id, { node, cosine, bm25: 0 });
  }

  for (const { node, bm25 } of bm25Results) {
    const existing = merged.get(node.id);
    if (existing) {
      existing.bm25 = bm25;
    } else {
      merged.set(node.id, { node, cosine: 0, bm25 });
    }
  }

  // Optional post-filter: BM25 can surface memories the vector pool's
  // tiers/excludeSuperseded filter would have removed. Apply the same filter
  // to the BM25-only arrivals so the hybrid pool honors the caller's options.
  const tierFilter = options?.tiers && options.tiers.length > 0 ? new Set(options.tiers) : null;
  const excludeSuperseded = options?.excludeSuperseded === true;
  const filtered: Array<{ node: MemoryNode; cosine: number; bm25: number }> = [];
  for (const entry of merged.values()) {
    if (tierFilter && !tierFilter.has(entry.node.tier ?? "episodic")) continue;
    if (excludeSuperseded && entry.node.supersededBy) continue;
    filtered.push(entry);
  }

  // Min-max normalize BM25 across the pool so it shares cosine's [0,1] range.
  // - bm25 === 0 marks a vector-only arrival (no BM25 match) → normalize to 0.
  // - When only one memory has a non-zero BM25 score, or all non-zero scores
  //   are equal, min==max → we return 1 for every matched memory (they all
  //   beat the "no match" baseline equally).
  // - Otherwise, classic min-max rescales [min, max] → [0, 1].
  let bmMin = Infinity;
  let bmMax = -Infinity;
  let bmHitCount = 0;
  for (const { bm25 } of filtered) {
    if (bm25 !== 0) {
      bmHitCount++;
      if (bm25 < bmMin) bmMin = bm25;
      if (bm25 > bmMax) bmMax = bm25;
    }
  }
  const bmSpread = bmMax - bmMin;
  const normalizeBm25 = (raw: number): number => {
    if (raw === 0) return 0; // memory was vector-only
    if (bmHitCount === 0) return 0; // pool has no BM25 matches at all
    if (bmSpread <= 0) return 1; // single or tied BM25 hits → full weight each
    return (raw - bmMin) / bmSpread;
  };

  const combined = filtered
    .map(({ node, cosine, bm25 }) => {
      const bm25Norm = normalizeBm25(bm25);
      const combinedRelevance = config.vectorWeight * cosine + config.bm25Weight * bm25Norm;
      return { node, cosine, bm25, combinedRelevance };
    })
    .sort((a, b) => b.combinedRelevance - a.combinedRelevance);

  return combined.slice(0, topK);
}
