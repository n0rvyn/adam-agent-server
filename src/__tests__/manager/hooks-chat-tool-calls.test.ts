/**
 * Unit tests for PostToolUse hook — ChatManager branch (chat_tool_calls logging).
 * Task 3 of Phase C: chatmanager-truth plan.
 *
 * Covers:
 * - Writes chat_tool_calls when getChatSessionId() returns a string and currentTaskId is absent
 * - Does NOT write chat_tool_calls when currentTaskId is absent AND getChatSessionId() returns undefined
 * - Writes step_logs (not chat_tool_calls) when currentTaskId is set (Branch 1 wins)
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Spy on createStepLog to verify Branch 1 is exercised
const mockCreateStepLog = vi.fn();
vi.mock("../../store/logs.js", () => ({
  createStepLog: mockCreateStepLog,
}));

// Spy on recordChatToolCall to verify Branch 2 is exercised
const mockRecordChatToolCall = vi.fn();
vi.mock("../../store/chat-tool-calls.js", () => ({
  recordChatToolCall: mockRecordChatToolCall,
}));

// Spy on getCurrentTraceId — will be called from inside the hook
const mockGetCurrentTraceId = vi.fn();
vi.mock("../../lib/trace-context.js", () => ({
  getCurrentTraceId: mockGetCurrentTraceId,
  withNewTrace: vi.fn((_origin: string, fn: () => unknown) => fn()),
  withTrace: vi.fn((_id: string, _origin: string, fn: () => unknown) => fn()),
  getTraceStore: vi.fn(),
}));

// Mock diagnostics to prevent test noise (matches production import path in hooks.ts Branch 2)
vi.mock("../../store/audit-diagnostics.js", () => ({
  recordAuditDiagnostic: vi.fn().mockResolvedValue(undefined),
}));

const { buildSessionHooks } = await import("../../manager/hooks.js");

// Helper: call the PostToolUse hook directly
async function invokePostToolUse(
  ctx: Parameters<typeof buildSessionHooks>[0],
  toolName: string,
  toolInput?: Record<string, unknown>,
  toolResponse?: unknown,
) {
  const hooks = buildSessionHooks(ctx);
  const callbacks = hooks.PostToolUse?.[0]?.hooks;
  if (!callbacks || callbacks.length === 0) throw new Error("PostToolUse hook missing");
  await callbacks[0]({
    tool_name: toolName,
    tool_input: toolInput ?? {},
    tool_response: toolResponse ?? { result: "ok" },
  } as any, undefined, {} as any);
}

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  mockCreateStepLog.mockReset();
  mockRecordChatToolCall.mockReset();
  mockGetCurrentTraceId.mockReset();
});

describe("PostToolUse — ChatManager branch (chat_tool_calls)", () => {

  it("writes chat_tool_calls when getChatSessionId() returns a string and currentTaskId is absent", async () => {
    mockGetCurrentTraceId.mockReturnValue("trace-chat-branch");

    await invokePostToolUse(
      { getChatSessionId: () => "s-1" },
      "query_delivery_history",
      { channelId: "ch-1" },
      { items: [], counts: { total: 0 } },
    );

    expect(mockRecordChatToolCall).toHaveBeenCalledOnce();
    expect(mockRecordChatToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "trace-chat-branch",
        sessionId: "s-1",
        toolName: "query_delivery_history",
        toolInput: { channelId: "ch-1" },
      }),
    );
    // Branch 1 (step_logs) must NOT be reached
    expect(mockCreateStepLog).not.toHaveBeenCalled();
  });

  it("does NOT write chat_tool_calls when currentTaskId is absent AND getChatSessionId() returns undefined", async () => {
    mockGetCurrentTraceId.mockReturnValue("trace-no-session");

    await invokePostToolUse(
      { getChatSessionId: () => undefined },
      "query_delivery_history",
      {},
      { items: [] },
    );

    expect(mockRecordChatToolCall).not.toHaveBeenCalled();
    expect(mockCreateStepLog).not.toHaveBeenCalled();
  });

  it("writes step_logs (not chat_tool_calls) when currentTaskId is set — Branch 1 wins", async () => {
    mockGetCurrentTraceId.mockReturnValue("trace-em-branch");

    await invokePostToolUse(
      { currentTaskId: "task-123", getChatSessionId: () => "s-1" },
      "query_delivery_history",
      { channelId: "ch-1" },
      { items: [] },
    );

    expect(mockCreateStepLog).toHaveBeenCalledOnce();
    expect(mockCreateStepLog).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-123", toolName: "query_delivery_history" }),
    );
    expect(mockRecordChatToolCall).not.toHaveBeenCalled();

    // Also verify chat_tool_calls table has zero rows for this trace
    const db = getTestDb();
    const rows = db.prepare("SELECT * FROM chat_tool_calls WHERE trace_id = ?").all("trace-em-branch");
    expect(rows).toHaveLength(0);
  });

  it("skips silently when traceId is falsy (recordChatToolCall not called)", async () => {
    mockGetCurrentTraceId.mockReturnValue(undefined);

    await invokePostToolUse(
      { getChatSessionId: () => "s-1" },
      "query_delivery_history",
      {},
      { items: [] },
    );

    expect(mockRecordChatToolCall).not.toHaveBeenCalled();
  });

  it("fail-open when recordChatToolCall throws — does not propagate", async () => {
    mockGetCurrentTraceId.mockReturnValue("trace-fail-open");
    mockRecordChatToolCall.mockImplementationOnce(() => {
      throw new Error("DB write error");
    });

    // Must not throw
    await invokePostToolUse(
      { getChatSessionId: () => "s-1" },
      "query_delivery_history",
      {},
      { items: [] },
    );

    expect(mockRecordChatToolCall).toHaveBeenCalledOnce();
    // No error propagated
  });
});
