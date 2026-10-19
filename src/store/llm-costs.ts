/**
 * Low-level INSERT store for the llm_costs table.
 * Only `recordLlmCost` (src/lib/record-llm-cost.ts) should call this.
 *
 * Also exports `getCostSummary` and `getCostDetail` for the aggregation API.
 */

import { getDb } from "./db.js";
import type { CostSummary, CostSummaryGroup, CostDetailCall } from "../shared/types.js";

export interface LlmCostRow {
  id: string;
  callId: string;
  source: string;
  model: string;
  roleId?: string;
  taskId?: string;
  sessionId?: string;
  messageId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  priced: number; // 0 or 1
  estimated: number; // 0 or 1
  sdkTotalCostUsd?: number;
  numTurns?: number;
  createdAt: number;
}

/**
 * Batch-insert llm_costs rows using INSERT OR IGNORE (idempotent on duplicate id).
 */
export function insertLlmCostRows(rows: LlmCostRow[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO llm_costs
      (id, call_id, source, model, role_id, task_id, session_id, message_id,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cost_usd, priced, estimated, sdk_total_cost_usd, num_turns, created_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((items: LlmCostRow[]) => {
    for (const row of items) {
      stmt.run(
        row.id,
        row.callId,
        row.source,
        row.model,
        row.roleId ?? null,
        row.taskId ?? null,
        row.sessionId ?? null,
        row.messageId ?? null,
        row.inputTokens,
        row.outputTokens,
        row.cacheReadTokens,
        row.cacheCreationTokens,
        row.costUsd,
        row.priced,
        row.estimated,
        row.sdkTotalCostUsd ?? null,
        row.numTurns ?? null,
        row.createdAt,
      );
    }
  });
  insertMany(rows);
}

// ─── Aggregation API ──────────────────────────────────────────────────────────

type GroupBy = "model" | "role" | "source" | "date";
type Granularity = "day" | "week" | "month";

const VALID_GROUP_BY = new Set<string>(["model", "role", "source", "date"]);
const VALID_GRANULARITY = new Set<string>(["day", "week", "month"]);

type TrendStackBy = "source" | "model";
const VALID_TREND_STACK = new Set<string>(["source", "model"]);

export interface CostSummaryParams {
  from: number;
  to: number;
  groupBy: GroupBy;
  granularity: Granularity;
  /** Minutes east of UTC for local-day bucketing (e.g. UTC+8 → 480). Default 0 (UTC). */
  tzOffsetMinutes?: number;
  /** When set, also return a per-bucket cost series split by this dimension (for stacked trend). */
  trendStackBy?: TrendStackBy;
}

export interface CostDetailParams {
  groupBy: GroupBy;
  groupKey: string;
  from: number;
  to: number;
  /** Minutes east of UTC for local-day bucketing on date-group detail. Default 0 (UTC). */
  tzOffsetMinutes?: number;
}

/**
 * Return grouped cost sums for the given time window.
 * groupBy=role maps NULL role_id to the synthetic key 'system'.
 */
export async function getCostSummary(params: CostSummaryParams): Promise<CostSummary> {
  const { from, to, groupBy, granularity, trendStackBy } = params;

  if (!VALID_GROUP_BY.has(groupBy)) {
    throw new Error(`Invalid groupBy: ${groupBy}. Must be one of ${[...VALID_GROUP_BY].join(", ")}`);
  }
  if (!VALID_GRANULARITY.has(granularity)) {
    throw new Error(`Invalid granularity: ${granularity}. Must be one of ${[...VALID_GRANULARITY].join(", ")}`);
  }
  if (trendStackBy !== undefined && !VALID_TREND_STACK.has(trendStackBy)) {
    throw new Error(`Invalid trendStackBy: ${trendStackBy}. Must be one of ${[...VALID_TREND_STACK].join(", ")}`);
  }

  const db = getDb();

  // Local-day bucketing: shift UTC epoch by the caller's tz offset before strftime so
  // day/week/month boundaries align with user_day_boundary=00:00 LOCAL midnight (not UTC).
  // tzSec is a coerced integer (injection-safe to inline). Default 0 = UTC.
  const tzSec = Math.trunc(params.tzOffsetMinutes ?? 0) * 60;
  const localDatetime = `datetime(created_at / 1000 + (${tzSec}), 'unixepoch')`;

  // Build the group key expression
  let groupExpr: string;
  if (groupBy === "model") {
    groupExpr = "model";
  } else if (groupBy === "role") {
    groupExpr = "COALESCE(role_id, 'system')";
  } else if (groupBy === "source") {
    groupExpr = "source";
  } else {
    // date — bucket by calendar day at LOCAL midnight (tz-shifted)
    groupExpr = `strftime('%Y-%m-%d', ${localDatetime})`;
  }

  // Grouped rows
  const groupRows = db.prepare(`
    SELECT
      ${groupExpr} AS key,
      SUM(cost_usd) AS costUsd,
      SUM(input_tokens) AS inputTokens,
      SUM(output_tokens) AS outputTokens,
      SUM(cache_read_tokens) AS cacheReadTokens,
      SUM(cache_creation_tokens) AS cacheCreationTokens,
      COUNT(DISTINCT call_id) AS callCount
    FROM llm_costs
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY key
    ORDER BY costUsd DESC
  `).all(from, to) as Array<{
    key: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    callCount: number;
  }>;

  const groups: CostSummaryGroup[] = groupRows.map((r) => ({
    key: r.key,
    costUsd: r.costUsd ?? 0,
    inputTokens: r.inputTokens ?? 0,
    outputTokens: r.outputTokens ?? 0,
    cacheReadTokens: r.cacheReadTokens ?? 0,
    cacheCreationTokens: r.cacheCreationTokens ?? 0,
    callCount: r.callCount ?? 0,
  }));

  // Top-level totals
  const totalRow = db.prepare(`
    SELECT
      SUM(cost_usd) AS totalCostUsd,
      SUM(input_tokens) AS inputTokens,
      SUM(output_tokens) AS outputTokens,
      SUM(cache_read_tokens) AS cacheReadTokens,
      SUM(cache_creation_tokens) AS cacheCreationTokens,
      COUNT(DISTINCT call_id) AS callCount
    FROM llm_costs
    WHERE created_at >= ? AND created_at <= ?
  `).get(from, to) as {
    totalCostUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
    callCount: number | null;
  };

  // Unpriced calls: calls that have at least one priced=0 row
  const unpricedRow = db.prepare(`
    SELECT
      COUNT(DISTINCT call_id) AS unpricedCallCount,
      SUM(input_tokens + output_tokens) AS unpricedTokens
    FROM llm_costs
    WHERE created_at >= ? AND created_at <= ? AND priced = 0
  `).get(from, to) as { unpricedCallCount: number | null; unpricedTokens: number | null };

  // Top model by cost
  const topModelRow = db.prepare(`
    SELECT model
    FROM llm_costs
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY model
    ORDER BY SUM(cost_usd) DESC
    LIMIT 1
  `).get(from, to) as { model: string } | undefined;

  // Trend buckets (granularity-based)
  let trenFmt: string;
  if (granularity === "day") {
    trenFmt = "%Y-%m-%d";
  } else if (granularity === "week") {
    trenFmt = "%Y-W%W";
  } else {
    trenFmt = "%Y-%m";
  }

  const trendRows = db.prepare(`
    SELECT
      strftime('${trenFmt}', ${localDatetime}) AS bucket,
      SUM(cost_usd) AS costUsd,
      COUNT(DISTINCT call_id) AS callCount
    FROM llm_costs
    WHERE created_at >= ? AND created_at <= ?
    GROUP BY bucket
    ORDER BY bucket ASC
  `).all(from, to) as Array<{ bucket: string; costUsd: number; callCount: number }>;

  // Stacked trend (optional): per-bucket cost split by source or model, pivoted to one
  // object per bucket: { bucket, [stackKey1]: cost, [stackKey2]: cost, ... }.
  let trendStacked: Array<Record<string, string | number>> | undefined;
  let trendStackKeys: string[] | undefined;
  if (trendStackBy !== undefined) {
    const stackExpr = trendStackBy === "source" ? "source" : "model";
    const stackRows = db.prepare(`
      SELECT
        strftime('${trenFmt}', ${localDatetime}) AS bucket,
        ${stackExpr} AS stackKey,
        SUM(cost_usd) AS costUsd
      FROM llm_costs
      WHERE created_at >= ? AND created_at <= ?
      GROUP BY bucket, stackKey
      ORDER BY bucket ASC
    `).all(from, to) as Array<{ bucket: string; stackKey: string; costUsd: number }>;

    const keySet = new Set<string>();
    const byBucket = new Map<string, Record<string, string | number>>();
    for (const r of stackRows) {
      const key = r.stackKey ?? "unknown";
      keySet.add(key);
      let entry = byBucket.get(r.bucket);
      if (!entry) {
        entry = { bucket: r.bucket };
        byBucket.set(r.bucket, entry);
      }
      entry[key] = ((entry[key] as number | undefined) ?? 0) + (r.costUsd ?? 0);
    }
    trendStackKeys = [...keySet];
    trendStacked = [...byBucket.values()];
  }

  return {
    totalCostUsd: totalRow?.totalCostUsd ?? 0,
    callCount: totalRow?.callCount ?? 0,
    topModel: topModelRow?.model,
    tokens: {
      input: totalRow?.inputTokens ?? 0,
      output: totalRow?.outputTokens ?? 0,
      cacheRead: totalRow?.cacheReadTokens ?? 0,
      cacheCreation: totalRow?.cacheCreationTokens ?? 0,
    },
    unpricedCallCount: unpricedRow?.unpricedCallCount ?? 0,
    unpricedTokens: unpricedRow?.unpricedTokens ?? 0,
    groups,
    trend: trendRows.map((r) => ({
      bucket: r.bucket,
      costUsd: r.costUsd ?? 0,
      callCount: r.callCount ?? 0,
    })),
    ...(trendStacked ? { trendStacked, trendStackKeys } : {}),
  };
}

/**
 * Return individual calls for a given group key (for inline drill-down on the Cost page).
 * Aggregates per-model rows by call_id.
 */
export async function getCostDetail(params: CostDetailParams): Promise<CostDetailCall[]> {
  const { groupBy, groupKey, from, to } = params;

  if (!VALID_GROUP_BY.has(groupBy)) {
    throw new Error(`Invalid groupBy: ${groupBy}. Must be one of ${[...VALID_GROUP_BY].join(", ")}`);
  }

  const db = getDb();

  // Build WHERE clause for the group key
  let filterClause: string;
  let filterValue: string;
  if (groupBy === "model") {
    filterClause = "model = ?";
    filterValue = groupKey;
  } else if (groupBy === "role") {
    filterClause = groupKey === "system" ? "role_id IS NULL" : "role_id = ?";
    filterValue = groupKey;
  } else if (groupBy === "source") {
    filterClause = "source = ?";
    filterValue = groupKey;
  } else {
    // date — match the same LOCAL-midnight bucket used by getCostSummary
    const tzSec = Math.trunc(params.tzOffsetMinutes ?? 0) * 60;
    filterClause = `strftime('%Y-%m-%d', datetime(created_at / 1000 + (${tzSec}), 'unixepoch')) = ?`;
    filterValue = groupKey;
  }

  const isNullFilter = groupBy === "role" && groupKey === "system";

  // Aggregate per call_id (sum up its model rows)
  const rows = db.prepare(`
    SELECT
      call_id AS callId,
      source,
      model,
      SUM(cost_usd) AS costUsd,
      SUM(input_tokens) AS inputTokens,
      SUM(output_tokens) AS outputTokens,
      MIN(priced) AS priced,
      MIN(created_at) AS createdAt,
      MAX(task_id) AS taskId,
      MAX(session_id) AS sessionId,
      MAX(message_id) AS messageId
    FROM llm_costs
    WHERE created_at >= ? AND created_at <= ?
      AND ${filterClause}
    GROUP BY call_id
    ORDER BY createdAt DESC
  `).all(isNullFilter ? [from, to] : [from, to, filterValue]) as Array<{
    callId: string;
    source: string;
    model: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    priced: number;
    createdAt: number;
    taskId: string | null;
    sessionId: string | null;
    messageId: string | null;
  }>;

  return rows.map((r) => ({
    callId: r.callId,
    source: r.source,
    model: r.model,
    costUsd: r.costUsd ?? 0,
    inputTokens: r.inputTokens ?? 0,
    outputTokens: r.outputTokens ?? 0,
    priced: r.priced ?? 0,
    createdAt: r.createdAt,
    ...(r.taskId ? { taskId: r.taskId } : {}),
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    ...(r.messageId ? { messageId: r.messageId } : {}),
  }));
}
