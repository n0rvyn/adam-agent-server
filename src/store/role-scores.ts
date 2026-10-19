import { getDb } from "./db.js";
import { EMA_ALPHA } from "../audit/score.js";
import { getViolationsByRole } from "./audit-violations.js";
import type { AuditViolation } from "./audit-violations.js";

export interface RoleScoreRecord {
  id: string;
  roleId: string;
  taskId: string;
  scores: TaskDimensionScores;
  emaScore: number;
  createdAt: number;
  /** Task type this score was recorded for (skill name or "generic"). */
  taskType?: string;
}

export interface TaskDimensionScores {
  taskSuccess: number;
  planAccuracy: number;
  permissionCompliance: number;
  efficiency: number;
  intentFulfillment?: number | null;      // null when eval failed or pending
  intentFulfillmentFailed?: boolean;       // true when LLM eval errored or timed out
  contractCompliance?: number | null;      // Phase 2: 1 - violations/contractsChecked; null when no checks
  contractsCheckedThisTask?: number;       // Phase 2: number of contract fields checked this task
  weighted: number;
}

interface RoleScoreRow {
  id: string;
  role_id: string;
  task_id: string;
  task_type: string | null;
  score_json: string;
  ema_score: number;
  created_at: number;
}

function rowToRecord(row: RoleScoreRow): RoleScoreRecord {
  return {
    id: row.id,
    roleId: row.role_id,
    taskId: row.task_id,
    scores: JSON.parse(row.score_json) as TaskDimensionScores,
    emaScore: row.ema_score,
    createdAt: row.created_at,
    taskType: row.task_type ?? undefined,
  };
}

export function createRoleScore(record: RoleScoreRecord): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO role_scores (id, role_id, task_id, task_type, score_json, ema_score, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.roleId,
    record.taskId,
    record.taskType ?? null,
    JSON.stringify(record.scores),
    record.emaScore,
    record.createdAt,
  );
}

export function getScoresByRole(roleId: string, limit = 50): RoleScoreRecord[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM role_scores WHERE role_id = ? ORDER BY created_at DESC LIMIT ?",
  ).all(roleId, limit) as RoleScoreRow[];
  return rows.map(rowToRecord);
}

export function getLatestEmaScore(roleId: string): number | undefined {
  const db = getDb();
  const row = db.prepare(
    "SELECT ema_score FROM role_scores WHERE role_id = ? ORDER BY created_at DESC LIMIT 1",
  ).get(roleId) as { ema_score: number } | undefined;
  return row?.ema_score;
}

export function getMedianTokenUsage(roleId: string): number {
  const db = getDb();
  // Get recent task token usage for this role
  const rows = db.prepare(`
    SELECT token_usage FROM tasks
    WHERE role_id = ? AND status = 'completed' AND token_usage IS NOT NULL
    ORDER BY completed_at DESC LIMIT 50
  `).all(roleId) as { token_usage: string }[];

  if (rows.length === 0) return 10000; // fallback for no history

  const totals = rows
    .map(r => { const u = JSON.parse(r.token_usage); return (u.input ?? 0) + (u.output ?? 0); })
    .sort((a, b) => a - b);

  return totals[Math.floor(totals.length / 2)];
}

export function getScoresByDateRange(
  roleId: string,
  startTs: number,
  endTs: number,
): RoleScoreRecord[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM role_scores WHERE role_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at ASC",
  ).all(roleId, startTs, endTs) as RoleScoreRow[];
  return rows.map(rowToRecord);
}

export function getLatestRoleScore(roleId: string): RoleScoreRecord | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM role_scores WHERE role_id = ? ORDER BY created_at DESC LIMIT 1").get(roleId) as RoleScoreRow | undefined;
  return row ? rowToRecord(row) : undefined;
}

/**
 * UPDATE an existing role_score row to add intent_fulfillment after the async LLM eval completes.
 * Recomputes weighted using 5-dim formula and recomputes EMA against the previous EMA.
 * Returns the new EMA, or undefined if no row exists for the task (e.g., race or missing task).
 */
