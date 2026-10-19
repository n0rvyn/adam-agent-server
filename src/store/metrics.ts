import { getDb } from "./db.js";
import type { MetricNode, MetricLevel } from "../shared/types.js";

interface MetricRow {
  id: string;
  goal_id: string;
  level: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  weight: number;
  calibration_factor: number;
  created_at: number;
}

function rowToMetricNode(row: MetricRow): MetricNode {
  return {
    id: row.id,
    goalId: row.goal_id,
    level: row.level as MetricLevel,
    parentId: row.parent_id ?? undefined,
    name: row.name,
    description: row.description ?? undefined,
    weight: row.weight,
    calibrationFactor: row.calibration_factor,
    createdAt: row.created_at,
  };
}

export function createMetricNode(node: MetricNode): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO metric_tree (id, goal_id, level, parent_id, name, description,
      weight, calibration_factor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    node.id,
    node.goalId,
    node.level,
    node.parentId ?? null,
    node.name,
    node.description ?? null,
    node.weight,
    node.calibrationFactor,
    node.createdAt,
  );
}

export function getMetricNode(id: string): MetricNode | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM metric_tree WHERE id = ?").get(id) as MetricRow | undefined;
  return row ? rowToMetricNode(row) : undefined;
}

export function updateMetricNode(id: string, updates: Partial<MetricNode>): void {
  const db = getDb();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  const fieldMap: Record<string, string> = {
    name: "name",
    description: "description",
    weight: "weight",
    calibrationFactor: "calibration_factor",
    parentId: "parent_id",
  };

  for (const [tsKey, dbKey] of Object.entries(fieldMap)) {
    if (tsKey in updates) {
      setClauses.push(`${dbKey} = ?`);
      values.push((updates as Record<string, unknown>)[tsKey] ?? null);
    }
  }

  if (setClauses.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE metric_tree SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

export function listMetricsByGoal(goalId: string): MetricNode[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM metric_tree WHERE goal_id = ? ORDER BY level, created_at").all(goalId) as MetricRow[];
  return rows.map(rowToMetricNode);
}

export function listMetricsByParent(parentId: string): MetricNode[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM metric_tree WHERE parent_id = ? ORDER BY created_at").all(parentId) as MetricRow[];
  return rows.map(rowToMetricNode);
}

export function deleteMetricNode(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM metric_tree WHERE id = ?").run(id);
}
