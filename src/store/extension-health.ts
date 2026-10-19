import type BetterSqlite3 from "better-sqlite3";

// ── ExtensionHealth entity ────────────────────────────────────────────────────

export interface ExtensionHealth {
  extensionId: string;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
  lastRoleId: string | null;
  lastTaskId: string | null;
}

interface ExtensionHealthRow {
  extension_id: string;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  last_role_id: string | null;
  last_task_id: string | null;
}

function rowToHealth(row: ExtensionHealthRow): ExtensionHealth {
  return {
    extensionId: row.extension_id,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastRoleId: row.last_role_id,
    lastTaskId: row.last_task_id,
  };
}

// ── Upsert ───────────────────────────────────────────────────────────────────

export interface UpsertHealthPayload {
  extensionId: string;
  lastRunAt: number;
  lastStatus: string;
  lastError?: string | null;
  lastRoleId: string;
  lastTaskId: string;
}

export function upsertHealth(
  db: BetterSqlite3.Database,
  payload: UpsertHealthPayload,
): ExtensionHealth {
  const {
    extensionId,
    lastRunAt,
    lastStatus,
    lastError = null,
    lastRoleId,
    lastTaskId,
  } = payload;

  db.prepare(
    `INSERT INTO extension_health
       (extension_id, last_run_at, last_status, last_error, last_role_id, last_task_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(extension_id) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       last_status = excluded.last_status,
       last_error  = excluded.last_error,
       last_role_id = excluded.last_role_id,
       last_task_id = excluded.last_task_id`,
  ).run(extensionId, lastRunAt, lastStatus, lastError, lastRoleId, lastTaskId);

  return rowToHealth(
    db
      .prepare<string, ExtensionHealthRow>(
        "SELECT * FROM extension_health WHERE extension_id = ?",
      )
      .get(extensionId)!,
  );
}

// ── Readers ──────────────────────────────────────────────────────────────────

export function getHealth(
  db: BetterSqlite3.Database,
  extensionId: string,
): ExtensionHealth | null {
  const row = db
    .prepare<string, ExtensionHealthRow>(
      "SELECT * FROM extension_health WHERE extension_id = ?",
    )
    .get(extensionId);
  return row ? rowToHealth(row) : null;
}

export function listHealth(db: BetterSqlite3.Database): ExtensionHealth[] {
  const rows = db
    .prepare<[], ExtensionHealthRow>("SELECT * FROM extension_health")
    .all();
  return rows.map(rowToHealth);
}
