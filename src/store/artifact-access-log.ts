import { getLogger } from "../lib/logger.js";
import { getDb } from "./db.js";

export type ArtifactAccessOutcome = "success" | "denied" | "error";

export interface ArtifactAccessLogEntry {
  timestamp: number;
  taskId?: string;
  roleId?: string;
  executionId: string;
  stepId?: string;
  tool: string;
  artifactKey?: string;
  artifactId?: string;
  sizeBytes?: number;
  outcome: ArtifactAccessOutcome;
  errorReason?: string;
}

interface ArtifactAccessLogRow {
  timestamp: number;
  task_id: string | null;
  role_id: string | null;
  execution_id: string;
  step_id: string | null;
  tool: string;
  artifact_key: string | null;
  artifact_id: string | null;
  size_bytes: number | null;
  outcome: string;
  error_reason: string | null;
}

const log = getLogger("audit");

function rowToEntry(row: ArtifactAccessLogRow): ArtifactAccessLogEntry {
  return {
    timestamp: row.timestamp,
    taskId: row.task_id ?? undefined,
    roleId: row.role_id ?? undefined,
    executionId: row.execution_id,
    stepId: row.step_id ?? undefined,
    tool: row.tool,
    artifactKey: row.artifact_key ?? undefined,
    artifactId: row.artifact_id ?? undefined,
    sizeBytes: row.size_bytes ?? undefined,
    outcome: row.outcome as ArtifactAccessOutcome,
    errorReason: row.error_reason ?? undefined,
  };
}

export function logArtifactAccess(entry: ArtifactAccessLogEntry): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO artifact_access_log (
        timestamp, task_id, role_id, execution_id, step_id, tool, artifact_key, artifact_id,
        size_bytes, outcome, error_reason
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.timestamp,
      entry.taskId ?? null,
      entry.roleId ?? null,
      entry.executionId,
      entry.stepId ?? null,
      entry.tool,
      entry.artifactKey ?? null,
      entry.artifactId ?? null,
      entry.sizeBytes ?? null,
      entry.outcome,
      entry.errorReason ?? null,
    );
  } catch (err) {
    log.error({ err, entry }, "Failed to write artifact access log");
  }
}

export function listAccessLogByExecution(
  executionId: string,
  limit = 200,
): ArtifactAccessLogEntry[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT timestamp, task_id, role_id, execution_id, step_id, tool, artifact_key, artifact_id,
           size_bytes, outcome, error_reason
    FROM artifact_access_log
    WHERE execution_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(executionId, limit) as ArtifactAccessLogRow[];
  return rows.map(rowToEntry);
}
