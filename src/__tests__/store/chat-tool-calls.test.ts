/**
 * Unit tests for `chat_tool_calls` store API.
 * Task 2 of Phase C: chatmanager-truth plan.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  recordChatToolCall,
  listChatToolCallsByTrace,
  hasAnyToolCallInTurn,
} from "../../store/chat-tool-calls.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

describe("chat_tool_calls store", () => {
  // ---- schema check ----

  it("chat_tool_calls table exists after setupTestDb", () => {
    const db = getTestDb();
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chat_tool_calls'"
    ).get();
    expect(table).toBeTruthy();
  });

  it("chat_tool_calls has expected columns", () => {
    const db = getTestDb();
    const cols = db.prepare("PRAGMA table_info(chat_tool_calls)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("trace_id");
    expect(colNames).toContain("session_id");
    expect(colNames).toContain("tool_name");
    expect(colNames).toContain("tool_input_json");
    expect(colNames).toContain("tool_output_summary");
    expect(colNames).toContain("called_at");
  });

  it("chat_tool_calls has expected indexes", () => {
    const db = getTestDb();
    const indexes = db.prepare("PRAGMA index_list('chat_tool_calls')").all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames.some((n) => n.includes("trace"))).toBe(true);
    expect(indexNames.some((n) => n.includes("session"))).toBe(true);
  });

  // ---- recordChatToolCall ----

  it("records and lists tool calls by trace_id (JSON parsed back)", () => {
    const traceId = "trace-record-test";
    const call1 = recordChatToolCall({
      traceId,
      sessionId: "s-1",
      toolName: "query_delivery_history",
      toolInput: { channelId: "ch-1" },
      toolOutputSummary: "5 deliveries",
      calledAt: 1_700_000_000_000,
    });
    const call2 = recordChatToolCall({
      traceId,
      sessionId: "s-1",
      toolName: "query_execution_status",
      toolInput: { executionId: "exec-1" },
      toolOutputSummary: "running",
      calledAt: 1_700_000_000_001,
    });

    const rows = listChatToolCallsByTrace(traceId);
    expect(rows).toHaveLength(2);
    expect(rows[0].toolName).toBe("query_delivery_history");
    expect(rows[0].sessionId).toBe("s-1");
    expect(rows[0].toolInput).toEqual({ channelId: "ch-1" });
    expect(rows[1].toolName).toBe("query_execution_status");
  });

  // ---- hasAnyToolCallInTurn ----

  it("returns true when any matching tool name is present", () => {
    const traceId = "trace-hasany-test";
    recordChatToolCall({ traceId, toolName: "query_delivery_history", calledAt: 1_700_000_000_000 });

    expect(hasAnyToolCallInTurn(traceId, ["query_delivery_history"])).toBe(true);
    expect(hasAnyToolCallInTurn(traceId, ["query_execution_status", "query_delivery_history"])).toBe(true);
  });

  it("returns false for empty toolNames array without touching DB", () => {
    const traceId = "trace-empty-tools";
    recordChatToolCall({ traceId, toolName: "query_delivery_history", calledAt: 1_700_000_000_000 });

    // Passing empty array must return false and not throw
    expect(hasAnyToolCallInTurn(traceId, [])).toBe(false);
  });

  // ---- trace isolation ----

  it("different traces do not leak", () => {
    const traceA = "trace-a";
    const traceB = "trace-b";
    recordChatToolCall({ traceId: traceA, toolName: "query_delivery_history", calledAt: 1_700_000_000_000 });
    recordChatToolCall({ traceId: traceB, toolName: "query_execution_status", calledAt: 1_700_000_000_001 });

    const rowsA = listChatToolCallsByTrace(traceA);
    const rowsB = listChatToolCallsByTrace(traceB);

    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].toolName).toBe("query_delivery_history");
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].toolName).toBe("query_execution_status");
  });
});