export function updateRoleScoreWithIntent(
  taskId: string,
  intentFulfillment: number | null,
  intentFulfillmentFailed: boolean,
  computeWeighted: (s: Pick<TaskDimensionScores, "taskSuccess" | "planAccuracy" | "permissionCompliance" | "efficiency" | "intentFulfillment">) => number,
  emaAlpha: number,
): number | undefined {
  const db = getDb();
  // 1. Fetch the row + the previous-previous EMA (for re-deriving the EMA chain)
  const row = db.prepare("SELECT id, role_id, score_json FROM role_scores WHERE task_id = ?").get(taskId) as { id: string; role_id: string; score_json: string } | undefined;
  if (!row) return undefined;

  const scores = JSON.parse(row.score_json) as TaskDimensionScores;
  scores.intentFulfillment = intentFulfillment;
  scores.intentFulfillmentFailed = intentFulfillmentFailed;
  scores.weighted = computeWeighted(scores);

  // 2. Re-derive EMA: previousEma = the row immediately before this one for the same role.
  // Note: strict `created_at <` collapses to the seed branch when two rows share the same
  // millisecond. Same-ms inserts are extremely rare in practice; EMA perturbation is bounded.
  // If needed in the future, add a row-id tiebreaker on equal timestamps.
  const prev = db.prepare(
    "SELECT ema_score FROM role_scores WHERE role_id = ? AND created_at < (SELECT created_at FROM role_scores WHERE id = ?) ORDER BY created_at DESC LIMIT 1",
  ).get(row.role_id, row.id) as { ema_score: number } | undefined;
  const newEma = prev !== undefined
    ? emaAlpha * scores.weighted + (1 - emaAlpha) * prev.ema_score
    : scores.weighted;

  // 3. UPDATE the row
  db.prepare("UPDATE role_scores SET score_json = ?, ema_score = ? WHERE id = ?").run(
    JSON.stringify(scores), newEma, row.id,
  );

  return newEma;
}

/**
 * Query per-role per-task-type performance statistics.
 * Used as a secondary tiebreaker in role ranking (Task 5).
 */
export function getRoleTaskTypePerformance(roleId: string, taskType: string): {
  totalTasks: number;
  successRate: number;
  avgCostUsd: number;
  lastAttempt: number | null;
} {
  const db = getDb();
  const rows = db.prepare(`
    SELECT rs.score_json, t.cost_usd, t.completed_at, rs.created_at
    FROM role_scores rs
    JOIN tasks t ON t.id = rs.task_id
    WHERE rs.role_id = ? AND rs.task_type = ?
    ORDER BY rs.created_at DESC
  `).all(roleId, taskType) as Array<{
    score_json: string;
    cost_usd: number | null;
    completed_at: number | null;
    created_at: number;
  }>;

  if (rows.length === 0) {
    return { totalTasks: 0, successRate: 0, avgCostUsd: 0, lastAttempt: null };
  }

  const totalTasks = rows.length;
  const successes = rows.filter((r) => {
    const s = JSON.parse(r.score_json) as TaskDimensionScores;
    return s.taskSuccess === 1.0;
  }).length;
  const successRate = successes / totalTasks;
  const costs = rows.map((r) => r.cost_usd ?? 0);
  const avgCostUsd = costs.reduce((a, b) => a + b, 0) / totalTasks;
  const lastAttempt = rows[0]?.created_at ?? null;

  return { totalTasks, successRate, avgCostUsd, lastAttempt };
}

/**
 * Compute EMA of contract compliance scores for a role over the most recent `limit` rows.
 * Returns emaScore (null when no compliance data), recent violations, and row count.
 */
export function getRoleContractComplianceEma(roleId: string, limit = 50): {
  emaScore: number | null;
  recentViolations: AuditViolation[];
  contractsCheckedRowCount: number;
} {
  const rows = getScoresByRole(roleId, limit);
  const compliance = rows
    .map((r) => r.scores.contractCompliance)
    .filter((v): v is number => v !== null && v !== undefined);
  if (compliance.length === 0) {
    return { emaScore: null, recentViolations: getViolationsByRole(roleId, 10), contractsCheckedRowCount: 0 };
  }
  // EMA over chronological order (oldest first when reducing)
  const ordered = [...compliance].reverse();
  const ema = ordered.reduce((acc, v, idx) => idx === 0 ? v : EMA_ALPHA * v + (1 - EMA_ALPHA) * acc, 0);
  return { emaScore: ema, recentViolations: getViolationsByRole(roleId, 10), contractsCheckedRowCount: compliance.length };
}
