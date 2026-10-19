import { basename } from "node:path";
import { v4 as uuidv4 } from "uuid";
import type BetterSqlite3 from "better-sqlite3";
import { getDb } from "./db.js";
import type {
  RetentionHint,
  EncryptionClass,
  ArtifactPurpose,
  ArtifactAccess,
  ArtifactCollectionManifest,
} from "../shared/types.js";

export type ArtifactKind = "json" | "file";

export interface Artifact {
  id: string;
  sourceKind: "template_step" | "task_published" | "chat_sent";
  executionId?: string;       // template_step only
  taskId?: string;            // task_published only
  chatSessionId?: string;     // chat_sent only
  stepId?: string;            // template_step only
  roleId?: string;            // nullable for legacy v50 backfilled rows
  key?: string;
  kind: ArtifactKind;
  value?: unknown;
  blobPath?: string;
  mime?: string;
  originalFilename?: string;
  sizeBytes: number;
  createdAt: number;
  locator?: string;
  contentHash?: string;
  retentionHint?: RetentionHint;
  encryptionClass?: EncryptionClass;
  purpose?: ArtifactPurpose;
  replaces?: string;
  producedByRole?: string;
  access?: ArtifactAccess;
  priority?: number;
  /** Logical artifact role from the step's outputContract.expectedArtifacts. */
  artifactRole?: string;
}

interface ArtifactRow {
  id: string;
  source_kind: string;
  execution_id: string | null;
  task_id: string | null;
  chat_session_id: string | null;
  step_id: string | null;
  role_id: string | null;
  key: string | null;
  kind: string;
  value_json: string | null;
  blob_path: string | null;
  mime: string | null;
  original_filename: string | null;
  size_bytes: number;
  created_at: number;
  locator: string | null;
  content_hash: string | null;
  retention_hint: string | null;
  encryption_class: string | null;
  purpose: string | null;
  replaces: string | null;
  produced_by_role: string | null;
  access: string | null;
  priority: number | null;
  artifact_role: string | null;
}

export interface ArtifactCollectionMutationResult {
  manifestArtifact: Artifact;
  childArtifact: Artifact;
  rekeyedPrimaryArtifact?: Artifact;
}

const ARTIFACT_KEY_REGEX = /^[\p{L}0-9._-]{1,256}$/u;

function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    sourceKind: row.source_kind as Artifact["sourceKind"],
    executionId: row.execution_id ?? undefined,
    taskId: row.task_id ?? undefined,
    chatSessionId: row.chat_session_id ?? undefined,
    stepId: row.step_id ?? undefined,
    roleId: row.role_id ?? undefined,
    key: row.key ?? undefined,
    kind: row.kind as ArtifactKind,
    value: row.value_json ? JSON.parse(row.value_json) : undefined,
    blobPath: row.blob_path ?? undefined,
    mime: row.mime ?? undefined,
    originalFilename: row.original_filename ?? undefined,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    locator: row.locator ?? undefined,
    contentHash: row.content_hash ?? undefined,
    retentionHint: (row.retention_hint as RetentionHint) ?? undefined,
    encryptionClass: (row.encryption_class as EncryptionClass) ?? undefined,
    purpose: (row.purpose as ArtifactPurpose) ?? undefined,
    replaces: row.replaces ?? undefined,
    producedByRole: row.produced_by_role ?? undefined,
    access: (row.access as ArtifactAccess) ?? undefined,
    priority: row.priority ?? undefined,
    artifactRole: row.artifact_role ?? undefined,
  };
}

/**
 * Normalize a json artifact's value for storage. LLMs frequently publish a JSON *object* as a
 * stringified JSON string (double-encoding). Stored as-is, `art.value` reads back as a string, so
 * any consumer doing field access (`value.body`) gets nothing — this shipped an empty-body podcast
 * email on 2026-06-03. When a json artifact's value is a string that parses to an object/array,
 * store the parsed structure so `art.value` is always canonical for every consumer (delivery
 * composer, prompt injection, future). Scalars / non-JSON strings are left untouched (a value
 * genuinely meant to be a string stays a string).
 */
