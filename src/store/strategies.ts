import { getDb } from "./db.js";
import type { Strategy } from "../shared/types.js";

interface StrategyRow {
  id: string;
  role_id: string;
  task_type: string;
  name: string;
  prompt_template: string;
  alpha: number;
  beta: number;
  total_trials: number;
  avg_reward: number | null;
  created_at: number;
  updated_at: number | null;
}

function rowToStrategy(row: StrategyRow): Strategy {
  return {
    id: row.id,
    roleId: row.role_id,
    taskType: row.task_type,
    name: row.name,
    promptTemplate: row.prompt_template,
    alpha: row.alpha,
    beta: row.beta,
    totalTrials: row.total_trials,
    avgReward: row.avg_reward ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
  };
}

export function createStrategy(strategy: Strategy): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO strategies (id, role_id, task_type, name, prompt_template,
      alpha, beta, total_trials, avg_reward, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    strategy.id,
    strategy.roleId,
    strategy.taskType,
    strategy.name,
    strategy.promptTemplate,
    strategy.alpha,
    strategy.beta,
    strategy.totalTrials,
    strategy.avgReward ?? null,
    strategy.createdAt,
    strategy.updatedAt ?? null,
  );
}

export function getStrategy(id: string): Strategy | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM strategies WHERE id = ?").get(id) as StrategyRow | undefined;
  return row ? rowToStrategy(row) : undefined;
}

export function updateStrategy(id: string, updates: Partial<Strategy>): void {
  const db = getDb();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  const fieldMap: Record<string, string> = {
    name: "name",
    promptTemplate: "prompt_template",
    alpha: "alpha",
    beta: "beta",
    totalTrials: "total_trials",
    avgReward: "avg_reward",
    updatedAt: "updated_at",
  };

  for (const [tsKey, dbKey] of Object.entries(fieldMap)) {
    if (tsKey in updates) {
      setClauses.push(`${dbKey} = ?`);
      values.push((updates as Record<string, unknown>)[tsKey] ?? null);
    }
  }

  if (setClauses.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE strategies SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

export function listStrategies(limit = 100): Strategy[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM strategies ORDER BY created_at LIMIT ?").all(limit) as StrategyRow[];
  return rows.map(rowToStrategy);
}

export function listStrategiesByRole(roleId: string): Strategy[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM strategies WHERE role_id = ? ORDER BY created_at").all(roleId) as StrategyRow[];
  return rows.map(rowToStrategy);
}

export function listStrategiesByTaskType(roleId: string, taskType: string): Strategy[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM strategies WHERE role_id = ? AND task_type = ? ORDER BY created_at").all(roleId, taskType) as StrategyRow[];
  return rows.map(rowToStrategy);
}

export function deleteStrategy(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM strategies WHERE id = ?").run(id);
}

/**
 * Update Beta distribution parameters after a trial.
 * Uses additive update: alpha += reward, beta += (1 - reward).
 * Jeffreys prior: initial alpha=0.5, beta=0.5 (DP-002).
 */
export function betaUpdate(strategyId: string, reward: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE strategies
    SET alpha = alpha + ?,
        beta = beta + ?,
        total_trials = total_trials + 1,
        avg_reward = CASE
          WHEN total_trials = 0 THEN ?
          ELSE (avg_reward * total_trials + ?) / (total_trials + 1)
        END,
        updated_at = ?
    WHERE id = ?
  `).run(reward, 1 - reward, reward, reward, Date.now(), strategyId);
}
