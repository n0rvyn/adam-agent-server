import { getDb } from "./db.js";
import type { DeliveryLogEntry, DeliveryStatus, DeliveryTarget } from "../shared/types.js";
import { getCurrentTraceId } from "../lib/trace-context.js";

interface DeliveryLogRow {
  id: string;
  rule_id: string | null;
  task_id: string | null;
  execution_id: string | null;
  status: string;
  target: string;
  content: string;
  attempts: number;
  error: string | null;
  created_at: number;
  delivered_at: number | null;
  expires_at: number;
  source: string | null;
  message_type: string | null;
  trace_id: string | null;
}

function rowToEntry(row: DeliveryLogRow): DeliveryLogEntry {
  return {
    id: row.id,
    ruleId: row.rule_id ?? undefined,
    taskId: row.task_id ?? undefined,
    executionId: row.execution_id ?? undefined,
    status: row.status as DeliveryStatus,
    target: JSON.parse(row.target) as DeliveryTarget,
    content: row.content,
    attempts: row.attempts,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? undefined,
    expiresAt: row.expires_at,
    source: row.source as DeliveryLogEntry["source"],
    messageType: row.message_type ?? undefined,
    traceId: row.trace_id ?? undefined,
  };
}

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function createDeliveryLog(entry: DeliveryLogEntry): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO delivery_log (id, rule_id, task_id, execution_id, status, target, content,
      attempts, error, created_at, delivered_at, expires_at, source, message_type, trace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.id,
    entry.ruleId ?? null,
    entry.taskId ?? null,
    entry.executionId ?? null,
    entry.status,
    JSON.stringify(entry.target),
    entry.content,
    entry.attempts,
    entry.error ?? null,
    entry.createdAt,
    entry.deliveredAt ?? null,
    entry.expiresAt,
    entry.source ?? null,
    entry.messageType ?? null,
    entry.traceId ?? getCurrentTraceId() ?? null,
  );
}

export function updateDeliveryLogStatus(
  id: string,
  status: DeliveryStatus,
  error?: string,
): void {
  const db = getDb();
  db.prepare("UPDATE delivery_log SET status = ?, error = ?, attempts = attempts + 1 WHERE id = ?")
    .run(status, error ?? null, id);
}

export function markDelivered(id: string): void {
  const db = getDb();
  db.prepare("UPDATE delivery_log SET status = 'delivered', delivered_at = ?, attempts = attempts + 1 WHERE id = ?")
    .run(Date.now(), id);
}

export function getPendingDeliveries(source?: string, limit = 100): DeliveryLogEntry[] {
  const db = getDb();
  const now = Date.now();
  const sql = source
    ? "SELECT * FROM delivery_log WHERE status = 'pending' AND expires_at > ? AND source = ? ORDER BY created_at ASC LIMIT ?"
    : "SELECT * FROM delivery_log WHERE status = 'pending' AND expires_at > ? ORDER BY created_at ASC LIMIT ?";
  const rows = source
    ? db.prepare(sql).all(now, source, limit) as DeliveryLogRow[]
    : db.prepare(sql).all(now, limit) as DeliveryLogRow[];
  return rows.map(rowToEntry);
}

export function getFailedDeliveries(source?: string, limit = 100): DeliveryLogEntry[] {
  const db = getDb();
  const now = Date.now();
  const sql = source
    ? "SELECT * FROM delivery_log WHERE status = 'failed' AND expires_at > ? AND attempts < 3 AND source = ? ORDER BY created_at ASC LIMIT ?"
    : "SELECT * FROM delivery_log WHERE status = 'failed' AND expires_at > ? AND attempts < 3 ORDER BY created_at ASC LIMIT ?";
  const rows = source
    ? db.prepare(sql).all(now, source, limit) as DeliveryLogRow[]
    : db.prepare(sql).all(now, limit) as DeliveryLogRow[];
  return rows.map(rowToEntry);
}

export function cleanupExpired(): number {
  const db = getDb();
  const now = Date.now();
  const result = db.prepare(
    "DELETE FROM delivery_log WHERE expires_at < ? AND status IN ('pending', 'failed')",
  ).run(now);
  return result.changes;
}

export function getDeliveryLogByTask(taskId: string, limit = 50): DeliveryLogEntry[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM delivery_log WHERE task_id = ? ORDER BY created_at DESC LIMIT ?",
  ).all(taskId, limit) as DeliveryLogRow[];
  return rows.map(rowToEntry);
}

export function getDeliveryLogByRule(ruleId: string, limit = 50): DeliveryLogEntry[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM delivery_log WHERE rule_id = ? ORDER BY created_at DESC LIMIT ?",
  ).all(ruleId, limit) as DeliveryLogRow[];
  return rows.map(rowToEntry);
}

export function getDeliveryLogByExecution(executionId: string, limit = 50): DeliveryLogEntry[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM delivery_log WHERE execution_id = ? ORDER BY created_at DESC LIMIT ?",
  ).all(executionId, limit) as DeliveryLogRow[];
  return rows.map(rowToEntry);
}

export function getLatestDeliveryForContext(args: { taskId?: string; traceId?: string }): DeliveryLogEntry | null {
  const db = getDb();
  if (!args.taskId && !args.traceId) return null;

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (args.taskId) {
    clauses.push("task_id = ?");
    params.push(args.taskId);
  }
  if (args.traceId) {
    clauses.push("trace_id = ?");
    params.push(args.traceId);
  }

  const rows = db.prepare(
    `SELECT * FROM delivery_log WHERE ${clauses.join(" OR ")} ORDER BY created_at DESC LIMIT 1`,
  ).all(...params) as DeliveryLogRow[];
  return rows.length > 0 ? rowToEntry(rows[0]) : null;
}

export { TTL_MS };