export function normalizeJsonArtifactValue(kind: string, value: unknown): unknown {
  if (kind !== "json" || typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" ? parsed : value;
  } catch {
    return value;
  }
}

export function createArtifact(artifact: Artifact): void {
  if (!artifact.roleId || artifact.roleId.trim() === "") {
    throw new Error("createArtifact: roleId required (application-layer enforcement)");
  }
  insertArtifactRow(getDb(), artifact);
}

function insertArtifactRow(db: BetterSqlite3.Database, artifact: Artifact): void {
  const valueForStorage = normalizeJsonArtifactValue(artifact.kind, artifact.value);
  db.prepare(`
    INSERT INTO artifacts (
      id, source_kind, execution_id, task_id, chat_session_id, step_id, role_id,
      key, kind, value_json, blob_path, mime, original_filename, size_bytes, created_at,
      locator, content_hash, retention_hint, encryption_class, purpose, replaces, produced_by_role, access, priority,
      artifact_role
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifact.id,
    artifact.sourceKind,
    artifact.executionId ?? null,
    artifact.taskId ?? null,
    artifact.chatSessionId ?? null,
    artifact.stepId ?? null,
    artifact.roleId ?? null,
    artifact.key ?? null,
    artifact.kind,
    valueForStorage !== undefined ? JSON.stringify(valueForStorage) : null,
    artifact.blobPath ?? null,
    artifact.mime ?? null,
    artifact.originalFilename ?? null,
    artifact.sizeBytes,
    artifact.createdAt,
    artifact.locator ?? null,
    artifact.contentHash ?? null,
    artifact.retentionHint ?? null,
    artifact.encryptionClass ?? null,
    artifact.purpose ?? null,
    artifact.replaces ?? null,
    artifact.producedByRole ?? null,
    artifact.access ?? null,
    artifact.priority ?? null,
    artifact.artifactRole ?? null,
  );
}

function getArtifactWithDb(
  db: BetterSqlite3.Database,
  executionId: string,
  stepId: string,
  key: string,
): Artifact | undefined {
  const row = db.prepare(`
    SELECT * FROM artifacts
    WHERE source_kind = 'template_step' AND execution_id = ? AND step_id = ? AND key = ?
  `).get(executionId, stepId, key) as ArtifactRow | undefined;
  return row ? rowToArtifact(row) : undefined;
}

/**
 * Narrowed Artifact variant: rows queried via execution_id are guaranteed by the
 * v72 CHECK constraint to be source_kind='template_step', which in turn
 * requires execution_id + step_id non-null. The TS type signature reflects
 * the DB constraint so callers do not need to add `?? ""` guards.
 * `key` is also non-null for template_step rows because the original v26 schema
 * had `key TEXT NOT NULL` and the v72 INSERT SELECT preserved all values.
 */
export type TemplateStepArtifact = Artifact & {
  executionId: string;
  stepId: string;
  key: string;
};

export function getArtifact(
  executionId: string,
  stepId: string,
  key: string,
): TemplateStepArtifact | undefined {
  return getArtifactWithDb(getDb(), executionId, stepId, key) as TemplateStepArtifact | undefined;
}

export function getArtifactById(id: string): Artifact | undefined {
  const row = getDb().prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
  return row ? rowToArtifact(row) : undefined;
}

export function listArtifactsByExecution(
  executionId: string,
  stepId?: string,
): TemplateStepArtifact[] {
  const db = getDb();
  let sql = "SELECT * FROM artifacts WHERE execution_id = ?";
  const params: unknown[] = [executionId];
  if (stepId) {
    sql += " AND step_id = ?";
    params.push(stepId);
  }
  sql += " ORDER BY created_at ASC";
  const rows = db.prepare(sql).all(...params) as ArtifactRow[];
  return rows.map(rowToArtifact) as TemplateStepArtifact[];
}

export function listArtifactsByTask(taskId: string): Artifact[] {
  const rows = getDb().prepare(
    "SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC",
  ).all(taskId) as ArtifactRow[];
  return rows.map(rowToArtifact);
}

export function listArtifactsByChatSession(chatSessionId: string): Artifact[] {
  const rows = getDb().prepare(
    "SELECT * FROM artifacts WHERE chat_session_id = ? ORDER BY created_at ASC",
  ).all(chatSessionId) as ArtifactRow[];
  return rows.map(rowToArtifact);
}

export function listArtifactsByRole(
  roleId: string,
  filter?: { sourceKind?: string; mimePrefix?: string },
): Artifact[] {
  const db = getDb();
  let sql = "SELECT * FROM artifacts WHERE role_id = ?";
  const params: unknown[] = [roleId];
  if (filter?.sourceKind) {
    sql += " AND source_kind = ?";
    params.push(filter.sourceKind);
  }
  sql += " ORDER BY created_at ASC";
  const rows = db.prepare(sql).all(...params) as ArtifactRow[];
  let results = rows.map(rowToArtifact);
  if (filter?.mimePrefix) {
    results = results.filter((a) => a.mime?.startsWith(filter.mimePrefix!));
  }
  return results;
}

export function deleteArtifactsByExecution(executionId: string): Artifact[] {
  const db = getDb();
  const rows = listArtifactsByExecution(executionId);
  db.prepare("DELETE FROM artifacts WHERE execution_id = ?").run(executionId);
  return rows;
}

/** Delete artifact rows for a specific step within an execution. Returns the deleted rows. */
export function deleteArtifactsByExecutionAndStep(
  executionId: string,
  stepId: string,
): Artifact[] {
  const db = getDb();
  const rows = listArtifactsByExecution(executionId).filter((a) => a.stepId === stepId);
  db.prepare("DELETE FROM artifacts WHERE execution_id = ? AND step_id = ?").run(executionId, stepId);
  return rows;
}

export function deleteArtifactById(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
}

/** Alias for deleteArtifactById that returns a boolean indicating whether a row was deleted. */
export function removeArtifact(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
  return result.changes > 0;
}

export function isArtifactCollectionManifest(value: unknown): value is ArtifactCollectionManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ArtifactCollectionManifest>;
  if (candidate.type !== "artifact_collection") return false;
  if (typeof candidate.outputAs !== "string" || candidate.outputAs.length === 0) return false;
  if (!Array.isArray(candidate.items)) return false;
  return candidate.items.every((item) => (
    item != null
    && typeof item === "object"
    && typeof item.artifactId === "string"
    && item.artifactId.length > 0
    && typeof item.key === "string"
    && item.key.length > 0
    && typeof item.sizeBytes === "number"
    && Number.isFinite(item.sizeBytes)
    && (item.filename === undefined || typeof item.filename === "string")
    && (item.mime === undefined || typeof item.mime === "string")
    && (item.purpose === undefined || typeof item.purpose === "string")
  ));
}

export function ensureUniqueArtifactKey(
  executionId: string,
  stepId: string,
  requestedKey: string,
): string {
  return ensureUniqueArtifactKeyWithDb(getDb(), executionId, stepId, requestedKey);
}

export function appendArtifactToCollection(
  executionId: string,
  stepId: string,
  outputAs: string,
  childArtifact: Artifact,
): ArtifactCollectionMutationResult {
  const db = getDb();
  const tx = db.transaction(() => {
    const manifestArtifact = getArtifactWithDb(db, executionId, stepId, outputAs);
    if (!manifestArtifact || manifestArtifact.kind !== "json" || !isArtifactCollectionManifest(manifestArtifact.value)) {
      throw new Error(`Artifact collection manifest not found at ${stepId}/${outputAs}`);
    }

    const childKey = ensureUniqueArtifactKeyWithDb(
      db,
      executionId,
      stepId,
      childArtifact.key ?? "",
      new Set([outputAs]),
    );
    const registeredChild = { ...childArtifact, key: childKey };
    insertArtifactRow(db, registeredChild);

    const manifest: ArtifactCollectionManifest = {
      ...manifestArtifact.value,
      items: [...manifestArtifact.value.items, manifestItemFromArtifact(registeredChild)],
    };
    const updatedManifest = updateManifestArtifactRow(db, manifestArtifact, manifest);
    return {
      manifestArtifact: updatedManifest,
      childArtifact: registeredChild,
    };
  });
  return tx();
}

export function convertPrimaryFileToCollectionInTransaction(
  executionId: string,
  stepId: string,
  outputAs: string,
  existingPrimary: Artifact,
  newChild: Artifact,
): ArtifactCollectionMutationResult {
  const db = getDb();
  const tx = db.transaction(() => {
    const currentPrimary = getArtifactWithDb(db, executionId, stepId, outputAs);
    if (!currentPrimary || currentPrimary.id !== existingPrimary.id) {
      throw new Error(`Primary artifact changed before collection conversion at ${stepId}/${outputAs}`);
    }
    if (currentPrimary.kind !== "file" || !currentPrimary.blobPath) {
      throw new Error(`Primary artifact at ${stepId}/${outputAs} is not a file`);
    }

    const existingChildKey = ensureUniqueArtifactKeyWithDb(
      db,
      executionId,
      stepId,
      currentPrimary.originalFilename ?? currentPrimary.key ?? outputAs,
      new Set([outputAs]),
    );
    db.prepare("UPDATE artifacts SET key = ? WHERE id = ?")
      .run(existingChildKey, currentPrimary.id);
    const rekeyedPrimary = { ...currentPrimary, key: existingChildKey };

    const newChildKey = ensureUniqueArtifactKeyWithDb(
      db,
      executionId,
      stepId,
      newChild.key ?? "",
      new Set([outputAs, existingChildKey]),
    );
    const registeredChild = { ...newChild, key: newChildKey };
    insertArtifactRow(db, registeredChild);

    const manifestValue: ArtifactCollectionManifest = {
      type: "artifact_collection",
      outputAs,
      items: [
        manifestItemFromArtifact(rekeyedPrimary),
        manifestItemFromArtifact(registeredChild),
      ],
    };
    const manifestArtifact: Artifact = {
      id: uuidv4(),
      sourceKind: existingPrimary.sourceKind,
      executionId,
      stepId,
      key: outputAs,
      kind: "json",
      value: manifestValue,
      sizeBytes: manifestSize(manifestValue),
      createdAt: Date.now(),
      purpose: "data",
      roleId: existingPrimary.roleId,
    };
    insertArtifactRow(db, manifestArtifact);

    return {
      manifestArtifact,
      childArtifact: registeredChild,
      rekeyedPrimaryArtifact: rekeyedPrimary,
    };
  });
  return tx();
}

export function listExpiredExecutions(beforeTs: number): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id
    FROM template_executions
    WHERE status != 'running' AND COALESCE(completed_at, started_at) < ?
  `).all(beforeTs) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function ensureUniqueArtifactKeyWithDb(
  db: BetterSqlite3.Database,
  executionId: string,
  stepId: string,
  requestedKey: string,
  reservedKeys: Set<string> = new Set(),
): string {
  const rows = db.prepare(`
    SELECT key FROM artifacts
    WHERE execution_id = ? AND step_id = ?
  `).all(executionId, stepId) as Array<{ key: string }>;
  const taken = new Set(rows.map((row) => row.key));
  for (const key of reservedKeys) taken.add(key);

  const base = sanitizeArtifactKey(requestedKey);
  if (!taken.has(base)) return base;

  for (let index = 2; index < 10_000; index++) {
    const suffix = `-${index}`;
    const trimmedBase = base.slice(0, Math.max(1, 256 - suffix.length));
    const candidate = `${trimmedBase}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }

  throw new Error(`Unable to allocate unique artifact key for ${stepId}/${requestedKey}`);
}

function sanitizeArtifactKey(requestedKey: string): string {
  const normalized = requestedKey.replace(/\\/g, "/");
  const base = basename(normalized);
  const sanitized = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 256);
  if (!sanitized || sanitized === "." || sanitized === "..") return "artifact";
  return ARTIFACT_KEY_REGEX.test(sanitized) ? sanitized : "artifact";
}

function manifestItemFromArtifact(artifact: Artifact): ArtifactCollectionManifest["items"][number] {
  return {
    artifactId: artifact.id,
    key: artifact.key ?? "",
    ...(artifact.originalFilename ? { filename: artifact.originalFilename } : {}),
    ...(artifact.mime ? { mime: artifact.mime } : {}),
    sizeBytes: artifact.sizeBytes,
    ...(artifact.purpose ? { purpose: artifact.purpose } : {}),
    ...(artifact.artifactRole ? { role: artifact.artifactRole } : {}),
  };
}

function updateManifestArtifactRow(
  db: BetterSqlite3.Database,
  manifestArtifact: Artifact,
  manifest: ArtifactCollectionManifest,
): Artifact {
  const sizeBytes = manifestSize(manifest);
  db.prepare(`
    UPDATE artifacts
    SET value_json = ?, size_bytes = ?
    WHERE id = ?
  `).run(JSON.stringify(manifest), sizeBytes, manifestArtifact.id);
  return { ...manifestArtifact, value: manifest, sizeBytes };
}

function manifestSize(manifest: ArtifactCollectionManifest): number {
  return Buffer.byteLength(JSON.stringify(manifest), "utf8");
}

// ─── Phase 3: Generic list query ─────────────────────────────────────────────

export interface ListArtifactsFilter {
  sourceKind?: "template_step" | "task_published" | "chat_sent";
  mimePrefix?: string;
  roleId?: string;
  taskId?: string;
  executionId?: string;
  chatSessionId?: string;
  deliveryStatus?: "delivered" | "pending" | "failed" | "expired";
  from?: number; // unix ms
  to?: number;
}

export interface ListArtifactsPagination {
  limit: number;
  offset: number;
}

export function listArtifacts(
  filter: ListArtifactsFilter,
  pagination: ListArtifactsPagination,
): { artifacts: Artifact[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.sourceKind) {
    where.push("source_kind = ?");
    params.push(filter.sourceKind);
  }
  if (filter.mimePrefix) {
    // Strict prefix match — escape LIKE metacharacters in the prefix to prevent wildcard injection
    where.push("mime LIKE ? ESCAPE '\\'");
    params.push(filter.mimePrefix.replace(/[\\%_]/g, "\\$&") + "%");
  }
  if (filter.roleId) {
    where.push("role_id = ?");
    params.push(filter.roleId);
  }
  if (filter.taskId) {
    where.push("task_id = ?");
    params.push(filter.taskId);
  }
  if (filter.executionId) {
    where.push("execution_id = ?");
    params.push(filter.executionId);
  }
  if (filter.chatSessionId) {
    where.push("chat_session_id = ?");
    params.push(filter.chatSessionId);
  }
  if (filter.from !== undefined) {
    where.push("created_at >= ?");
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    where.push("created_at <= ?");
    params.push(filter.to);
  }
  if (filter.deliveryStatus) {
    // JOIN-style filter: artifact has at least one delivery_log row with matching status.
    // Checks both artifact.task_id and artifact.execution_id to support the
    // task_id=execution_id compatibility hack used by template_step rows.
    where.push(
      "(EXISTS (SELECT 1 FROM delivery_log dl WHERE dl.status = ? AND (dl.task_id = artifacts.task_id OR dl.task_id = artifacts.execution_id)))",
    );
    params.push(filter.deliveryStatus);
  }

  const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";
  const db = getDb();

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM artifacts ${whereClause}`)
    .get(...params) as { n: number };

  const rows = db
    .prepare(
      `SELECT * FROM artifacts ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pagination.limit, pagination.offset) as ArtifactRow[];

  return { artifacts: rows.map(rowToArtifact), total: totalRow.n };
}
