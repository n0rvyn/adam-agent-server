import {
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, sep } from "node:path";
import { v4 as uuidv4 } from "uuid";
import type BetterSqlite3 from "better-sqlite3";
import { RUNTIME_DIR } from "../shared/constants.js";
import { getLogger } from "./logger.js";

const log = getLogger("watchdog");

function getRuntimeRoot(): string {
  return process.env.ADAM_TEST_DIR || RUNTIME_DIR;
}

export function getLegacyTemplateExecutionRoot(): string {
  return join(getRuntimeRoot(), ["work", "flows"].join(""));
}

export function getTemplateExecutionsRoot(): string {
  return join(getRuntimeRoot(), "template-executions");
}

export function getArtifactsDir(executionId: string): string {
  return join(getTemplateExecutionsRoot(), executionId, "artifacts");
}

export function ensureArtifactsDir(executionId: string): string {
  const dir = getArtifactsDir(executionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function validatePathInWorkspace(
  path: string,
  workspaceRoot: string,
  mustExist: boolean,
): void {
  if (!isAbsolute(path)) {
    throw new Error(`path must be absolute: ${path}`);
  }

  const resolvedRoot = realpathSync(workspaceRoot);
  const normalizedRoot = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;

  if (mustExist) {
    const resolved = realpathSync(path);
    const normalizedResolved = resolved.endsWith(sep) ? resolved : resolved + sep;
    if (normalizedResolved === normalizedRoot || normalizedResolved.startsWith(normalizedRoot)) {
      return;
    }
    throw new Error(`path escapes workspace: ${path} (resolved=${resolved}, root=${resolvedRoot})`);
  }

  // A symlink destination is refused — it could redirect the write outside the workspace.
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`destination exists and is a symlink (refused): ${path}`);
  }
  // An existing REGULAR file is allowed: fetch must overwrite a stale same-named leftover in the
  // shared role workspace (e.g. a prior run's 口播稿.txt). Blocking it made the step read the OLD
  // file — synthesizing a wrong-day/wrong-length episode (2026-06-03 podcast: 18-min stale audio).

  const resolvedParent = realpathSync(dirname(path));
  const normalizedParent = resolvedParent.endsWith(sep) ? resolvedParent : resolvedParent + sep;
  if (normalizedParent === normalizedRoot || normalizedParent.startsWith(normalizedRoot)) {
    return;
  }
  throw new Error(`destination escapes workspace: ${path} (parent resolved=${resolvedParent}, root=${resolvedRoot})`);
}

export function publishBlob(args: {
  executionId: string;
  artifactId: string;
  sourcePath: string;
}): { blobPath: string; sizeBytes: number } {
  const dir = ensureArtifactsDir(args.executionId);
  const blobPath = join(dir, `${args.artifactId}.bin`);
  copyFileSync(args.sourcePath, blobPath);
  return { blobPath, sizeBytes: statSync(blobPath).size };
}

/**
 * Capture a text step's response as its `outputAs` artifact (platform-side, no LLM tool call).
 *
 * Pure design (adam-artifact-contract.md): a TEXT deliverable IS the step's final response —
 * the role is not required to call a publish tool for it. Only BINARY deliverables
 * (audio/image/file, identified by `stepRequiresFileArtifact`) must publish a file, because
 * there is no text response to capture. This is the canonical text-capture path used by the
 * TemplateExecutor presence step; it stores the text the same way `write_artifact`'s raw-text
 * mode does (kind="file" + text/markdown blob, NOT JSON.stringify-wrapped) so downstream
 * `getStepOutput`/`artifactToResult` read it back verbatim.
 */
