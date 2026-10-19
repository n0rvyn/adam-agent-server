/**
 * Template version history (Phase 0.5).
 *
 * Snapshots the full TaskTemplate detail before any content-changing update
 * (or delete) so users can list / diff / restore via adam-tools + WebUI.
 *
 * Choke-point contract:
 * - `snapshotTemplateVersion` is called by `updateTaskTemplate` (before
 *   UPDATE) and `deleteTaskTemplate` (inside the delete transaction).
 * - Both call sites are the SOLE production-code entry points for content
 *   changes, so this file is the single source of truth for the version
 *   history stream.
 * - A content-change gate (see `computeVersionedProjection` + `projectionsEqual`)
 *   filters out no-op / `updated_at`-only / `config.last_run_at`-only writes
 *   so the version stream doesn't flood from cron bookkeeping.
 *
 * Restore (Task 3) routes through `updateTaskTemplate` with reason='restore',
 * which causes the update hook to snapshot the *current* state first → restore
 * is non-destructive (current state preserved as a 'restore' snapshot before
 * the old content is written back).
 */

import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { getTaskTemplate, updateTaskTemplate } from "./task-templates.js";
import { getCurrentTraceId } from "../lib/trace-context.js";
import type { TaskTemplate, TaskStep } from "../shared/types.js";

export type TemplateVersionReason = "update" | "delete" | "restore";

export interface TemplateVersionRecord {
  id: string;
  templateId: string;
  versionNo: number;
  snapshot: TaskTemplate;
  reason: TemplateVersionReason;
  author: string | null;
  traceId: string | null;
  createdAt: number;
}

export interface TemplateVersionDiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

interface VersionedProjection {
  name: string;
  description: string | null | undefined;
  trigger: TaskTemplate["trigger"];
  steps: TaskStep[];
  rolePreference: string | null | undefined;
  config: Omit<NonNullable<TaskTemplate["config"]>, "last_run_at">;
  tags: string[] | null | undefined;
  deliverTo: TaskTemplate["deliverTo"];
  reportTo: TaskTemplate["reportTo"];
  goalIds: string[] | null | undefined;
  retryPolicy: TaskTemplate["retryPolicy"];
}

/**
 * Compute the projection of a TaskTemplate that is "versioned" — the fields
 * that, if changed, should produce a new version. Volatile fields
 * (`updated_at`, `config.last_run_at`) are explicitly excluded so cron
 * bookkeeping and no-op PATCHes don't flood the history.
 */
export function computeVersionedProjection(t: TaskTemplate): VersionedProjection {
  const config = t.config ?? {};
  // Strip last_run_at only (keep everything else in config).
  const { last_run_at: _ignored, ...versionedConfig } = config as Record<string, unknown> & {
    last_run_at?: unknown;
  };
  return {
    name: t.name,
    description: t.description ?? null,
    trigger: t.trigger,
    steps: t.steps,
    rolePreference: t.rolePreference ?? null,
    config: versionedConfig as VersionedProjection["config"],
    tags: t.tags ?? null,
    deliverTo: t.deliverTo,
    reportTo: t.reportTo,
    goalIds: t.goalIds ?? null,
    retryPolicy: t.retryPolicy,
  };
}

/**
 * Stable JSON for projection comparison. Two projections are "equal" iff
 * the canonical JSON string matches — keys are sorted so key-order churn
 * doesn't produce false negatives.
 */
export function canonicalize(value: unknown): string {
  // Treat undefined like JSON does (absent / null) so a live getTaskTemplate
  // projection (which carries undefined-valued keys, e.g. step.roleId: undefined)
  // compares EQUAL to a JSON-round-tripped snapshot (where those keys were dropped
  // by JSON.stringify). Without this, the content-change gate false-positives on
  // every no-op / volatile-only write and floods the version history.
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  // Drop undefined-valued keys so present-undefined === absent (JSON semantics).
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]))
      .join(",") +
    "}"
  );
}

function projectionsEqual(a: VersionedProjection, b: VersionedProjection): boolean {
  return canonicalize(a) === canonicalize(b);
}

/**
 * Write a new template_versions row capturing the *current* state of the
 * template. The caller is responsible for calling this BEFORE the change
 * is applied (so the snapshot reflects the pre-change state).
 *
 * Returns the version number written. Returns null when the template
 * no longer exists (race: caller deleted/updated out from under us) or
 * when the versioned content projection is unchanged from the most
 * recent snapshot (content-change gate, see Task 2 D-e).
 */
