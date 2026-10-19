import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import type { SnapshotDiff, DiffEntry } from "../platform/workspace-snapshot.js";

export interface TaskFileRow {
  id: string;
  task_id: string;
  path: string;
  op: "added" | "modified" | "deleted";
  mtime_ns: bigint | null;
  size_bytes: number | null;
  /** bigint | null — column is INTEGER and reads via safeIntegers(true) return BigInt for values > 2^53. */
  inode: bigint | null;
  created_at: number;
}

/**
 * Insert all entries from a SnapshotDiff into task_files for the given taskId.
 * No-op if the diff is entirely empty.
 */
export function insertTaskFilesDiff(taskId: string, d: SnapshotDiff): void {
  if (d.added.length === 0 && d.modified.length === 0 && d.deleted.length === 0) {
    return;
  }

  const db = getDb();
  // .safeIntegers(true) is required on the INSERT statement so bigint mtime_ns values
  // are bound as 64-bit integers without floating-point precision loss.
  const stmt = db.prepare(
    "INSERT INTO task_files (id, task_id, path, op, mtime_ns, size_bytes, inode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  stmt.safeIntegers(true);

  const now = Date.now();

  db.transaction(() => {
    const insertEntry = (entry: DiffEntry, op: "added" | "modified") => {
      stmt.run(
        randomUUID(),
        taskId,
        entry.path,
        op,
        entry.mtime_ns, // bigint bound directly via safeIntegers(true)
        entry.size,
        entry.inode,
        now,
      );
    };

    for (const entry of d.added) {
      insertEntry(entry, "added");
    }
    for (const entry of d.modified) {
      insertEntry(entry, "modified");
    }
    for (const path of d.deleted) {
      stmt.run(randomUUID(), taskId, path, "deleted", null, null, null, now);
    }
  })();
}

/**
 * Return all task_files rows for a task, ordered by created_at, path.
 * mtime_ns is returned as bigint (safeIntegers mode) so callers get exact precision.
 */
export function getTaskFiles(taskId: string): TaskFileRow[] {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM task_files WHERE task_id = ? ORDER BY created_at, path");
  stmt.safeIntegers(true);
  return stmt.all(taskId) as TaskFileRow[];
}

/**
 * Return all task_files rows touching a given path, across all tasks, ordered by created_at.
 * mtime_ns is returned as bigint (safeIntegers mode).
 */
export function queryTaskFilesByPath(path: string): TaskFileRow[] {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM task_files WHERE path = ? ORDER BY created_at");
  stmt.safeIntegers(true);
  return stmt.all(path) as TaskFileRow[];
}
