/**
 * Task 1-tests: Per-turn trace propagation — failing tests
 *
 * These tests pin the frozen-trace bug: when two turns are pushed through a LiveSession,
 * tool-call rows and effect-receipt rows must land under each turn's OWN traceId, NOT the
 * construction-time ALS context that the reader-loop inherits.
 *
 * Expected result BEFORE Task 1-impl: FAIL
 *   - listChatToolCallsByTrace("trace-B") returns [] (rows under frozen "ctor-trace")
 *   - listReceiptsByTrace("trace-B") returns [] (same reason)
 * Expected result AFTER Task 1-impl: PASS (rows under correct per-turn trace)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
afterAll(() => cleanup());

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock the SDK — tool() must preserve name/handler for the test to invoke
const { mockTool, mockCreateSdkMcpServer } = vi.hoisted(() => {
  const mockTool = vi.fn().mockImplementation(
    (name: string, _desc: string, _schema: unknown, handler: unknown) => ({ name, handler }),
  );
  const mockCreateSdkMcpServer = vi.fn().mockImplementation((cfg: { tools: unknown }) => ({
    tools: cfg.tools,
  }));
  return { mockTool, mockCreateSdkMcpServer };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

// Minimal mocks needed by adam-tools imports
vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({ defaults: {} }),
  updateMutableConfig: vi.fn(),
}));
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
}));
vi.mock("../../lib/task-dispatch.js", () => ({
  createTaskWithAdmission: vi.fn(),
}));
vi.mock("../../manager/skill-registry.js", () => ({
  SkillRegistry: { query: vi.fn().mockReturnValue([]), match: vi.fn().mockReturnValue([]) },
}));
vi.mock("../../store/role-workspace.js", async () => {
  const actual = await vi.importActual<typeof import("../../store/role-workspace.js")>("../../store/role-workspace.js");
  return { ...actual, getRoleWorkspacePath: vi.fn(() => "/tmp/test-role-ws") };
});
vi.mock("../../lib/artifact-storage.js", () => ({
  publishBlob: vi.fn().mockReturnValue({ blobPath: "/tmp/blob", sizeBytes: 1 }),
  unlinkSourceFileStrict: vi.fn(),
  unlinkBlob: vi.fn(),
  fetchBlob: vi.fn(),
  validatePathInWorkspace: vi.fn(),
}));
vi.mock("../../store/audit-diagnostics.js", () => ({
  recordAuditDiagnostic: vi.fn().mockResolvedValue(undefined),
}));

import type { SDKUserMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { LiveSession } from "../../manager/live-session.js";
import { buildSessionHooks } from "../../manager/hooks.js";
import { createAdamTools } from "../../manager/adam-tools.js";
import { withTrace } from "../../lib/trace-context.js";
import { listChatToolCallsByTrace } from "../../store/chat-tool-calls.js";
import { listReceiptsByTrace } from "../../store/effect-receipts.js";

/**
 * Build a mock QueryFn whose behavior can be controlled per turn.
 * Each element in `turns` is a callback that receives the user message content
 * and returns the sequence of SDK messages to emit for that turn.
 */
function makeMockQuery(
  turns: Array<(content: string, postToolUseHook: (toolName: string, input: unknown, output: unknown) => Promise<void>, toolHandlers: Map<string, (args: unknown) => Promise<unknown>>) => AsyncGenerator<SDKMessage>>,
  postToolUseHook: (toolName: string, input: unknown, output: unknown) => Promise<void>,
  toolHandlers: Map<string, (args: unknown) => Promise<unknown>>,
) {
  let turnIndex = 0;
  return async function* queryFn(prompt: AsyncIterable<SDKUserMessage>): AsyncGenerator<SDKMessage> {
    for await (const msg of prompt) {
      const content = typeof msg.message.content === "string"
        ? msg.message.content
        : JSON.stringify(msg.message.content);
      const handler = turns[turnIndex++];
      if (handler) {
        yield* handler(content, postToolUseHook, toolHandlers);
      }
    }
  };
}

