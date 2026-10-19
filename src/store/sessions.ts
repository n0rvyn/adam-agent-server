import { getDb } from "./db.js";
import type { ChatSession, ChatSessionStatus, ChatSource } from "../shared/types.js";

interface SessionRow {
  id: string;
  status: string;
  source_type: string;
  source_channel_id: string | null;
  source_chat_id: string | null;
  title: string | null;
  created_at: number;
  last_active_at: number;
  archived_at: number | null;
  message_count: number;
  sdk_session_id: string | null;
}

function rowToSession(row: SessionRow): ChatSession {
  return {
    id: row.id,
    status: row.status as ChatSessionStatus,
    source: {
      type: row.source_type as ChatSource["type"],
      channelId: row.source_channel_id ?? undefined,
      chatId: row.source_chat_id ?? undefined,
    },
    title: row.title ?? undefined,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    archivedAt: row.archived_at ?? undefined,
    messageCount: row.message_count,
    sdkSessionId: row.sdk_session_id ?? undefined,
  };
}

export function createSession(session: ChatSession): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO chat_sessions (id, status, source_type, source_channel_id, source_chat_id,
      title, created_at, last_active_at, archived_at, message_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id,
    session.status,
    session.source.type,
    session.source.channelId ?? null,
    session.source.chatId ?? null,
    session.title ?? null,
    session.createdAt,
    session.lastActiveAt,
    session.archivedAt ?? null,
    session.messageCount,
  );
}

export function getSession(id: string): ChatSession | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id) as SessionRow | undefined;
  return row ? rowToSession(row) : undefined;
}

export function updateSession(id: string, updates: Partial<Pick<ChatSession, "status" | "title" | "lastActiveAt" | "archivedAt" | "messageCount">>): void {
  const db = getDb();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) { setClauses.push("status = ?"); values.push(updates.status); }
  if (updates.title !== undefined) { setClauses.push("title = ?"); values.push(updates.title); }
  if (updates.lastActiveAt !== undefined) { setClauses.push("last_active_at = ?"); values.push(updates.lastActiveAt); }
  if ("archivedAt" in updates) { setClauses.push("archived_at = ?"); values.push(updates.archivedAt ?? null); }
  if (updates.messageCount !== undefined) { setClauses.push("message_count = ?"); values.push(updates.messageCount); }

  if (setClauses.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE chat_sessions SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

export function listSessions(status?: ChatSessionStatus, limit = 100, offset = 0): ChatSession[] {
  const db = getDb();
  if (status) {
    const rows = db.prepare("SELECT * FROM chat_sessions WHERE status = ? ORDER BY last_active_at DESC LIMIT ? OFFSET ?").all(status, limit, offset) as SessionRow[];
    return rows.map(rowToSession);
  }
  const rows = db.prepare("SELECT * FROM chat_sessions ORDER BY last_active_at DESC LIMIT ? OFFSET ?").all(limit, offset) as SessionRow[];
  return rows.map(rowToSession);
}

export function findSessionBySource(source: ChatSource): ChatSession | undefined {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM chat_sessions WHERE status = 'active' AND source_type = ? AND source_channel_id IS ? AND source_chat_id IS ? LIMIT 1",
  ).get(source.type, source.channelId ?? null, source.chatId ?? null) as SessionRow | undefined;
  return row ? rowToSession(row) : undefined;
}

export function updateSessionSdkId(id: string, sdkSessionId: string): void {
  const db = getDb();
  db.prepare("UPDATE chat_sessions SET sdk_session_id = ? WHERE id = ?").run(sdkSessionId, id);
}

export function deleteSession(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
}
