import { getDb } from "./db.js";
import type { Goal, GoalStatus } from "../shared/types.js";

interface GoalRow {
  id: string;
  name: string;
  description: string | null;
  role: string;
  metric_type: string;
  target_value: number;
  current_value: number;
  deadline: number;
  budget_usd: number;
  status: string;
  created_at: number;
  updated_at: number | null;
  source_session_id: string | null;
  notify_targets: string | null;
  deliver_to: string | null;
  report_to: string | null;
}

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    roleId: row.role,
    metricType: row.metric_type,
    targetValue: row.target_value,
    currentValue: row.current_value,
    deadline: row.deadline,
    budgetUsd: row.budget_usd,
    status: row.status as GoalStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
    sourceSessionId: row.source_session_id ?? undefined,
    deliverTo: row.deliver_to ? JSON.parse(row.deliver_to) : undefined,
    reportTo: row.report_to ? JSON.parse(row.report_to) : undefined,
  };
}

export function createGoal(goal: Goal): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO goals (id, name, description, role, metric_type, target_value,
      current_value, deadline, budget_usd, status, created_at, updated_at,
      source_session_id, deliver_to, report_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    goal.id,
    goal.name,
    goal.description ?? null,
    goal.roleId,
    goal.metricType,
    goal.targetValue,
    goal.currentValue,
    goal.deadline,
    goal.budgetUsd,
    goal.status,
    goal.createdAt,
    goal.updatedAt ?? null,
    goal.sourceSessionId ?? null,
    goal.deliverTo ? JSON.stringify(goal.deliverTo) : null,
    goal.reportTo ? JSON.stringify(goal.reportTo) : null,
  );
}

export function getGoal(id: string): Goal | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as GoalRow | undefined;
  return row ? rowToGoal(row) : undefined;
}

export function updateGoal(id: string, updates: Partial<Goal>): void {
  const db = getDb();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  const fieldMap: Record<string, string> = {
    name: "name",
    description: "description",
    roleId: "role",
    metricType: "metric_type",
    targetValue: "target_value",
    currentValue: "current_value",
    deadline: "deadline",
    budgetUsd: "budget_usd",
    status: "status",
    updatedAt: "updated_at",
    sourceSessionId: "source_session_id",
  };

  for (const [tsKey, dbKey] of Object.entries(fieldMap)) {
    if (tsKey in updates) {
      setClauses.push(`${dbKey} = ?`);
      values.push((updates as Record<string, unknown>)[tsKey] ?? null);
    }
  }

  if ("deliverTo" in updates) {
    setClauses.push("deliver_to = ?");
    values.push(JSON.stringify((updates as Record<string, unknown>)["deliverTo"]));
  }
  if ("reportTo" in updates) {
    setClauses.push("report_to = ?");
    values.push(JSON.stringify((updates as Record<string, unknown>)["reportTo"]));
  }

  if (setClauses.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE goals SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

export function listGoals(status?: GoalStatus, limit = 100, offset = 0): Goal[] {
  const db = getDb();
  let query = "SELECT * FROM goals";
  const params: unknown[] = [];

  if (status) {
    query += " WHERE status = ?";
    params.push(status);
  }

  query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const rows = db.prepare(query).all(...params) as GoalRow[];
  return rows.map(rowToGoal);
}

export function deleteGoal(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM goals WHERE id = ?").run(id);
}
