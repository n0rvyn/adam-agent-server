import { getDb } from "./db.js";
import type { Trial } from "../shared/types.js";

interface TrialRow {
  id: string;
  strategy_id: string;
  goal_id: string;
  task_id: string | null;
  reward: number | null;
  metric_l2_score: number | null;
  metric_l3_score: number | null;
  context: string | null;
  completed_at: number;
}

function rowToTrial(row: TrialRow): Trial {
  return {
    id: row.id,
    strategyId: row.strategy_id,
    goalId: row.goal_id,
    taskId: row.task_id ?? undefined,
    reward: row.reward ?? undefined,
    metricL2Score: row.metric_l2_score ?? undefined,
    metricL3Score: row.metric_l3_score ?? undefined,
    context: row.context ?? undefined,
    completedAt: row.completed_at,
  };
}

export function createTrial(trial: Trial): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO trials (id, strategy_id, goal_id, task_id, reward,
      metric_l2_score, metric_l3_score, context, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trial.id,
    trial.strategyId,
    trial.goalId,
    trial.taskId ?? null,
    trial.reward ?? null,
    trial.metricL2Score ?? null,
    trial.metricL3Score ?? null,
    trial.context ?? null,
    trial.completedAt,
  );
}

export function getTrial(id: string): Trial | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM trials WHERE id = ?").get(id) as TrialRow | undefined;
  return row ? rowToTrial(row) : undefined;
}

export function listTrialsByStrategy(strategyId: string, limit = 100): Trial[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM trials WHERE strategy_id = ? ORDER BY completed_at DESC LIMIT ?",
  ).all(strategyId, limit) as TrialRow[];
  return rows.map(rowToTrial);
}

export function listTrialsByGoal(goalId: string, limit = 100): Trial[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM trials WHERE goal_id = ? ORDER BY completed_at DESC LIMIT ?",
  ).all(goalId, limit) as TrialRow[];
  return rows.map(rowToTrial);
}

export function listTrialsByTask(taskId: string): Trial[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM trials WHERE task_id = ? ORDER BY completed_at DESC",
  ).all(taskId) as TrialRow[];
  return rows.map(rowToTrial);
}