describe("LiveSession per-turn trace propagation", () => {
  beforeEach(() => clearTestDb());

  it("tool calls and receipts land under each turn's own traceId (not the frozen ctor-trace)", async () => {
    // The turnTraceHolder is the shared state that will be threaded through impl.
    // Pre-fix: this holder is never written to, so trace falls back to ALS ctor-trace.
    // Post-fix: dispatchTurn writes it; hook + tool wrapper read it.
    const turnTraceHolder: { id: string | undefined } = { id: undefined };

    // Build adam-tools with the turn-trace getter
    const adamToolsInstance = createAdamTools({
      getTurnTraceId: () => turnTraceHolder.id,
    } as Parameters<typeof createAdamTools>[0]);

    // Extract tool handlers from the (mocked) SDK tool list
    const toolHandlers = new Map<string, (args: unknown) => Promise<unknown>>();
    for (const call of mockTool.mock.calls) {
      const [name, , , handler] = call as [string, string, unknown, (args: unknown) => Promise<unknown>];
      toolHandlers.set(name, handler);
    }

    // Build session hooks with the same turn-trace getter
    const cachedHooks = buildSessionHooks({
      getChatSessionId: () => "session-trace-test",
      getCurrentTurnTraceId: () => turnTraceHolder.id,
    } as Parameters<typeof buildSessionHooks>[0]);

    // The PostToolUse hook callback (calls chat_tool_calls + drives trace-B logging)
    const postToolUseHook = async (toolName: string, toolInput: unknown, toolOutput: unknown) => {
      const callbacks = cachedHooks.PostToolUse?.[0]?.hooks;
      if (!callbacks) return;
      await callbacks[0](
        { tool_name: toolName, tool_input: toolInput, tool_response: toolOutput } as Parameters<typeof callbacks[0]>[0],
        undefined,
        {} as Parameters<typeof callbacks[0]>[2],
      );
    };

    // Turn 1: emits a tool call + result under trace-A
    async function* turn1(
      _content: string,
      hookFn: typeof postToolUseHook,
      handlers: Map<string, (args: unknown) => Promise<unknown>>,
    ): AsyncGenerator<SDKMessage> {
      // Invoke a real adam-tool (list_roles is simple, doesn't need DB beyond roles table)
      const handler = handlers.get("list_roles");
      if (handler) {
        const result = await handler({});
        // Fire the PostToolUse hook so chat_tool_calls gets written
        await hookFn("list_roles", {}, result);
      }
      yield { type: "result", result: "turn1-done", num_turns: 1 } as SDKMessage;
    }

    // Turn 2: same pattern, different trace — use list_goals (exists in adam-tools)
    async function* turn2(
      _content: string,
      hookFn: typeof postToolUseHook,
      handlers: Map<string, (args: unknown) => Promise<unknown>>,
    ): AsyncGenerator<SDKMessage> {
      const listHandler = handlers.get("list_goals");
      if (listHandler) {
        const result = await listHandler({});
        await hookFn("list_goals", {}, result);
      }
      yield { type: "result", result: "turn2-done", num_turns: 1 } as SDKMessage;
    }

    const queryFn = makeMockQuery([turn1, turn2], postToolUseHook, toolHandlers);

    // Wrap ctor in withTrace("ctor-trace") to reproduce the production freeze.
    // Pre-fix: the reader loop's ALS context is "ctor-trace" for ALL turns.
    // turnTraceHolder is passed so LiveSession.dispatchTurn can write the per-turn traceId into it.
    let liveSession!: LiveSession;
    withTrace("ctor-trace", "chat", () => {
      liveSession = new LiveSession({
        query: queryFn as Parameters<typeof LiveSession.prototype.push>[0] extends string ? never : never,
        chatSessionId: "session-trace-test",
        adamToolsInstance,
        cachedHooks,
        turnTraceHolder,
      } as ConstructorParameters<typeof LiveSession>[0]);
    });

    // Push turn 1 with trace-A (NOT wrapped in withTrace — simulates prod push)
    await liveSession.push("message-1", "trace-A");

    // Push turn 2 with trace-B
    await liveSession.push("message-2", "trace-B");

    liveSession.end();

    // Assert: turn-1 rows under trace-A
    const toolCallsA = listChatToolCallsByTrace("trace-A");
    expect(toolCallsA.length).toBe(1);
    expect(toolCallsA[0].toolName).toBe("list_roles");

    // Assert: turn-2 rows under trace-B
    const toolCallsB = listChatToolCallsByTrace("trace-B");
    expect(toolCallsB.length).toBe(1);
    expect(toolCallsB[0].toolName).toBe("list_goals");

    // Nothing should land under the frozen ctor-trace
    const toolCallsCtor = listChatToolCallsByTrace("ctor-trace");
    expect(toolCallsCtor.length).toBe(0);
  });

  it("effect_receipts land under the turn trace (not ctor-trace) for mutation tools", async () => {
    const turnTraceHolder: { id: string | undefined } = { id: undefined };

    // Reset mock calls to get a fresh tool list
    mockTool.mockClear();

    const adamToolsInstance = createAdamTools({
      getTurnTraceId: () => turnTraceHolder.id,
    } as Parameters<typeof createAdamTools>[0]);

    const toolHandlers = new Map<string, (args: unknown) => Promise<unknown>>();
    for (const call of mockTool.mock.calls) {
      const [name, , , handler] = call as [string, string, unknown, (args: unknown) => Promise<unknown>];
      toolHandlers.set(name, handler);
    }

    const cachedHooks = buildSessionHooks({
      getChatSessionId: () => "session-receipt-test",
      getCurrentTurnTraceId: () => turnTraceHolder.id,
    } as Parameters<typeof buildSessionHooks>[0]);

    const postToolUseHook = async (toolName: string, toolInput: unknown, toolOutput: unknown) => {
      const callbacks = cachedHooks.PostToolUse?.[0]?.hooks;
      if (!callbacks) return;
      await callbacks[0](
        { tool_name: toolName, tool_input: toolInput, tool_response: toolOutput } as Parameters<typeof callbacks[0]>[0],
        undefined,
        {} as Parameters<typeof callbacks[0]>[2],
      );
    };

    // Turn that calls a mutation tool (create_delivery_rule writes a receipt)
    async function* turnWithMutation(
      _content: string,
      hookFn: typeof postToolUseHook,
      handlers: Map<string, (args: unknown) => Promise<unknown>>,
    ): AsyncGenerator<SDKMessage> {
      // create_delivery_rule writes a writeMutationReceipt
      const handler = handlers.get("create_delivery_rule");
      if (handler) {
        const result = await handler({
          eventType: "task_complete",
          matchCriteria: {},
          target: { type: "session", sessionId: "s-test" },
        });
        await hookFn("create_delivery_rule", {}, result);
      }
      yield { type: "result", result: "mutation-done", num_turns: 1 } as SDKMessage;
    }

    // Turn that calls NO mutation tool (no receipt should be written)
    async function* turnNoMutation(
      _content: string,
      hookFn: typeof postToolUseHook,
      handlers: Map<string, (args: unknown) => Promise<unknown>>,
    ): AsyncGenerator<SDKMessage> {
      const handler = handlers.get("list_tasks");
      if (handler) {
        const result = await handler({ limit: 1 });
        await hookFn("list_tasks", {}, result);
      }
      yield { type: "result", result: "readonly-done", num_turns: 1 } as SDKMessage;
    }

    const queryFn = makeMockQuery([turnWithMutation, turnNoMutation], postToolUseHook, toolHandlers);

    let liveSession!: LiveSession;
    withTrace("ctor-trace-receipts", "chat", () => {
      liveSession = new LiveSession({
        query: queryFn as Parameters<typeof LiveSession.prototype.push>[0] extends string ? never : never,
        chatSessionId: "session-receipt-test",
        adamToolsInstance,
        cachedHooks,
        turnTraceHolder,
      } as ConstructorParameters<typeof LiveSession>[0]);
    });

    await liveSession.push("do-mutation", "trace-mutation");
    await liveSession.push("do-readonly", "trace-readonly");

    liveSession.end();

    // Mutation turn: receipt under trace-mutation
    const receipts = listReceiptsByTrace("trace-mutation");
    expect(receipts.length).toBeGreaterThanOrEqual(1);

    // Readonly turn: no receipt
    const receiptsReadonly = listReceiptsByTrace("trace-readonly");
    expect(receiptsReadonly.length).toBe(0);

    // Nothing under frozen ctor-trace
    const receiptsCtor = listReceiptsByTrace("ctor-trace-receipts");
    expect(receiptsCtor.length).toBe(0);
  });
});
