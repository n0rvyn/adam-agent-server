import { getDb } from "./db.js";
import type { ChatMessage, ChatSource, ChatEnvelopeKind, ApprovalShape, ChatAttachment, DeliveryTarget } from "../shared/types.js";
import { getCurrentTraceId } from "../lib/trace-context.js";

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  source_type: string;
  task_id: string | null;
  channel_message_id: string | null;
  metadata: string | null;
  created_at: number;
  trace_id: string | null;
  kind: string | null;
  parent_message_id: string | null;
  thread_root: string | null;
  prompt_id: string | null;
  approval_shape: string | null;
  role_id: string | null;
  attachments: string | null;
  mirrored_to_targets: string | null;
  platform_message_id: string | null;
  seq: number | null;
  source_channel_id: string | null;
  source_chat_id: string | null;
}

function rowToMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as "user" | "assistant",
    content: row.content,
    source: {
      type: row.source_type as ChatSource["type"],
      ...(row.source_channel_id ? { channelId: row.source_channel_id } : {}),
      ...(row.source_chat_id ? { chatId: row.source_chat_id } : {}),
    },
    taskId: row.task_id ?? undefined,
    channelMessageId: row.channel_message_id ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
    traceId: row.trace_id ?? undefined,
    kind: (row.kind as ChatEnvelopeKind) ?? undefined,
    parentMessageId: row.parent_message_id ?? undefined,
    threadRoot: row.thread_root ?? undefined,
    promptId: row.prompt_id ?? undefined,
    approvalShape: (row.approval_shape as ApprovalShape) ?? undefined,
    roleId: row.role_id ?? undefined,
    attachments: row.attachments ? JSON.parse(row.attachments) as ChatAttachment[] : undefined,
    mirroredToTargets: row.mirrored_to_targets ? JSON.parse(row.mirrored_to_targets) as DeliveryTarget[] : undefined,
    platformMessageId: row.platform_message_id ?? undefined,
    seq: row.seq ?? undefined,
  };
}

export function createMessage(message: ChatMessage): void {
  const db = getDb();
  const kind = message.kind ?? (message.role === "user" ? "user_message" : "assistant_text");
  db.prepare(`
    INSERT INTO chat_messages (
      id, session_id, role, content, source_type, task_id,
      channel_message_id, metadata, created_at, trace_id,
      kind, parent_message_id, thread_root, prompt_id, approval_shape,
      role_id, attachments, mirrored_to_targets, platform_message_id, seq,
      source_channel_id, source_chat_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    message.id,
    message.sessionId,
    message.role,
    message.content,
    message.source.type,
    message.taskId ?? null,
    message.channelMessageId ?? null,
    message.metadata ? JSON.stringify(message.metadata) : null,
    message.createdAt,
    message.traceId ?? getCurrentTraceId() ?? null,
    kind,
    message.parentMessageId ?? null,
    message.threadRoot ?? null,
    message.promptId ?? null,
    message.approvalShape ?? null,
    message.roleId ?? null,
    message.attachments ? JSON.stringify(message.attachments) : null,
    message.mirroredToTargets ? JSON.stringify(message.mirroredToTargets) : null,
    message.platformMessageId ?? null,
    message.seq ?? null,
    message.source.channelId ?? null,
    message.source.chatId ?? null,
  );
}

export function getMessage(id: string): ChatMessage | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as MessageRow | undefined;
  return row ? rowToMessage(row) : undefined;
}

export function getMessagesBySession(sessionId: string, limit = 100, offset = 0): ChatMessage[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?",
  ).all(sessionId, limit, offset) as MessageRow[];
  return rows.map(rowToMessage);
}

export function getAllMessagesBySession(sessionId: string): ChatMessage[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC",
  ).all(sessionId) as MessageRow[];
  return rows.map(rowToMessage);
}

export function getRecentMessages(sessionId: string, turnCount: number): ChatMessage[] {
  const db = getDb();
  // Get last N messages ordered newest first, then reverse for chronological order
  const rows = db.prepare(
    "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
  ).all(sessionId, turnCount) as MessageRow[];
  return rows.reverse().map(rowToMessage);
}

export function deleteMessage(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM chat_messages WHERE id = ?").run(id);
}

export function deleteMessagesBySession(sessionId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM chat_messages WHERE session_id = ?").run(sessionId);
}

export function findMessageByTaskId(taskId: string): ChatMessage | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM chat_messages WHERE task_id = ? LIMIT 1").get(taskId) as MessageRow | undefined;
  return row ? rowToMessage(row) : undefined;
}

export function getMessagesByChannel(channelId: string, limit = 50, offset = 0): ChatMessage[] {
  const db = getDb();
  // Query messages from sessions linked to this channel
  const rows = db.prepare(`
    SELECT m.* FROM chat_messages m
    JOIN chat_sessions s ON m.session_id = s.id
    WHERE s.source_type = 'channel' AND s.source_channel_id = ?
    ORDER BY m.created_at DESC LIMIT ? OFFSET ?
  `).all(channelId, limit, offset) as MessageRow[];
  return rows.map(rowToMessage);
}

export function countMessagesBySession(sessionId: string): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM chat_messages WHERE session_id = ?").get(sessionId) as { count: number };
  return row.count;
}

export function updatePlatformMessageId(messageId: string, platformMessageId: string): void {
  const db = getDb();
  db.prepare("UPDATE chat_messages SET platform_message_id = ? WHERE id = ?").run(platformMessageId, messageId);
}

export function findEnvelopeByPlatformMessageId(
  platformMessageId: string,
): ChatMessage | undefined {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM chat_messages WHERE platform_message_id = ? ORDER BY created_at DESC LIMIT 1",
  ).get(platformMessageId) as MessageRow | undefined;
  return row ? rowToMessage(row) : undefined;
}

export function findEnvelopesByPromptId(promptId: string): ChatMessage[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM chat_messages WHERE prompt_id = ? ORDER BY created_at ASC",
  ).all(promptId) as MessageRow[];
  return rows.map(rowToMessage);
}

export function updateMessagePromptBinding(messageId: string, promptId: string): void {
  const db = getDb();
  db.prepare("UPDATE chat_messages SET prompt_id = ? WHERE id = ?").run(promptId, messageId);
}

/**
 * Update the cost columns on a chat_messages row (v85 schema).
 * Called by recordLlmCost when source='chat' and mirror=true.
 */
export function updateMessageCost(
  messageId: string,
  opts: { costUsd: number; tokenUsage: string | null; model: string }
): void {
  const db = getDb();
  db.prepare(
    "UPDATE chat_messages SET cost_usd = ?, token_usage = ?, model = ? WHERE id = ?"
  ).run(opts.costUsd, opts.tokenUsage, opts.model, messageId);
}