export function snapshotTemplateVersion(
  templateId: string,
  reason: TemplateVersionReason,
  force = false,
): { id: string; versionNo: number } | null {
  const current = getTaskTemplate(templateId);
  if (!current) {
    // Template row missing (e.g., already deleted) — nothing to snapshot.
    return null;
  }

  const db = getDb();

  // Content-change gate: compare current projection to the most recent
  // snapshot. If equal, skip the write (flood protection). `force` bypasses
  // the gate — used by delete so a final pre-delete row is ALWAYS recorded
  // even if the last write was a no-op (per plan: "删除总记一版").
  const lastSnapshotRow = db
    .prepare(
      "SELECT snapshot_json FROM template_versions WHERE template_id = ? ORDER BY version_no DESC LIMIT 1",
    )
    .get(templateId) as { snapshot_json: string } | undefined;

  const currentProjection = computeVersionedProjection(current);

  if (!force && lastSnapshotRow) {
    try {
      const lastSnapshot = JSON.parse(lastSnapshotRow.snapshot_json) as TaskTemplate;
      const lastProjection = computeVersionedProjection(lastSnapshot);
      if (projectionsEqual(currentProjection, lastProjection)) {
        return null; // No content change → no new version.
      }
    } catch {
      // Corrupt snapshot row — fall through and write a fresh one.
    }
  }

  // Compute next version_no.
  const maxRow = db
    .prepare(
      "SELECT MAX(version_no) AS v FROM template_versions WHERE template_id = ?",
    )
    .get(templateId) as { v: number | null };
  const nextVersionNo = (maxRow.v ?? 0) + 1;

  const id = uuidv4();
  const traceId = getCurrentTraceId() ?? null;

  db.prepare(
    `INSERT INTO template_versions
       (id, template_id, version_no, snapshot_json, reason, author, trace_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    templateId,
    nextVersionNo,
    JSON.stringify(current),
    reason,
    null, // author: caller-provided in future; for now NULL
    traceId,
    Date.now(),
  );

  return { id, versionNo: nextVersionNo };
}

/** List all versions for a template, ordered newest-first. */
export function listTemplateVersions(templateId: string): TemplateVersionRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM template_versions WHERE template_id = ? ORDER BY version_no DESC",
    )
    .all(templateId) as Array<{
    id: string;
    template_id: string;
    version_no: number;
    snapshot_json: string;
    reason: TemplateVersionReason;
    author: string | null;
    trace_id: string | null;
    created_at: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    templateId: r.template_id,
    versionNo: r.version_no,
    snapshot: JSON.parse(r.snapshot_json) as TaskTemplate,
    reason: r.reason,
    author: r.author,
    traceId: r.trace_id,
    createdAt: r.created_at,
  }));
}

/** Get a single version by templateId + versionNo. */
export function getTemplateVersion(
  templateId: string,
  versionNo: number,
): TemplateVersionRecord | undefined {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM template_versions WHERE template_id = ? AND version_no = ?",
    )
    .get(templateId, versionNo) as
    | {
        id: string;
        template_id: string;
        version_no: number;
        snapshot_json: string;
        reason: TemplateVersionReason;
        author: string | null;
        trace_id: string | null;
        created_at: number;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    templateId: row.template_id,
    versionNo: row.version_no,
    snapshot: JSON.parse(row.snapshot_json) as TaskTemplate,
    reason: row.reason,
    author: row.author,
    traceId: row.trace_id,
    createdAt: row.created_at,
  };
}

/**
 * Compute a field-path diff between two snapshot details.
 * Walks `steps` by step id and `config` by key (excluding `last_run_at`),
 * plus top-level fields. Returns the list of changed paths with before/after
 * values. Used by `diff_template_versions` adam-tool and the WebUI.
 */
export function diffTemplateVersions(
  before: TaskTemplate,
  after: TaskTemplate,
): TemplateVersionDiffEntry[] {
  const diffs: TemplateVersionDiffEntry[] = [];

  // Top-level scalar fields.
  const topLevelKeys: Array<keyof TaskTemplate> = [
    "name",
    "description",
    "trigger",
    "rolePreference",
    "tags",
    "deliverTo",
    "reportTo",
    "goalIds",
    "retryPolicy",
  ];
  for (const key of topLevelKeys) {
    const a = (before as unknown as Record<string, unknown>)[key as string];
    const b = (after as unknown as Record<string, unknown>)[key as string];
    if (canonicalize(a) !== canonicalize(b)) {
      diffs.push({ path: key as string, before: a, after: b });
    }
  }

  // steps: walk by step id (steps have `id` field per TaskStep).
  const beforeSteps = new Map<string, TaskStep>();
  for (const s of before.steps ?? []) {
    if (s && typeof (s as { id?: unknown }).id === "string") {
      beforeSteps.set((s as { id: string }).id, s);
    }
  }
  const afterSteps = new Map<string, TaskStep>();
  for (const s of after.steps ?? []) {
    if (s && typeof (s as { id?: unknown }).id === "string") {
      afterSteps.set((s as { id: string }).id, s);
    }
  }
  const allStepIds = new Set<string>([...beforeSteps.keys(), ...afterSteps.keys()]);
  for (const stepId of allStepIds) {
    const a = beforeSteps.get(stepId);
    const b = afterSteps.get(stepId);
    if (!a) {
      diffs.push({ path: `steps.${stepId}`, before: undefined, after: b });
      continue;
    }
    if (!b) {
      diffs.push({ path: `steps.${stepId}`, before: a, after: undefined });
      continue;
    }
    // Step present on both sides — diff field-by-field.
    const stepKeys = new Set<string>([
      ...Object.keys(a as unknown as Record<string, unknown>),
      ...Object.keys(b as unknown as Record<string, unknown>),
    ]);
    for (const k of stepKeys) {
      const av = (a as unknown as Record<string, unknown>)[k];
      const bv = (b as unknown as Record<string, unknown>)[k];
      if (canonicalize(av) !== canonicalize(bv)) {
        diffs.push({ path: `steps.${stepId}.${k}`, before: av, after: bv });
      }
    }
  }

  // config: walk keys, skip `last_run_at` (volatile, not versioned).
  const beforeCfg = (before.config ?? {}) as Record<string, unknown>;
  const afterCfg = (after.config ?? {}) as Record<string, unknown>;
  const allCfgKeys = new Set<string>([...Object.keys(beforeCfg), ...Object.keys(afterCfg)]);
  for (const k of allCfgKeys) {
    if (k === "last_run_at") continue;
    if (canonicalize(beforeCfg[k]) !== canonicalize(afterCfg[k])) {
      diffs.push({ path: `config.${k}`, before: beforeCfg[k], after: afterCfg[k] });
    }
  }

  return diffs;
}

/**
 * Restore a template to the content of a previous version.
 *
 * Non-destructive: routes through `updateTaskTemplate(id, snapshot, 'restore')`,
 * which first calls `snapshotTemplateVersion(id, 'restore')` to capture the
 * pre-restore state (Task 2 hook). The pre-restore snapshot is recorded in
 * the version history with reason='restore', so the history is never lost.
 *
 * Throws if the target version doesn't exist or if the template no longer
 * exists in task_templates (restore-after-delete is not supported here —
 * `deleteTaskTemplate` snapshots the final state, but re-inserting the row
 * is out of scope for Phase 0.5).
 */
export function restoreTemplateVersion(
  templateId: string,
  versionNo: number,
): { restoredFromVersion: number; preRestoreVersionNo: number | null } {
  const version = getTemplateVersion(templateId, versionNo);
  if (!version) {
    throw new Error(
      `Template version not found: templateId=${templateId} versionNo=${versionNo}`,
    );
  }
  const current = getTaskTemplate(templateId);
  if (!current) {
    throw new Error(
      `Cannot restore: template row missing for id=${templateId} (deleted templates cannot be restored in this phase)`,
    );
  }

  // Read the highest existing version_no so we can report which version the
  // pre-restore snapshot was written to (Task 2 hook will write it).
  const db = getDb();
  const maxRow = db
    .prepare(
      "SELECT MAX(version_no) AS v FROM template_versions WHERE template_id = ?",
    )
    .get(templateId) as { v: number | null };
  const preRestoreVersionNo = (maxRow.v ?? 0);

  // Build the update payload from the snapshot. Strip id/createdAt/updatedAt
  // — updateTaskTemplate manages those.
  const snapshot = version.snapshot;
  const updates: Partial<TaskTemplate> = {
    name: snapshot.name,
    description: snapshot.description,
    trigger: snapshot.trigger,
    steps: snapshot.steps,
    rolePreference: snapshot.rolePreference,
    // Drop last_run_at (volatile — restoring it would just re-stamp it with
    // the old time, which is misleading; the next cron run will set a new one).
    config: snapshot.config
      ? (Object.fromEntries(
          Object.entries(snapshot.config).filter(([k]) => k !== "last_run_at"),
        ) as TaskTemplate["config"])
      : undefined,
    tags: snapshot.tags,
    deliverTo: snapshot.deliverTo,
    reportTo: snapshot.reportTo,
    goalIds: snapshot.goalIds,
    retryPolicy: snapshot.retryPolicy,
    // `enabled` is intentionally NOT restored — restore is a content restore,
    // not a runtime state restore. Operators can re-enable separately.
  };

  updateTaskTemplate(templateId, updates, "restore");

  return {
    restoredFromVersion: versionNo,
    preRestoreVersionNo,
  };
}
