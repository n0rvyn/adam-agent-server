/**
 * `chat_tool_calls` store — ChatManager tool-call observability for L2 pre-flight gate.
 * Task 2 of Phase C: chatmanager-truth plan.
 */
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import type Database from "better-sqlite3";

// ---- Types ----

export interface ChatToolCallInput {
  traceId: string;
  sessionId?: string;
  toolName: string;
  toolInput?: unknown;
  toolOutputSummary?: string;
  calledAt?: number;
}

export interface ChatToolCall {
  id: string;
  traceId: string;
  sessionId?: string;
  toolName: string;
  toolInput?: unknown;
  toolOutputSummary?: string;
  calledAt: number;
}

// ---- Prepared statements (module-level cache) ----

type StmtInsert = Database.Statement<[string, string, string | null, string, string | null, string | null, number]>;
type StmtByTrace = Database.Statement<[string]>;

let _insert: StmtInsert | undefined;
let _byTrace: StmtByTrace | undefined;

function getInsert(): StmtInsert {
  if (!_insert) {
    _insert = getDb().prepare(
      `INSERT INTO chat_tool_calls (id, trace_id, session_id, tool_name, tool_input_json, tool_output_summary, called_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ) as StmtInsert;
  }
  return _insert;
}

function getByTrace(): StmtByTrace {
  if (!_byTrace) {
    _byTrace = getDb().prepare(
      `SELECT * FROM chat_tool_calls WHERE trace_id = ? ORDER BY called_at ASC`
    ) as StmtByTrace;
  }
  return _byTrace;
}

// ---- Public API ----

/**
 * Insert a chat-tool-call row.
 * Serializes `toolInput` via JSON.stringify; callers truncate `toolOutputSummary` to 500 chars.
 */
export function recordChatToolCall(input: ChatToolCallInput): ChatToolCall {
  const id = uuidv4();
  const calledAt = input.calledAt ?? Date.now();
  const toolInputJson = input.toolInput !== undefined ? JSON.stringify(input.toolInput) : null;

  getInsert().run(
    id,
    input.traceId,
    input.sessionId ?? null,
    input.toolName,
    toolInputJson,
    input.toolOutputSummary ?? null,
    calledAt,
  );

  return {
    id,
    traceId: input.traceId,
    sessionId: input.sessionId,
    toolName: input.toolName,
    toolInput: input.toolInput,
    toolOutputSummary: input.toolOutputSummary,
    calledAt,
  };
}

/**
 * List all tool calls for a trace, ordered by called_at asc.
 * Re-hydrates toolInput via safe JSON parse.
 */
export function listChatToolCallsByTrace(traceId: string): ChatToolCall[] {
  const rows = getByTrace().all(traceId) as Array<{
    id: string;
    trace_id: string;
    session_id: string | null;
    tool_name: string;
    tool_input_json: string | null;
    tool_output_summary: string | null;
    called_at: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    traceId: row.trace_id,
    sessionId: row.session_id ?? undefined,
    toolName: row.tool_name,
    toolInput: row.tool_input_json ? safeJsonParse(row.tool_input_json) : undefined,
    toolOutputSummary: row.tool_output_summary ?? undefined,
    calledAt: row.called_at,
  }));
}

/**
 * Returns true if any row exists for the trace with tool_name IN the given names.
 * Empty toolNames array returns false without touching the DB.
 */
export function hasAnyToolCallInTurn(traceId: string, toolNames: readonly string[]): boolean {
  if (toolNames.length === 0) return false;
  const placeholders = toolNames.map(() => "?").join(",");
  const sql = `SELECT 1 FROM chat_tool_calls WHERE trace_id = ? AND tool_name IN (${placeholders}) LIMIT 1`;
  const row = getDb().prepare(sql).get(traceId, ...toolNames) as { "1": number } | undefined;
  return row !== undefined;
}

// ---- Internal helpers ----

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// Re-export Database.Statement type for use in prepared-statement typing above
