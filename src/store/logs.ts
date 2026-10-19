import { getDb } from "./db.js";
import type { StepLog, StepLogType } from "../shared/types.js";
import { getCurrentTraceId } from "../lib/trace-context.js";

interface StepLogRow {
  id: string;
  task_id: string;
  index: number;
  type: string;
  content: string;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  truncated: number;
  timestamp: number;
  token_usage: string | null;
  plan_step_index: number | null;
  trace_id: string | null;
}

function rowToStepLog(row: StepLogRow): StepLog {
  return {
    id: row.id,
    taskId: row.task_id,
    index: row.index,
    type: row.type as StepLogType,
    content: row.content,
    toolName: row.tool_name ?? undefined,
    toolInput: row.tool_input ? JSON.parse(row.tool_input) : undefined,
    toolOutput: row.tool_output ?? undefined,
    truncated: row.truncated === 1,
    timestamp: row.timestamp,
    tokenUsage: row.token_usage ? JSON.parse(row.token_usage) : undefined,
    planStepIndex: row.plan_step_index ?? undefined,
    traceId: row.trace_id ?? undefined,
  };
}

export function createStepLog(log: StepLog): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO step_logs (id, task_id, "index", type, content, tool_name,
      tool_input, tool_output, truncated, timestamp, token_usage, plan_step_index, trace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    log.id,
    log.taskId,
    log.index,
    log.type,
    log.content,
    log.toolName ?? null,
    log.toolInput ? JSON.stringify(log.toolInput) : null,
    log.toolOutput ?? null,
    log.truncated ? 1 : 0,
    log.timestamp,
    log.tokenUsage ? JSON.stringify(log.tokenUsage) : null,
    log.planStepIndex ?? null,
    log.traceId ?? getCurrentTraceId() ?? null,
  );
}

export function getStepLogs(
  taskId: string,
  limit = 100,
  offset = 0,
): StepLog[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM step_logs WHERE task_id = ? ORDER BY "index" ASC LIMIT ? OFFSET ?`,
    )
    .all(taskId, limit, offset) as StepLogRow[];
  return rows.map(rowToStepLog);
}

export function getStepLogByIndex(
  taskId: string,
  index: number,
): StepLog | undefined {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM step_logs WHERE task_id = ? AND "index" = ?`)
    .get(taskId, index) as StepLogRow | undefined;
  return row ? rowToStepLog(row) : undefined;
}

export function deleteTaskLogs(taskId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM step_logs WHERE task_id = ?").run(taskId);
}
