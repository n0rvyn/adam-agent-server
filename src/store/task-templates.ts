import { getDb } from "./db.js";
import { getRole } from "./roles.js";
import type { TaskTemplate, TaskTemplateTrigger, TaskStep, TaskConfig } from "../shared/types.js";
import { STEP_ID_REGEX } from "../lib/tool-schemas.js";
import { removeTemplateExecutionArtifactsDir } from "../lib/artifact-storage.js";
import { snapshotTemplateVersion } from "./template-versions.js";

export type DeleteTemplateMode = "template_only" | "with_tasks";

export interface TaskTemplateDependents {
  executionCount: number;
  taskCount: number;
}

/** Strip the "event:" prefix from a trigger_event value to recover the eventDefId. */
function stripEventPrefix(triggerEvent: string | null): string | undefined {
  if (!triggerEvent) return undefined;
  return triggerEvent.startsWith("event:") ? triggerEvent.slice(6) : undefined;
}

/**
 * Structured error thrown by `validateTemplateRoleConfig`.
 * REST/MCP layers catch this and return a `TEMPLATE_INVALID_ROLE_CONFIG` response.
 */
export type TemplateRoleConfigErrorCode =
  | "TEMPLATE_INVALID_ROLE_CONFIG"
  | "STEP_AUTOSELECT_NEEDS_REQUIREMENTS"
  | "STEP_ROLE_NOT_FOUND";

export type TemplateValidationErrorCode =
  | "TEMPLATE_STEPS_REQUIRED"
  | "TEMPLATE_STEP_ID_INVALID"
  | "TEMPLATE_STEP_ID_DUPLICATE"
  | "TEMPLATE_DEPENDENCY_UNKNOWN"
  | "TEMPLATE_DEPENDENCY_SELF"
  | "TEMPLATE_DEPENDENCY_CYCLE"
  | "TEMPLATE_TRIGGER_INVALID"
  | "TEMPLATE_MIN_DEPENDENCIES_INVALID"
  | "TEMPLATE_MIN_DEPENDENCIES_EXCEEDS";

export class TemplateValidationError extends Error {
  constructor(
    public readonly code: TemplateValidationErrorCode,
    message: string,
    public readonly failingStepIds: string[] = [],
  ) {
    super(message);
    this.name = "TemplateValidationError";
  }
}

export class TemplateRoleConfigError extends Error {
  constructor(
    public readonly code: TemplateRoleConfigErrorCode,
    public readonly failingStepIds: string[],
  ) {
    super(buildTemplateRoleConfigErrorMessage(code, failingStepIds));
    this.name = "TemplateRoleConfigError";
  }
}

function buildTemplateRoleConfigErrorMessage(
  code: TemplateRoleConfigErrorCode,
  failingStepIds: string[],
): string {
  if (code === "STEP_AUTOSELECT_NEEDS_REQUIREMENTS") {
    return (
      `Template has ${failingStepIds.length} step(s) with autoSelectRole=true but no requirements object. ` +
      `Failing step ids: ${failingStepIds.join(", ")}`
    );
  }
  if (code === "STEP_ROLE_NOT_FOUND") {
    return (
      `Template has ${failingStepIds.length} step(s) with a roleId that does not resolve to an active role. ` +
      `Failing step ids: ${failingStepIds.join(", ")}`
    );
  }
  return (
    `Template has ${failingStepIds.length} step(s) without executable role config. ` +
    `Set template.rolePreference, OR set each failing step's roleId, OR set autoSelectRole=true. ` +
    `Failing step ids: ${failingStepIds.join(", ")}`
  );
}

function hasExecutableRoleSource(step: TaskStep): boolean {
  const hasRole = typeof step.roleId === "string" && step.roleId.length > 0;
  const hasAutoSelect = step.autoSelectRole === true;
  return hasRole || hasAutoSelect;
}

function getStepValidationError(step: TaskStep): { code: Exclude<TemplateRoleConfigErrorCode, "TEMPLATE_INVALID_ROLE_CONFIG">; stepId: string } | null {
  if (typeof step.roleId === "string" && step.roleId.length > 0) {
    const role = getRole(step.roleId);
    if (!role || role.status !== "active") {
      return { code: "STEP_ROLE_NOT_FOUND", stepId: step.id };
    }
  }

  if (step.autoSelectRole === true && step.requirements == null) {
    return { code: "STEP_AUTOSELECT_NEEDS_REQUIREMENTS", stepId: step.id };
  }

  return null;
}

