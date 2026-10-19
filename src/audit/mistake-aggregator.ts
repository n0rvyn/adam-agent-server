/**
 * Mistake aggregator service.
 *
 * Reads failure signals from evolution_audit, role_scores, and delivery_log;
 * buckets by (dimension_type, dimension_value); materialises qualifying buckets
 * into the mistake_patterns table.
 *
 * Failure surface: all DB operations are synchronous (better-sqlite3).
 * Transaction-wrapped write path ensures fail-closed semantics (no partial rows).
 */

import { getDb } from "../store/db.js";
import { upsertMistakePattern } from "../store/mistake-patterns.js";
import type { MistakePattern, MistakeDimensionType } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * EMA threshold for aggregator "drift detection" signal.
 * Derived: DEFAULT_RETIREMENT_THRESHOLD (0.4 at src/audit/retirement.ts:16) + 0.1 = 0.5.
 * Intent: catch drift BEFORE retirement fires. The +0.1 buffer is the design margin.
 * Inlined (not imported) because aggregator loads via audit-tools.ts which is
 * transitively pulled into tests that mock retirement.js without this export.
 * Test `mistake-aggregator-threshold-derivation.test.ts` asserts the derivation holds.
 */
export const MISTAKE_EMA_THRESHOLD = 0.5;

/** Acute single-task outlier threshold. */
export const MISTAKE_TASK_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AggregateOpts {
  /** Scan window in days (default 14). */
  windowDays?: number;
  /** Dimensions to include (default all three). */
  dimensions?: MistakeDimensionType[];
  /** Min occurrences of a bucket to qualify (default 3). */
  minOccurrences?: number;
  /** Min distinct roles in a bucket to qualify (default 2). */
  minRoles?: number;
  /** Override EMA threshold (default MISTAKE_EMA_THRESHOLD). */
  scoreThresholdEma?: number;
  /** Override single-task threshold (default MISTAKE_TASK_THRESHOLD). */
  scoreThresholdTask?: number;
}