export async function captureTextArtifact(args: {
  executionId: string;
  stepId: string;
  key: string;
  roleId: string;
  text: string;
}): Promise<{ artifactId: string; sizeBytes: number }> {
  const { createArtifact } = await import("../store/artifacts.js");
  const artifactId = uuidv4();
  const blobPath = join(ensureArtifactsDir(args.executionId), `${artifactId}.bin`);
  writeFileSync(blobPath, args.text, "utf8");
  const sizeBytes = Buffer.byteLength(args.text, "utf8");
  createArtifact({
    id: artifactId,
    sourceKind: "template_step",
    executionId: args.executionId,
    stepId: args.stepId,
    key: args.key,
    kind: "file",
    blobPath,
    mime: "text/markdown",
    originalFilename: `${args.key}.md`,
    sizeBytes,
    createdAt: Date.now(),
    roleId: args.roleId,
  });
  return { artifactId, sizeBytes };
}

export function unlinkSourceFile(sourcePath: string): void {
  try {
    unlinkSync(sourcePath);
  } catch (err) {
    log.warn({ err, sourcePath }, "Failed to remove TemplateExecution artifact source file");
  }
}

export function unlinkSourceFileStrict(sourcePath: string): void {
  unlinkSync(sourcePath);
}

export function fetchBlob(args: {
  blobPath: string;
  destPath: string;
}): { sizeBytes: number } {
  if (!existsSync(args.blobPath)) {
    throw new Error(`blob file missing on disk: ${args.blobPath}`);
  }
  // Overwrite the destination: fetch must always deliver THIS execution's artifact. The previous
  // COPYFILE_EXCL threw when destPath already existed, so a stale same-named leftover in the shared
  // role workspace (e.g. a prior run's 口播稿.txt) survived and the step read the OLD file —
  // synthesizing a wrong-day, wrong-length episode (2026-06-03 podcast: 18-min audio from a stale script).
  copyFileSync(args.blobPath, args.destPath);
  return { sizeBytes: statSync(args.destPath).size };
}

export function unlinkBlob(blobPath: string): void {
  try {
    unlinkSync(blobPath);
  } catch (err) {
    log.warn({ err, blobPath }, "Failed to remove TemplateExecution artifact blob");
  }
}

export function removeTemplateExecutionArtifactsDir(executionId: string): void {
  try {
    rmSync(join(getTemplateExecutionsRoot(), executionId), { recursive: true, force: true });
  } catch (err) {
    log.warn({ err, executionId }, "Failed to remove TemplateExecution artifacts directory");
  }
}

export function gcOrphanBlobs(
  executionId: string,
  validArtifactIds: Set<string>,
  minAgeMs: number,
): number {
  const dir = getArtifactsDir(executionId);
  if (!existsSync(dir)) return 0;

  let removed = 0;
  for (const entry of readdirSync(dir)) {
    if (extname(entry) !== ".bin") continue;
    const artifactId = entry.slice(0, -4);
    if (validArtifactIds.has(artifactId)) continue;

    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (Date.now() - stat.mtimeMs < minAgeMs) continue;

    unlinkBlob(fullPath);
    removed++;
  }

  return removed;
}

/**
 * Clean up platform-side artifacts from a prior validator-retry attempt.
 *
 * Deletes the step-scoped artifact rows from DB and unlinks their .bin files.
 * Returns counts for logging. Per-file errors are swallowed (best-effort).
 * Does NOT touch other steps' artifacts in the same execution.
 *
 * Used by the validator-retry branch in template-executor.ts.
 */
export async function cleanSlatePriorAttempt(
  executionId: string,
  stepId: string,
): Promise<{ deletedRows: number; deletedFiles: number }> {
  const { deleteArtifactsByExecutionAndStep } = await import(
    "../store/artifacts.js"
  );
  const deletedRows = deleteArtifactsByExecutionAndStep(executionId, stepId);

  let deletedFiles = 0;
  for (const artifact of deletedRows) {
    if (artifact.blobPath) {
      if (existsSync(artifact.blobPath)) {
        unlinkBlob(artifact.blobPath);
        deletedFiles++;
      }
    }
  }

  log.debug(
    { executionId, stepId, deletedRows: deletedRows.length, deletedFiles },
    "cleanSlatePriorAttempt: done",
  );

  return { deletedRows: deletedRows.length, deletedFiles };
}

export type ArtifactStorageKind = "template" | "task" | "chat";

