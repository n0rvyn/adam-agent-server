import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";

interface TaskPluginRow {
  id: string;
  task_id: string;
  plugin_path: string;
  plugin_name: string;
  role_id: string | null;
  used_at: number;
}

export interface TaskPlugin {
  id: string;
  taskId: string;
  pluginPath: string;
  pluginName: string;
  roleId?: string;
  usedAt: number;
}

function rowToTaskPlugin(row: TaskPluginRow): TaskPlugin {
  return {
    id: row.id,
    taskId: row.task_id,
    pluginPath: row.plugin_path,
    pluginName: row.plugin_name,
    roleId: row.role_id ?? undefined,
    usedAt: row.used_at,
  };
}

export function recordTaskPlugins(taskId: string, plugins: string[], roleId?: string): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO task_plugins (id, task_id, plugin_path, plugin_name, role_id, used_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const now = Date.now();
  for (const pluginPath of plugins) {
    const pluginName = pluginPath.split("/").pop() ?? pluginPath;
    stmt.run(randomUUID(), taskId, pluginPath, pluginName, roleId ?? null, now);
  }
}

export function getTaskPlugins(taskId: string): TaskPlugin[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM task_plugins WHERE task_id = ? ORDER BY used_at",
  ).all(taskId) as TaskPluginRow[];
  return rows.map(rowToTaskPlugin);
}

export function getPluginUsageByRole(roleId: string): { pluginName: string; usageCount: number }[] {
  const db = getDb();
  return db.prepare(`
    SELECT plugin_name as pluginName, COUNT(*) as usageCount
    FROM task_plugins
    WHERE role_id = ?
    GROUP BY plugin_path
    ORDER BY usageCount DESC
  `).all(roleId) as { pluginName: string; usageCount: number }[];
}

export function getPluginUsageStats(limit = 50): { pluginPath: string; pluginName: string; usageCount: number; lastUsed: number }[] {
  const db = getDb();
  return db.prepare(`
    SELECT plugin_path as pluginPath, plugin_name as pluginName, COUNT(*) as usageCount, MAX(used_at) as lastUsed
    FROM task_plugins
    GROUP BY plugin_path
    ORDER BY usageCount DESC
    LIMIT ?
  `).all(limit) as { pluginPath: string; pluginName: string; usageCount: number; lastUsed: number }[];
}