export interface AggregateResult {
  /** Number of rows written to mistake_patterns. */
  patternsUpserted: number;
  /** Total raw events scanned across all sources. */
  totalEventsScanned: number;
  /** Breakdown of events per dimension. */
  dimensionCounts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Score degradation dimension value helpers
// ---------------------------------------------------------------------------

type ScoreDegradationValue = "low_ema" | "low_task" | "both";

function scoreDegradationValue(
  emaScore: number,
  taskScore: number,
  emaThreshold: number,
  taskThreshold: number,
): ScoreDegradationValue {
  const emaLow = emaScore < emaThreshold;
  const taskLow = taskScore < taskThreshold;
  if (emaLow && taskLow) return "both";
  if (emaLow) return "low_ema";
  return "low_task";
}

// ---------------------------------------------------------------------------
// Main aggregation function
// ---------------------------------------------------------------------------

export function aggregateMistakes(opts: AggregateOpts = {}): AggregateResult {
  const {
    windowDays = 14,
    dimensions = ["event_type", "score_degradation", "tool_call_pattern"],
    minOccurrences = 3,
    minRoles = 2,
    scoreThresholdEma = MISTAKE_EMA_THRESHOLD,
    scoreThresholdTask = MISTAKE_TASK_THRESHOLD,
  } = opts;

  const db = getDb();
  const cutoffMs = Date.now() - windowDays * 86_400_000;

  // ---------------------------------------------------------------------------
  // Bucket accumulator
  // Key: `${dimension_type}|${dimension_value}`
  // ---------------------------------------------------------------------------

  type Bucket = {
    dimensionType: MistakeDimensionType;
    dimensionValue: string;
    count: number;
    roleIds: Set<string>;
    evidenceIds: Array<{ source: "evolution_audit" | "role_scores" | "delivery_log"; id: string }>;
    firstSeen: number;
    lastSeen: number;
  };

  const buckets = new Map<string, Bucket>();

  // ---------------------------------------------------------------------------
  // Scan evolution_audit
  // ---------------------------------------------------------------------------

  if (dimensions.includes("event_type")) {
    const evRows = db.prepare(`
      SELECT id, role_id, source, timestamp
      FROM evolution_audit
      WHERE timestamp >= ? AND source IN ('audit','monitor','admin','manual')
      ORDER BY timestamp ASC
    `).all(cutoffMs) as Array<{ id: string; role_id: string | null; source: string; timestamp: number }>;

    for (const row of evRows) {
      const dimValue = row.source;
      const key = `event_type|${dimValue}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          dimensionType: "event_type",
          dimensionValue: dimValue,
          count: 0,
          roleIds: new Set(),
          evidenceIds: [],
          firstSeen: Infinity,
          lastSeen: 0,
        });
      }
      const b = buckets.get(key)!;
      b.count++;
      if (row.role_id) b.roleIds.add(row.role_id);
      b.evidenceIds.push({ source: "evolution_audit", id: row.id });
      if (row.timestamp < b.firstSeen) b.firstSeen = row.timestamp;
      if (row.timestamp > b.lastSeen) b.lastSeen = row.timestamp;
    }
  }

  // ---------------------------------------------------------------------------
  // Scan role_scores
  // ---------------------------------------------------------------------------

  if (dimensions.includes("score_degradation")) {
    const scoreRows = db.prepare(`
      SELECT id, role_id, score_json, ema_score, created_at
      FROM role_scores
      WHERE created_at >= ?
      ORDER BY created_at ASC
    `).all(cutoffMs) as Array<{ id: string; role_id: string; score_json: string; ema_score: number; created_at: number }>;

    for (const row of scoreRows) {
      let taskScore = row.ema_score; // fallback
      try {
        const parsed = JSON.parse(row.score_json);
        if (typeof parsed.weighted === "number") taskScore = parsed.weighted;
        else if (typeof parsed.task === "number") taskScore = parsed.task;
        else if (typeof parsed.score === "number") taskScore = parsed.score;
      } catch { /* use ema fallback */ }

      const dimValue = scoreDegradationValue(row.ema_score, taskScore, scoreThresholdEma, scoreThresholdTask);
      const key = `score_degradation|${dimValue}`;

      if (!buckets.has(key)) {
        buckets.set(key, {
          dimensionType: "score_degradation",
          dimensionValue: dimValue,
          count: 0,
          roleIds: new Set(),
          evidenceIds: [],
          firstSeen: Infinity,
          lastSeen: 0,
        });
      }
      const b = buckets.get(key)!;
      b.count++;
      b.roleIds.add(row.role_id);
      b.evidenceIds.push({ source: "role_scores", id: row.id });
      if (row.created_at < b.firstSeen) b.firstSeen = row.created_at;
      if (row.created_at > b.lastSeen) b.lastSeen = row.created_at;
    }
  }

  // ---------------------------------------------------------------------------
  // Scan delivery_log (sandbox violations)
  // ---------------------------------------------------------------------------

  if (dimensions.includes("tool_call_pattern")) {
    const logRows = db.prepare(`
      SELECT dl.id, dl.task_id, dl.error, dl.created_at, t.role_id
      FROM delivery_log dl
      LEFT JOIN tasks t ON t.id = dl.task_id
      WHERE dl.created_at >= ?
        AND dl.message_type = 'sandbox_violation'
        AND dl.source = 'audit'
      ORDER BY dl.created_at ASC
    `).all(cutoffMs) as Array<{ id: string; task_id: string | null; error: string | null; created_at: number; role_id: string | null }>;

    for (const row of logRows) {
      // Bucket by first 60 chars of the error field
      const dimValue = (row.error ?? "").slice(0, 60);
      const key = `tool_call_pattern|${dimValue}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          dimensionType: "tool_call_pattern",
          dimensionValue: dimValue,
          count: 0,
          roleIds: new Set(),
          evidenceIds: [],
          firstSeen: Infinity,
          lastSeen: 0,
        });
      }
      const b = buckets.get(key)!;
      b.count++;
      if (row.role_id) b.roleIds.add(row.role_id);
      b.evidenceIds.push({ source: "delivery_log", id: row.id });
      if (row.created_at < b.firstSeen) b.firstSeen = row.created_at;
      if (row.created_at > b.lastSeen) b.lastSeen = row.created_at;
    }
  }

  // ---------------------------------------------------------------------------
  // Dimension count snapshot (before filtering)
  // ---------------------------------------------------------------------------

  const dimensionCounts: Record<string, number> = {};
  for (const key of buckets.keys()) {
    const [dimType] = key.split("|");
    dimensionCounts[dimType] = (dimensionCounts[dimType] ?? 0) + 1;
  }

  // ---------------------------------------------------------------------------
  // Filter: count >= minOccurrences AND roleIds.size >= minRoles
  // ---------------------------------------------------------------------------

  const qualifying = Array.from(buckets.values()).filter(
    (b) => b.count >= minOccurrences && b.roleIds.size >= minRoles,
  );

  // ---------------------------------------------------------------------------
  // Write — transaction-wrapped for fail-closed semantics (Threat Model)
  // ---------------------------------------------------------------------------

  let patternsUpserted = 0;

  const upsertAll = db.transaction(() => {
    for (const bucket of qualifying) {
      upsertMistakePattern({
        dimensionType: bucket.dimensionType,
        dimensionValue: bucket.dimensionValue,
        roleIds: Array.from(bucket.roleIds),
        sampleEvidenceIds: bucket.evidenceIds.slice(-10),
        firstSeen: bucket.firstSeen === Infinity ? Date.now() : bucket.firstSeen,
        lastSeen: bucket.lastSeen,
      });
      patternsUpserted++;
    }
  });

  try {
    upsertAll();
  } catch (err) {
    // Fail-closed: re-throw without partial writes (transaction rolls back)
    throw new Error(`aggregateMistakes: transaction failed: ${err}`);
  }

  // Total events scanned = sum of all bucket counts
  let totalEventsScanned = 0;
  for (const b of buckets.values()) totalEventsScanned += b.count;

  return { patternsUpserted, totalEventsScanned, dimensionCounts };
}
