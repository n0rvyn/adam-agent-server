/**
 * TemplateExecution store: tracks runtime state for Template runs.
 */

import { getDb } from "./db.js";

export type TemplateExecutionStatus = "running" | "completed" | "failed" | "partial" | "cancelled";

export interface TemplateExecutionStepStatus {
  taskId: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled" | "no_content";
  /** Phase 4: set when a nudge retry produced a no_content marker artifact. */
  noContentReason?: string;
  roleId?: string;
  result?: string;
  error?: string;
  /** Phase 2: set to true when Layer B triggered a single retry-with-feedback. */
  contractRetried?: boolean;
  attempt?: number;
  maxAttempts?: number;
  retryReason?: "length" | "format" | "persona" | "verifier" | "transient" | "validator" | "nudge" | "race-rescue" | "customAssertions";
  /** Phase 4: set to true when a nudge dispatch was attempted for this step. */
  nudgeAttempted?: boolean;
  /** Phase 4: independent counter for validator-driven retries (budget separate from transient). */
  validatorAttempt?: number;
  originalTaskId?: string;
  retryTaskId?: string;
  warnings?: string[];
}

export interface TemplateExecution {
  id: string;
  templateId: string;
  status: TemplateExecutionStatus;
  stepStatuses: Record<string, TemplateExecutionStepStatus>;
  startedAt: number;
  completedAt?: number;
  error?: string;
  /** Event id that triggered this TemplateExecution, if any (set only for event-triggered dispatches). */
  eventId?: string;
  /** Phase 2 DP-001: serialized Map<stepId, StepResult> for post-hoc redelivery.
   *  Written at execution-complete; null if not yet persisted or execution predates Phase 2. */
  stepResultsJson?: string | null;
}

interface TemplateExecutionRow {
  id: string;
  template_id: string;
  status: string;
  step_statuses: string;
  started_at: number;
  completed_at: number | null;
  error: string | null;
  event_id: string | null;
  step_results_json: string | null;
}

function rowToTemplateExecution(row: TemplateExecutionRow): TemplateExecution {
  return {
    id: row.id,
    templateId: row.template_id,
    status: row.status as TemplateExecutionStatus,
    stepStatuses: JSON.parse(row.step_statuses) as Record<string, TemplateExecutionStepStatus>,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    eventId: row.event_id ?? undefined,
    stepResultsJson: row.step_results_json ?? undefined,
  };
}

export function createTemplateExecution(id: string, templateId: string, eventId?: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO template_executions (id, template_id, status, step_statuses, started_at, event_id)
    VALUES (?, ?, 'running', '{}', ?, ?)
  `).run(id, templateId, Date.now(), eventId ?? null);
}

export function getTemplateExecution(id: string): TemplateExecution | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM template_executions WHERE id = ?").get(id) as TemplateExecutionRow | undefined;
  return row ? rowToTemplateExecution(row) : undefined;
}

export function updateTemplateExecution(
  id: string,
  updates: Partial<Pick<TemplateExecution, "status" | "stepStatuses" | "completedAt" | "error">>,
): void {
  const db = getDb();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    setClauses.push("status = ?");
    values.push(updates.status);
  }
  if (updates.stepStatuses !== undefined) {
    setClauses.push("step_statuses = ?");
    values.push(JSON.stringify(updates.stepStatuses));
  }
  if (updates.completedAt !== undefined) {
    setClauses.push("completed_at = ?");
    values.push(updates.completedAt);
  }
  if (updates.error !== undefined) {
    setClauses.push("error = ?");
    values.push(updates.error);
  }

  if (setClauses.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE template_executions SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

/**
 * List running template_executions older than `olderThanMs`.
 * Used by Watchdog (#215) to find orphaned executions whose child tasks have
 * all reached terminal status while the execution row stayed 'running'.
 */
export function listStaleRunningExecutions(olderThanMs: number): TemplateExecution[] {
  const db = getDb();
  const cutoff = Date.now() - olderThanMs;
  const rows = db
    .prepare("SELECT * FROM template_executions WHERE status = 'running' AND started_at < ?")
    .all(cutoff) as TemplateExecutionRow[];
  return rows.map(rowToTemplateExecution);
}

export function listTemplateExecutions(
  templateId?: string,
  limit = 50,
  offset = 0,
): TemplateExecution[] {
  const db = getDb();
  let query = "SELECT * FROM template_executions";
  const params: unknown[] = [];

  if (templateId) {
    query += " WHERE template_id = ?";
    params.push(templateId);
  }

  query += " ORDER BY started_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const rows = db.prepare(query).all(...params) as TemplateExecutionRow[];
  return rows.map(rowToTemplateExecution);
}

/**
 * Enriched row returned by `listDispatchesByEventDef`: one TemplateExecution
 * joined with its triggering event and template name. Used by the Dispatches
 * tab on EventDef Detail (`GET /event-defs/:id/dispatches`).
 */
export interface EventDefDispatch {
  executionId: string;
  templateId: string;
  templateName: string | null;
  status: TemplateExecutionStatus;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  eventId: string;
  eventOccurredAt: string | null;
  eventPayload: Record<string, unknown> | null;
}

/**
 * List TemplateExecutions triggered by events belonging to a given EventDef.
 * Joins events + template_executions + task_templates.
 * Ordered newest first.
 */
export function listDispatchesByEventDef(
  eventDefId: string,
  limit = 20,
  offset = 0,
): EventDefDispatch[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT te.id AS execution_id,
           te.template_id,
           tt.name AS template_name,
           te.status,
           te.started_at,
           te.completed_at,
           te.error,
           te.event_id,
           e.occurred_at AS event_occurred_at,
           e.payload AS event_payload
    FROM template_executions te
    LEFT JOIN task_templates tt ON tt.id = te.template_id
    INNER JOIN events e ON e.id = te.event_id
    WHERE e.event_def_id = ?
    ORDER BY te.started_at DESC
    LIMIT ? OFFSET ?
  `).all(eventDefId, limit, offset) as Array<{
    execution_id: string;
    template_id: string;
    template_name: string | null;
    status: string;
    started_at: number;
    completed_at: number | null;
    error: string | null;
    event_id: string;
    event_occurred_at: string | null;
    event_payload: string | null;
  }>;
  return rows.map((r) => ({
    executionId: r.execution_id,
    templateId: r.template_id,
    templateName: r.template_name,
    status: r.status as TemplateExecutionStatus,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    error: r.error,
    eventId: r.event_id,
    eventOccurredAt: r.event_occurred_at,
    eventPayload: r.event_payload ? (JSON.parse(r.event_payload) as Record<string, unknown>) : null,
  }));
}

/**
 * Persist step results to the execution row for post-hoc redelivery (Phase 2 DP-001).
 * Serialised as an array of [stepId, StepResult] tuples — Map.entries() preserves
 * insertion order so step result sections appear in the same order as during execution.
 */
export function setExecutionStepResults(
  executionId: string,
  stepResults: Map<string, { stepId: string; taskId: string; status: "completed" | "failed" | "skipped" | "cancelled" | "no_content"; roleId?: string; roleName?: string; result?: string; error?: string }>,
): void {
  const serialized = JSON.stringify(Array.from(stepResults.entries()));
  getDb().prepare(`UPDATE template_executions SET step_results_json = ? WHERE id = ?`).run(serialized, executionId);
}
