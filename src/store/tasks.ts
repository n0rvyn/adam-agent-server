import { getDb } from "./db.js";
import type { Task, TaskStatus, TaskConfig } from "../shared/types.js";
import { getCurrentTraceId } from "../lib/trace-context.js";

interface TaskRow {
  id: string;
  parent_id: string | null;
  status: string;
  prompt: string;
  original_prompt: string | null;
  config: string;
  result: string | null;
  error: string | null;
  sdk_session_id: string | null;
  template_id: string | null;
  role_id: string | null;
  step_id: string | null;
  source_session_id: string | null;
  deliver_to: string | null;
  report_to: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  cost_usd: number | null;
  token_usage: string | null;
  num_turns: number | null;
  total_duration_ms: number | null;
  block_reason_json: string | null;
  trace_id: string | null;
  error_category: string | null;
  retry_count: number;
  cost_breakdown: string | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    parentId: row.parent_id ?? undefined,
    status: row.status as TaskStatus,
    prompt: row.prompt,
    originalPrompt: row.original_prompt ?? undefined,
    config: JSON.parse(row.config),
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    sdkSessionId: row.sdk_session_id ?? undefined,
    templateId: row.template_id ?? undefined,
    roleId: row.role_id ?? undefined,
    stepId: row.step_id ?? undefined,
    sourceSessionId: row.source_session_id ?? undefined,
    deliverTo: row.deliver_to ? JSON.parse(row.deliver_to) : undefined,
    reportTo: row.report_to ? JSON.parse(row.report_to) : undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    costBreakdown: row.cost_breakdown ? JSON.parse(row.cost_breakdown) : undefined,
    tokenUsage: row.token_usage ? JSON.parse(row.token_usage) : undefined,
    numTurns: row.num_turns ?? undefined,
    totalDurationMs: row.total_duration_ms ?? undefined,
    blockReason: row.block_reason_json ? JSON.parse(row.block_reason_json) : undefined,
    traceId: row.trace_id ?? undefined,
    errorCategory: row.error_category ?? undefined,
    retryCount: row.retry_count,
  };
}

export function createTask(task: Task): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO tasks (id, parent_id, status, prompt, original_prompt, config, result, error,
      sdk_session_id, template_id, role_id, step_id, source_session_id, notify_targets, deliver_to, report_to,
      created_at, started_at, completed_at,
      cost_usd, token_usage, num_turns, total_duration_ms, trace_id, error_category, retry_count, cost_breakdown)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.parentId ?? null,
    task.status,
    task.prompt,
    task.originalPrompt ?? null,
    JSON.stringify(task.config),
    task.result ?? null,
    task.error ?? null,
    task.sdkSessionId ?? null,
    task.templateId ?? null,
    task.roleId ?? null,
    task.stepId ?? null,
    task.sourceSessionId ?? null,
    null, // notify_targets: deprecated, kept for schema compatibility
    task.deliverTo ? JSON.stringify(task.deliverTo) : null,
    task.reportTo ? JSON.stringify(task.reportTo) : null,
    task.createdAt,
    task.startedAt ?? null,
    task.completedAt ?? null,
    task.costUsd ?? null,
    task.tokenUsage ? JSON.stringify(task.tokenUsage) : null,
    task.numTurns ?? null,
    task.totalDurationMs ?? null,
    task.traceId ?? getCurrentTraceId() ?? null,
    task.errorCategory ?? null,
    task.retryCount ?? 0,
    task.costBreakdown ? JSON.stringify(task.costBreakdown) : null,
  );
}

export function getTask(id: string): Task | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  return row ? rowToTask(row) : undefined;
}

