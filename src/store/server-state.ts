import { getDb } from "./db.js";
import type { ServerState } from "../shared/types.js";

interface ServerStateRow {
  id: number;
  // sdk_session_id, tools_fingerprint columns intentionally not declared here:
  // they exist in DB but are no longer read or written by runtime code (issue #221 cleanup).
  user_task_session_id: string | null;
  workspace_path: string | null;
  created_at: number;
  last_active_at: number | null;
}

function rowToServerState(row: ServerStateRow): ServerState {
  return {
    id: row.id,
    userTaskSessionId: row.user_task_session_id ?? undefined,
    workspacePath: row.workspace_path ?? undefined,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at ?? undefined,
  };
}

export function getServerState(): ServerState {
  const db = getDb();
  const row = db.prepare("SELECT * FROM server_state WHERE id = 1").get() as
    | ServerStateRow
    | undefined;

  if (row) return rowToServerState(row);

  // Create default row
  const now = Date.now();
  db.prepare(
    "INSERT INTO server_state (id, created_at) VALUES (1, ?)",
  ).run(now);

  return { id: 1, createdAt: now };
}

export function updateServerState(
  updates: Partial<Pick<ServerState, "userTaskSessionId" | "workspacePath" | "lastActiveAt">>,
): void {
  const db = getDb();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if ("userTaskSessionId" in updates) {
    setClauses.push("user_task_session_id = ?");
    values.push(updates.userTaskSessionId ?? null);
  }
  if ("workspacePath" in updates) {
    setClauses.push("workspace_path = ?");
    values.push(updates.workspacePath ?? null);
  }
  if ("lastActiveAt" in updates) {
    setClauses.push("last_active_at = ?");
    values.push(updates.lastActiveAt ?? null);
  }

  if (setClauses.length === 0) return;

  // Ensure row exists
  getServerState();

  values.push(1);
  db.prepare(
    `UPDATE server_state SET ${setClauses.join(", ")} WHERE id = ?`,
  ).run(...values);
}

// updateSdkSessionId / clearSdkSessionId removed (issue #221 cleanup): no production callers
// after ChatManager dropped SDK session persistence. DB columns retained.

export function updateUserTaskSessionId(sessionId: string | undefined): void {
  updateServerState({ userTaskSessionId: sessionId, lastActiveAt: Date.now() });
}

export function updateWorkspacePath(path: string): void {
  updateServerState({ workspacePath: path });
}
