import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import type { ApprovalShape, PromptResolvedVia, PromptExpiredReason } from "../shared/types.js";
import { getLogger } from "../lib/logger.js";

// Use the existing "store" LogComponent (src/shared/types.ts:LogComponent union)
// rather than introducing a new component name; keeps logger.ts components Record consistent.
const log = getLogger("store");

const PROMPT_ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PROMPT_ID_LENGTH = 4;
const PROMPT_ID_COLLISION_RETRIES = 5;

export interface PendingPrompt {
  id: string;
  sessionId: string;
  taskId?: string;
  messageId: string;
  shape: ApprovalShape;
  expectedShapeJson?: unknown;
  askedAt: number;
  expiresAt: number;
  resolvedAt?: number;
  resolvedByMessageId?: string;
  resolvedVia?: PromptResolvedVia;
  resolvedValue?: string;
  expiredReason?: PromptExpiredReason;
}

interface PendingPromptRow {
  id: string;
  session_id: string;
  task_id: string | null;
  message_id: string;
  shape: string;
  expected_shape_json: string | null;
  asked_at: number;
  expires_at: number;
  resolved_at: number | null;
  resolved_by_message_id: string | null;
  resolved_via: string | null;
  resolved_value: string | null;
  expired_reason: string | null;
}

function rowToPrompt(row: PendingPromptRow): PendingPrompt {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id ?? undefined,
    messageId: row.message_id,
    shape: row.shape as ApprovalShape,
    expectedShapeJson: row.expected_shape_json ? JSON.parse(row.expected_shape_json) : undefined,
    askedAt: row.asked_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedByMessageId: row.resolved_by_message_id ?? undefined,
    resolvedVia: (row.resolved_via as PromptResolvedVia) ?? undefined,
    resolvedValue: row.resolved_value ?? undefined,
    expiredReason: (row.expired_reason as PromptExpiredReason) ?? undefined,
  };
}

/**
 * Generate a 4-char prompt_id unique within the given session's open (unresolved) prompts.
 * Retries up to 5 times on collision, then falls back to UUID first 8 hex chars.
 */
export function generatePromptId(sessionId: string): string {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT 1 FROM pending_prompts
    WHERE session_id = ? AND id = ? AND resolved_at IS NULL
    LIMIT 1
  `);

  for (let attempt = 0; attempt < PROMPT_ID_COLLISION_RETRIES; attempt++) {
    const id = randomBase32(PROMPT_ID_LENGTH);
    const collision = stmt.get(sessionId, id);
    if (!collision) return id;
  }

  const fallback = uuidv4().replace(/-/g, "").slice(0, 8).toUpperCase();
  log.warn({ sessionId, fallback }, "prompt_id 4-char base32 collision retries exhausted; falling back to 8-hex UUID prefix");
  return fallback;
}

function randomBase32(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += PROMPT_ID_ALPHABET[Math.floor(Math.random() * PROMPT_ID_ALPHABET.length)];
  }
  return out;
}

export function createPendingPrompt(prompt: PendingPrompt): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO pending_prompts (
      id, session_id, task_id, message_id, shape, expected_shape_json,
      asked_at, expires_at, resolved_at, resolved_by_message_id,
      resolved_via, resolved_value, expired_reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    prompt.id,
    prompt.sessionId,
    prompt.taskId ?? null,
    prompt.messageId,
    prompt.shape,
    prompt.expectedShapeJson !== undefined ? JSON.stringify(prompt.expectedShapeJson) : null,
    prompt.askedAt,
    prompt.expiresAt,
    prompt.resolvedAt ?? null,
    prompt.resolvedByMessageId ?? null,
    prompt.resolvedVia ?? null,
    prompt.resolvedValue ?? null,
    prompt.expiredReason ?? null,
  );
}

export function getPendingPrompt(id: string): PendingPrompt | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM pending_prompts WHERE id = ?").get(id) as PendingPromptRow | undefined;
  return row ? rowToPrompt(row) : undefined;
}

export function listOpenPromptsBySession(sessionId: string): PendingPrompt[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM pending_prompts
    WHERE session_id = ? AND resolved_at IS NULL AND expired_reason IS NULL
    ORDER BY asked_at ASC
  `).all(sessionId) as PendingPromptRow[];
  return rows.map(rowToPrompt);
}

export function listOpenPromptsByTask(taskId: string): PendingPrompt[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM pending_prompts
    WHERE task_id = ? AND resolved_at IS NULL AND expired_reason IS NULL
  `).all(taskId) as PendingPromptRow[];
  return rows.map(rowToPrompt);
}

export function resolvePendingPrompt(
  id: string,
  resolvedByMessageId: string,
  resolvedVia: PromptResolvedVia,
  resolvedValue: string,
): void {
  const db = getDb();
  db.prepare(`
    UPDATE pending_prompts
    SET resolved_at = ?, resolved_by_message_id = ?, resolved_via = ?, resolved_value = ?
    WHERE id = ? AND resolved_at IS NULL
  `).run(Date.now(), resolvedByMessageId, resolvedVia, resolvedValue, id);
}

export function expirePendingPrompt(id: string, reason: PromptExpiredReason): void {
  const db = getDb();
  db.prepare(`
    UPDATE pending_prompts
    SET expired_reason = ?
    WHERE id = ? AND resolved_at IS NULL AND expired_reason IS NULL
  `).run(reason, id);
}

export function listExpiredOpenPrompts(now: number): PendingPrompt[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM pending_prompts
    WHERE resolved_at IS NULL AND expired_reason IS NULL AND expires_at < ?
  `).all(now) as PendingPromptRow[];
  return rows.map(rowToPrompt);
}