export function updateTask(id: string, updates: Partial<Task>): void {
  const db = getDb();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  const fieldMap: Record<string, string> = {
    parentId: "parent_id",
    status: "status",
    prompt: "prompt",
    result: "result",
    error: "error",
    sdkSessionId: "sdk_session_id",
    templateId: "template_id",
    roleId: "role_id",
    stepId: "step_id",
    sourceSessionId: "source_session_id",
    originalPrompt: "original_prompt",
    startedAt: "started_at",
    completedAt: "completed_at",
    costUsd: "cost_usd",
    numTurns: "num_turns",
    totalDurationMs: "total_duration_ms",
    errorCategory: "error_category",
    retryCount: "retry_count",
  };

  for (const [tsKey, dbKey] of Object.entries(fieldMap)) {
    if (tsKey in updates) {
      setClauses.push(`${dbKey} = ?`);
      values.push((updates as Record<string, unknown>)[tsKey] ?? null);
    }
  }

  if ("config" in updates) {
    setClauses.push("config = ?");
    values.push(JSON.stringify(updates.config));
  }

  if ("tokenUsage" in updates) {
    setClauses.push("token_usage = ?");
    values.push(updates.tokenUsage ? JSON.stringify(updates.tokenUsage) : null);
  }

  if ("costBreakdown" in updates) {
    setClauses.push("cost_breakdown = ?");
    values.push(updates.costBreakdown ? JSON.stringify(updates.costBreakdown) : null);
  }

  if ("deliverTo" in updates) {
    setClauses.push("deliver_to = ?");
    values.push(updates.deliverTo ? JSON.stringify(updates.deliverTo) : null);
  }
  if ("reportTo" in updates) {
    setClauses.push("report_to = ?");
    values.push(updates.reportTo ? JSON.stringify(updates.reportTo) : null);
  }

  // blockReason requires custom JSON serialization (cannot go through fieldMap)
  if ("blockReason" in updates) {
    setClauses.push("block_reason_json = ?");
    values.push(updates.blockReason ? JSON.stringify(updates.blockReason) : null);
  }

  // contextMeta: inline JSON column (not inside the config JSON blob)
  if ("contextMeta" in updates) {
    setClauses.push("context_meta = ?");
    values.push(updates.contextMeta ? JSON.stringify(updates.contextMeta) : null);
  }

  if (setClauses.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE tasks SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

/**
 * Deep-merge a partial patch into the existing task.config JSON column.
 * Preserves all existing config fields; only updates the provided patch keys.
 */
export function updateTaskConfig(taskId: string, patch: Partial<TaskConfig>): void {
  const existing = getTask(taskId);
  if (!existing) return;
  const merged: TaskConfig = {
    ...(existing.config ?? {}),
    ...patch,
  };
  updateTask(taskId, { config: merged });
}

export function listTasks(
  status?: TaskStatus,
  limit = 100,
  offset = 0,
  roleId?: string,
): Task[] {
  const db = getDb();
  let query = "SELECT * FROM tasks";
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }
  if (roleId) {
    conditions.push("role_id = ?");
    params.push(roleId);
  }
  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }

  query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const rows = db.prepare(query).all(...params) as TaskRow[];
  return rows.map(rowToTask);
}

export function listTasksByParent(parentId: string): Task[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at ASC",
  ).all(parentId) as TaskRow[];
  return rows.map(rowToTask);
}

export function listTasksByDateRange(
  status: TaskStatus,
  startTs: number,
  endTs: number,
): Task[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM tasks WHERE status = ? AND completed_at >= ? AND completed_at <= ? ORDER BY completed_at",
  ).all(status, startTs, endTs) as TaskRow[];
  return rows.map(rowToTask);
}

/**
 * Get total cost in USD for tasks completed since a given timestamp.
 */
export function getTotalCostSince(sinceTs: number): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) as total FROM tasks WHERE completed_at >= ? AND cost_usd IS NOT NULL",
  ).get(sinceTs) as { total: number };
  return row.total;
}

export function deleteTask(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
}

export function getTaskTraceId(taskId: string): string | undefined {
  const db = getDb();
  const row = db.prepare("SELECT trace_id FROM tasks WHERE id = ?").get(taskId) as { trace_id: string | null } | undefined;
  return row?.trace_id ?? undefined;
}

/**
 * Increment the retry_count on a task by 1.
 * Returns the new retry_count value.
 */
export function incrementRetryCount(taskId: string): number {
  const db = getDb();
  db.prepare("UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?").run(taskId);
  const row = db.prepare("SELECT retry_count FROM tasks WHERE id = ?").get(taskId) as { retry_count: number } | undefined;
  return row?.retry_count ?? 1;
}

// ---------------------------------------------------------------------------
// delayed_retries CRUD
// ---------------------------------------------------------------------------

export interface DelayedRetry {
  id: string;
  taskId: string;
  retryAt: number;
  createdAt: number;
}

interface DelayedRetryRow {
  id: string;
  task_id: string;
  retry_at: number;
  created_at: number;
}

function rowToDelayedRetry(row: DelayedRetryRow): DelayedRetry {
  return {
    id: row.id,
    taskId: row.task_id,
    retryAt: row.retry_at,
    createdAt: row.created_at,
  };
}

/**
 * Insert a new delayed retry entry.
 */
export function createDelayedRetry(entry: DelayedRetry): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO delayed_retries (id, task_id, retry_at, created_at) VALUES (?, ?, ?, ?)",
  ).run(entry.id, entry.taskId, entry.retryAt, entry.createdAt);
}

/**
 * Fetch all delayed retry entries where retry_at <= now.
 * Ordered by retry_at ASC so earliest retries are processed first.
 */