function getArtifactKindDir(kind: ArtifactStorageKind, executionId?: string): string {
  const root = getRuntimeRoot();
  if (kind === "template") {
    if (!executionId) throw new Error("template kind requires executionId");
    return join(root, "template-executions", executionId, "artifacts");
  }
  return join(root, "artifacts", kind); // ~/.adam/artifacts/task or ~/.adam/artifacts/chat
}

export function publishBlobByKind(args: {
  kind: ArtifactStorageKind;
  executionId?: string;
  artifactId: string;
  sourcePath: string;
}): { blobPath: string; sizeBytes: number } {
  const dir = getArtifactKindDir(args.kind, args.executionId);
  mkdirSync(dir, { recursive: true });
  const blobPath = join(dir, `${args.artifactId}.bin`);
  copyFileSync(args.sourcePath, blobPath);
  return { blobPath, sizeBytes: statSync(blobPath).size };
}

/**
 * Verify that `path`, after realpath resolution, lies inside the Adam runtime root.
 * Used by chat-artifact-publisher to reject mediaUrls outside ~/.adam.
 * Returns false on any fs error (path missing, EACCES, etc.) — caller logs.
 */
export function isPathInAdamRuntime(path: string): boolean {
  try {
    if (!isAbsolute(path)) return false;
    const resolved = realpathSync(path);
    const root = realpathSync(getRuntimeRoot());
    const normalizedRoot = root.endsWith(sep) ? root : root + sep;
    const normalizedResolved = resolved.endsWith(sep) ? resolved : resolved + sep;
    return normalizedResolved === normalizedRoot || normalizedResolved.startsWith(normalizedRoot);
  } catch {
    return false;
  }
}

// HISTORICAL: this function migrates pre-v26 storage; the SQL identifiers refer to the v26-era table name 'template_execution_artifacts' which is renamed to 'artifacts' in v72. Do not "modernize" these SQL strings.
export function migrateLegacyTemplateExecutionArtifactStorage(database: BetterSqlite3.Database): void {
  const oldRoot = getLegacyTemplateExecutionRoot();
  if (!existsSync(oldRoot)) return;

  const table = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='template_execution_artifacts'",
  ).get() as { name: string } | undefined;
  if (!table) return;

  const rows = database.prepare(`
    SELECT id, execution_id, blob_path
    FROM template_execution_artifacts
    WHERE blob_path IS NOT NULL
  `).all() as Array<{ id: string; execution_id: string; blob_path: string }>;

  const oldPrefix = oldRoot.endsWith(sep) ? oldRoot : oldRoot + sep;
  const newRoot = getTemplateExecutionsRoot();
  const copiedExecutions = new Set<string>();

  for (const row of rows) {
    if (!row.blob_path.startsWith(oldPrefix)) continue;
    const oldExecutionDir = join(oldRoot, row.execution_id);
    const newExecutionDir = join(newRoot, row.execution_id);
    const newBlobPath = join(newRoot, row.blob_path.slice(oldPrefix.length));

    try {
      if (existsSync(oldExecutionDir) && !existsSync(newExecutionDir)) {
        mkdirSync(dirname(newExecutionDir), { recursive: true });
        cpSync(oldExecutionDir, newExecutionDir, { recursive: true, dereference: false, force: false });
      }
      if (!existsSync(newBlobPath)) {
        log.warn({ artifactId: row.id, blobPath: row.blob_path }, "TemplateExecution artifact migration skipped missing copied blob");
        continue;
      }
      database.prepare("UPDATE template_execution_artifacts SET blob_path = ? WHERE id = ?").run(newBlobPath, row.id);
      copiedExecutions.add(row.execution_id);
    } catch (err) {
      log.warn({ err, artifactId: row.id, executionId: row.execution_id }, "TemplateExecution artifact migration failed");
    }
  }

  for (const executionId of copiedExecutions) {
    const newExecutionDir = join(newRoot, executionId);
    if (existsSync(newExecutionDir)) {
      try {
        rmSync(join(oldRoot, executionId), { recursive: true, force: true });
      } catch (err) {
        log.warn({ err, executionId }, "Failed to remove migrated legacy artifact directory");
      }
    }
  }
}