/**
 * Validate that a template can actually be dispatched without admission failure.
 *
 * Mirrors `template-executor.ts` step resolution (`step.roleId ?? context.rolePreference`)
 * and `task-admission.ts:263` requirement (roleId OR autoSelectRole).
 *
 * Passes iff template.rolePreference is set OR every step satisfies
 * (step.roleId set OR step.autoSelectRole === true).
 *
 * A mixed template (step1.roleId=X + step2.autoSelectRole=true + no rolePreference)
 * is valid and accepted.
 */
export function validateTemplateRoleConfig(
  template: Pick<TaskTemplate, "rolePreference" | "steps">,
): void {
  if (!template.rolePreference) {
    const failingStepIds: string[] = [];
    for (const step of template.steps) {
      if (!hasExecutableRoleSource(step)) {
        failingStepIds.push(step.id);
      }
    }
    if (failingStepIds.length > 0) {
      throw new TemplateRoleConfigError("TEMPLATE_INVALID_ROLE_CONFIG", failingStepIds);
    }
  }

  const validationErrors = template.steps
    .map((step) => getStepValidationError(step))
    .filter((error): error is NonNullable<typeof error> => error !== null);

  if (validationErrors.length > 0) {
    const firstCode = validationErrors[0].code;
    const failingStepIds = validationErrors
      .filter((error) => error.code === firstCode)
      .map((error) => error.stepId);
    throw new TemplateRoleConfigError(firstCode, failingStepIds);
  }
}