export function getDueDelayedRetries(now: number): DelayedRetry[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM delayed_retries WHERE retry_at <= ? ORDER BY retry_at ASC",
  ).all(now) as DelayedRetryRow[];
  return rows.map(rowToDelayedRetry);
}

/**
 * Delete a delayed retry entry by id.
 */
export function deleteDelayedRetry(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM delayed_retries WHERE id = ?").run(id);
}

/**
 * Delete all delayed retry entries for a given task.
 */
export function deleteDelayedRetryByTaskId(taskId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM delayed_retries WHERE task_id = ?").run(taskId);
}

// ---------------------------------------------------------------------------
// context_meta helpers (Phase 2 — retrieval attribution + Phase 4 — workspace snapshot)
// ---------------------------------------------------------------------------

interface ContextMetaRow {
  context_meta: string | null;
}

/** Read+widen shape of the JSON. usedMemoryIds, startSnapshot, and any future sibling keys are optional. */
export type ContextMeta = {
  usedMemoryIds?: string[];
  startSnapshot?: unknown;
  [otherKey: string]: unknown;
};

/**
 * Atomic read-modify-write helper for tasks.context_meta.
 *
 * This is the ONLY supported way to mutate context_meta. Direct
 * `UPDATE tasks SET context_meta = '{...}'` writes clobber sibling keys and have
 * historically caused data loss (e.g. startSnapshot wiped by appendUsedMemoryIds before
 * it was refactored).
 *
 * The patcher mutates the parsed object in place (or returns a new object). The full
 * resulting object is serialized + written back atomically inside a transaction so
 * concurrent callers (e.g. reflection-job and SDK hook racing on the same task) cannot
 * lose each other's updates via interleaved read/write.
 *
 * Patcher contract:
 * - May add, remove, or modify any keys
 * - Must not throw (caller catches at higher level if needed)
 * - Should be idempotent if called multiple times under retry
 *
 * No-op if the patcher leaves the object empty AND the original column was already null/empty.
 */
export function updateContextMeta(
  taskId: string,
  patcher: (parsed: ContextMeta) => void,
): void {
  const db = getDb();
  db.transaction(() => {
    const row = db.prepare("SELECT context_meta FROM tasks WHERE id = ?").get(taskId) as ContextMetaRow | undefined;
    const parsed: ContextMeta = (() => {
      if (row?.context_meta) {
        try { return JSON.parse(row.context_meta) as ContextMeta; } catch { return {}; }
      }
      return {};
    })();
    patcher(parsed);
    db.prepare("UPDATE tasks SET context_meta = ? WHERE id = ?").run(JSON.stringify(parsed), taskId);
  })();
}

/**
 * Read the context_meta JSON from a task row.
 * Returns null if the column is null or the JSON is malformed.
 * Widened return type covers both usedMemoryIds (Phase 2) and startSnapshot (Phase 4) + future siblings.
 */
export function getContextMeta(taskId: string): ContextMeta | null {
  const db = getDb();
  const row = db.prepare("SELECT context_meta FROM tasks WHERE id = ?").get(taskId) as ContextMetaRow | undefined;
  if (!row || row.context_meta === null) return null;
  try {
    return JSON.parse(row.context_meta) as ContextMeta;
  } catch {
    return null;
  }
}

/**
 * Append used belief IDs to a task's context_meta, deduplicating against
 * any IDs already recorded (DP-002: append + dedupe).
 * Routed through updateContextMeta — sibling keys preserved + write is atomic.
 * No-op if newIds is empty.
 */
export function appendUsedMemoryIds(taskId: string, newIds: string[]): void {
  if (newIds.length === 0) return;
  updateContextMeta(taskId, (parsed) => {
    const existing = Array.isArray(parsed.usedMemoryIds) ? parsed.usedMemoryIds : [];
    parsed.usedMemoryIds = Array.from(new Set([...existing, ...newIds]));
  });
}

/**
 * Read the persisted startSnapshot from context_meta, or null if absent/malformed.
 * Returns the compact tuple array form (SnapshotTuple[] from workspace-snapshot).
 */
export function getStartSnapshot(
  taskId: string,
): Array<[string, string, number, string]> | null {
  const db = getDb();
  const row = db.prepare("SELECT context_meta FROM tasks WHERE id = ?").get(taskId) as ContextMetaRow | undefined;
  if (!row?.context_meta) return null;
  try {
    const parsed = JSON.parse(row.context_meta) as Record<string, unknown>;
    return Array.isArray(parsed.startSnapshot)
      ? (parsed.startSnapshot as Array<[string, string, number, string]>)
      : null;
  } catch {
    return null;
  }
}