export function validateTemplateDefinition(
  template: Pick<TaskTemplate, "rolePreference" | "steps">,
): void {
  if (!Array.isArray(template.steps) || template.steps.length < 1) {
    throw new TemplateValidationError(
      "TEMPLATE_STEPS_REQUIRED",
      "Template must contain at least one step.",
    );
  }

  const seenStepIds = new Set<string>();
  const duplicateStepIds: string[] = [];
  const invalidStepIds: string[] = [];
  for (const step of template.steps) {
    if (
      typeof step.id !== "string" ||
      step.id.length < 1 ||
      step.id.length > 128 ||
      !STEP_ID_REGEX.test(step.id)
    ) {
      invalidStepIds.push(step.id);
    }
    if (seenStepIds.has(step.id)) {
      duplicateStepIds.push(step.id);
    }
    seenStepIds.add(step.id);
  }
  if (invalidStepIds.length > 0) {
    throw new TemplateValidationError(
      "TEMPLATE_STEP_ID_INVALID",
      `Template has invalid step id(s): ${invalidStepIds.join(", ")}. Step ids must be 1-128 chars: letters, digits, dots, underscores, or dashes.`,
      invalidStepIds,
    );
  }
  if (duplicateStepIds.length > 0) {
    throw new TemplateValidationError(
      "TEMPLATE_STEP_ID_DUPLICATE",
      `Template has duplicate step id(s): ${duplicateStepIds.join(", ")}.`,
      duplicateStepIds,
    );
  }

  const dependencyMap = new Map<string, string[]>();
  for (const step of template.steps) {
    const dependsOn = step.dependsOn ?? [];
    dependencyMap.set(step.id, dependsOn);
    for (const depId of dependsOn) {
      if (depId === step.id) {
        throw new TemplateValidationError(
          "TEMPLATE_DEPENDENCY_SELF",
          `Template step "${step.id}" cannot depend on itself.`,
          [step.id],
        );
      }
      if (!seenStepIds.has(depId)) {
        throw new TemplateValidationError(
          "TEMPLATE_DEPENDENCY_UNKNOWN",
          `Template step "${step.id}" depends on unknown step "${depId}".`,
          [step.id],
        );
      }
    }
    // Validate minDependencies range
    if (step.minDependencies !== undefined) {
      if (!Number.isInteger(step.minDependencies) || step.minDependencies < 1) {
        throw new TemplateValidationError(
          "TEMPLATE_MIN_DEPENDENCIES_INVALID",
          `Step "${step.id}": minDependencies must be a positive integer`,
          [step.id],
        );
      }
      const depCount = step.dependsOn?.length ?? 0;
      if (step.minDependencies > depCount) {
        throw new TemplateValidationError(
          "TEMPLATE_MIN_DEPENDENCIES_EXCEEDS",
          `Step "${step.id}": minDependencies (${step.minDependencies}) exceeds dependsOn length (${depCount})`,
          [step.id],
        );
      }
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (stepId: string, path: string[]): string[] | null => {
    if (visiting.has(stepId)) {
      return [...path, stepId];
    }
    if (visited.has(stepId)) return null;
    visiting.add(stepId);
    for (const depId of dependencyMap.get(stepId) ?? []) {
      const cycle = visit(depId, [...path, stepId]);
      if (cycle) return cycle;
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return null;
  };

  for (const step of template.steps) {
    const cycle = visit(step.id, []);
    if (cycle) {
      throw new TemplateValidationError(
        "TEMPLATE_DEPENDENCY_CYCLE",
        `Template step dependencies contain a cycle: ${cycle.join(" -> ")}.`,
        [...new Set(cycle)],
      );
    }
  }

  validateTemplateRoleConfig(template);
}

function validateTemplateTrigger(trigger: TaskTemplateTrigger): void {
  if (
    trigger.type !== "cron" &&
    trigger.type !== "manual" &&
    trigger.type !== "once" &&
    trigger.type !== "template_complete" &&
    trigger.type !== "event"
  ) {
    throw new TemplateValidationError(
      "TEMPLATE_TRIGGER_INVALID",
      `Template trigger type is not supported: ${String(trigger.type)}.`,
    );
  }

  if (trigger.type === "template_complete" && !/^template_complete:[\w-]+$/.test(trigger.event ?? "")) {
    throw new TemplateValidationError(
      "TEMPLATE_TRIGGER_INVALID",
      "Template completion trigger event must use 'template_complete:<templateId>'.",
    );
  }
}

interface TaskTemplateRow {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_cron: string | null;
  trigger_event: string | null;
  steps: string;
  role_preference: string | null;
  config: string | null;
  tags: string | null;
  enabled: number;
  created_at: number;
  updated_at: number | null;
  source_session_id: string | null;
  notify_targets: string | null;
  deliver_to: string | null;
  report_to: string | null;
  goal_ids: string | null;
  is_preset: number;
  preset_id: string | null;
  retry_policy: string | null;
}

function rowToTaskTemplate(row: TaskTemplateRow): TaskTemplate {
  const triggerType = row.trigger_type as TaskTemplateTrigger["type"];
  const trigger: TaskTemplateTrigger = {
    type: triggerType,
    // trigger_type values: 'cron' | 'manual' | 'once' | 'template_complete' | 'event'.
    // For 'template_complete', trigger_event carries 'template_complete:<targetId>'.
    // For 'event', trigger_event carries 'event:<eventDefId>'.
    cron: triggerType === "event" ? undefined : (row.trigger_cron ?? undefined),
    event: triggerType === "event" ? undefined : (row.trigger_event ?? undefined),
    eventDefId: triggerType === "event" ? stripEventPrefix(row.trigger_event) : undefined,
    runAt: triggerType === "once" ? (row.trigger_cron ?? undefined) : undefined,
  };

  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    trigger,
    steps: JSON.parse(row.steps) as TaskStep[],
    rolePreference: row.role_preference ?? undefined,
    config: row.config ? JSON.parse(row.config) as Partial<TaskConfig> : undefined,
    tags: row.tags ? JSON.parse(row.tags) as string[] : undefined,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
    sourceSessionId: row.source_session_id ?? undefined,
    deliverTo: row.deliver_to ? JSON.parse(row.deliver_to) : undefined,
    reportTo: row.report_to ? JSON.parse(row.report_to) : undefined,
    goalIds: row.goal_ids ? JSON.parse(row.goal_ids) : undefined,
    isPreset: row.is_preset === 1 ? true : undefined,
    presetId: row.preset_id ?? undefined,
    retryPolicy: row.retry_policy ? JSON.parse(row.retry_policy) as { maxAttempts: number } : undefined,
  };
}

export function createTaskTemplate(template: TaskTemplate): { changes: number } {
  validateTemplateDefinition(template);
  validateTemplateTrigger(template.trigger);
  const db = getDb();
  const result = db.prepare(`
    INSERT OR IGNORE INTO task_templates (id, name, description, trigger_type, trigger_cron,
      trigger_event, steps, role_preference, config, tags, enabled, created_at, updated_at,
      source_session_id, deliver_to, report_to, goal_ids, is_preset, preset_id, retry_policy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    template.id,
    template.name,
    template.description ?? null,
    template.trigger.type,
    template.trigger.type === "once" ? (template.trigger.runAt ?? null) : (template.trigger.cron ?? null),
    template.trigger.type === "event"
      ? `event:${template.trigger.eventDefId}`
      : (template.trigger.event ?? null),
    JSON.stringify(template.steps),
    template.rolePreference ?? null,
    template.config ? JSON.stringify(template.config) : null,
    template.tags ? JSON.stringify(template.tags) : null,
    template.enabled ? 1 : 0,
    template.createdAt ?? Date.now(),
    template.updatedAt ?? null,
    template.sourceSessionId ?? null,
    template.deliverTo ? JSON.stringify(template.deliverTo) : null,
    template.reportTo ? JSON.stringify(template.reportTo) : null,
    template.goalIds ? JSON.stringify(template.goalIds) : null,
    // is_preset: 1 if presetId is set, 0 otherwise
    template.presetId != null ? 1 : 0,
    template.presetId ?? null,
    template.retryPolicy ? JSON.stringify(template.retryPolicy) : null,
  );
  return { changes: Number(result.changes) };
}

export function getTaskTemplate(id: string): TaskTemplate | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM task_templates WHERE id = ?").get(id) as
    | TaskTemplateRow
    | undefined;
  return row ? rowToTaskTemplate(row) : undefined;
}

export function updateTaskTemplate(
  id: string,
  updates: Partial<TaskTemplate>,
  reason: "update" | "restore" = "update",
): void {
  const db = getDb();

  // Phase 0.5: snapshot current state into template_versions BEFORE applying
  // the update, so the history captures the pre-change snapshot. The snapshot
  // helper internally applies the content-change gate (skip if projection
  // unchanged → protects against `updated_at`-only / `config.last_run_at`-only
  // writes flooding the history).
  if (getTaskTemplate(id) !== undefined) {
    snapshotTemplateVersion(id, reason);
  }

  // Validate full Template definition if steps or rolePreference is being changed.
  // Load current row to get the unchanged side of the disjunction.
  if ("steps" in updates || "rolePreference" in updates) {
    const current = getTaskTemplate(id);
    if (current) {
      const merged: Pick<TaskTemplate, "rolePreference" | "steps"> = {
        rolePreference: "rolePreference" in updates ? updates.rolePreference : current.rolePreference,
        steps: "steps" in updates && updates.steps ? updates.steps : current.steps,
      };
      validateTemplateDefinition(merged);
    }
  }
  if ("trigger" in updates && updates.trigger) {
    validateTemplateTrigger(updates.trigger);
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];

  if ("name" in updates) {
    setClauses.push("name = ?");
    values.push(updates.name);
  }
  if ("description" in updates) {
    setClauses.push("description = ?");
    values.push(updates.description ?? null);
  }
  if ("trigger" in updates && updates.trigger) {
    setClauses.push("trigger_type = ?");
    values.push(updates.trigger.type);
    setClauses.push("trigger_cron = ?");
    values.push(updates.trigger.type === "once" ? (updates.trigger.runAt ?? null) : (updates.trigger.cron ?? null));
    setClauses.push("trigger_event = ?");
    values.push(
      updates.trigger.type === "event"
        ? `event:${updates.trigger.eventDefId}`
        : (updates.trigger.event ?? null),
    );
  }
  if ("steps" in updates) {
    setClauses.push("steps = ?");
    values.push(JSON.stringify(updates.steps));
  }
  if ("rolePreference" in updates) {
    setClauses.push("role_preference = ?");
    values.push(updates.rolePreference ?? null);
  }
  if ("config" in updates) {
    setClauses.push("config = ?");
    values.push(updates.config ? JSON.stringify(updates.config) : null);
  }
  if ("tags" in updates) {
    setClauses.push("tags = ?");
    values.push(updates.tags ? JSON.stringify(updates.tags) : null);
  }
  if ("enabled" in updates) {
    setClauses.push("enabled = ?");
    values.push(updates.enabled ? 1 : 0);
  }
  if ("sourceSessionId" in updates) {
    setClauses.push("source_session_id = ?");
    values.push(updates.sourceSessionId ?? null);
  }
  if ("deliverTo" in updates) {
    setClauses.push("deliver_to = ?");
    values.push(updates.deliverTo ? JSON.stringify(updates.deliverTo) : null);
  }
  if ("reportTo" in updates) {
    setClauses.push("report_to = ?");
    values.push(updates.reportTo ? JSON.stringify(updates.reportTo) : null);
  }
  if ("goalIds" in updates) {
    setClauses.push("goal_ids = ?");
    values.push(updates.goalIds ? JSON.stringify(updates.goalIds) : null);
  }
  if ("isPreset" in updates) {
    setClauses.push("is_preset = ?");
    values.push(updates.isPreset ? 1 : 0);
  }
  if ("presetId" in updates) {
    setClauses.push("preset_id = ?");
    values.push(updates.presetId ?? null);
  }
  if ("retryPolicy" in updates) {
    setClauses.push("retry_policy = ?");
    values.push(updates.retryPolicy ? JSON.stringify(updates.retryPolicy) : null);
  }

  if (setClauses.length === 0) return;

  setClauses.push("updated_at = ?");
  values.push(Date.now());

  values.push(id);
  db.prepare(
    `UPDATE task_templates SET ${setClauses.join(", ")} WHERE id = ?`,
  ).run(...values);
}

export function listTaskTemplates(
  enabledOnly = false,
  limit?: number,
  offset = 0,
): TaskTemplate[] {
  const db = getDb();
  let query = "SELECT * FROM task_templates";
  const params: unknown[] = [];

  if (enabledOnly) {
    query += " WHERE enabled = 1";
  }

  query += " ORDER BY COALESCE(updated_at, created_at) DESC";
  if (typeof limit === "number") {
    query += " LIMIT ? OFFSET ?";
    params.push(limit, offset);
  }

  const rows = db.prepare(query).all(...params) as TaskTemplateRow[];
  return rows.map(rowToTaskTemplate);
}

export function enableTaskTemplate(id: string): void {
  const db = getDb();
  db.prepare("UPDATE task_templates SET enabled = 1, updated_at = ? WHERE id = ?").run(
    Date.now(),
    id,
  );
}

export function disableTaskTemplate(id: string): void {
  const db = getDb();
  db.prepare("UPDATE task_templates SET enabled = 0, updated_at = ? WHERE id = ?").run(
    Date.now(),
    id,
  );
}

export function getTaskTemplateDependents(id: string): TaskTemplateDependents {
  const db = getDb();
  const exec = db.prepare(
    "SELECT COUNT(*) AS n FROM template_executions WHERE template_id = ?",
  ).get(id) as { n: number };
  const task = db.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE template_id = ?",
  ).get(id) as { n: number };
  return { executionCount: exec.n, taskCount: task.n };
}

export function deleteTaskTemplate(
  id: string,
  mode: DeleteTemplateMode = "template_only",
): void {
  const db = getDb();
  const executionRows = db.prepare("SELECT id FROM template_executions WHERE template_id = ?").all(id) as Array<{ id: string }>;
  const tx = db.transaction(() => {
    // Phase 0.5: snapshot the pre-delete state into template_versions BEFORE
    // the DELETE so restore-after-delete can locate the snapshot. No
    // content-change gate here (force=true) — delete should always produce a
    // version row (per plan: "删除总记一版").
    snapshotTemplateVersion(id, "delete", true);
    if (mode === "with_tasks") {
      const taskRows = db.prepare(
        "SELECT id FROM tasks WHERE template_id = ?",
      ).all(id) as Array<{ id: string }>;
      const taskIds = taskRows.map((r) => r.id);

      if (taskIds.length > 0) {
        const CHUNK = 500;
        for (let i = 0; i < taskIds.length; i += CHUNK) {
          const chunk = taskIds.slice(i, i + CHUNK);
          const placeholders = chunk.map(() => "?").join(",");

          db.prepare(
            `DELETE FROM role_scores WHERE task_id IN (${placeholders})`,
          ).run(...chunk);

          db.prepare(
            `DELETE FROM manager_decisions WHERE task_id IN (${placeholders})`,
          ).run(...chunk);

          db.prepare(
            `UPDATE chat_messages SET task_id = NULL WHERE task_id IN (${placeholders})`,
          ).run(...chunk);

          db.prepare(
            `UPDATE approval_rules SET created_by_task_id = NULL WHERE created_by_task_id IN (${placeholders})`,
          ).run(...chunk);

          db.prepare(
            `DELETE FROM tasks WHERE id IN (${placeholders})`,
          ).run(...chunk);
        }
      }
    }
    db.prepare("DELETE FROM template_executions WHERE template_id = ?").run(id);
    db.prepare("DELETE FROM task_templates WHERE id = ?").run(id);
  });
  tx();
  for (const row of executionRows) {
    removeTemplateExecutionArtifactsDir(row.id);
  }
}
