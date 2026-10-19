/**
 * Unit tests for ChatManager — per-session getChatSessionId hook binding (活法二 rework).
 *
 * Pre-rework: ChatManager held ONE mutable `activeChatSessionId` field and ONE
 * `cachedHooks` whose getChatSessionId closure read that field live; the test mutated
 * the field between turns and asserted the same hook saw the new value.
 *
 * Post-rework: each chat session gets its OWN LiveSession with its OWN hooks, built via
 * `_buildPerSessionTools(chatSessionId, source)` whose getChatSessionId is a CONSTANT
 * (`() => chatSessionId`). The mechanism is inverted: instead of one hook reading a
 * mutable field, there are N hooks each frozen to its session. This rewrite verifies the
 * inverted contract — two per-session hook sets each record chat_tool_calls under THEIR
 * OWN session id, and the binding is constant (re-invoking the same hook never changes id).
 *
 * Relationship to chat-session-context-binding.test.ts: that file asserts ChatManager has no
 * single shared `adamToolsInstance` and that DISPATCH attribution is per-session. This file
 * asserts the PostToolUse → chat_tool_calls recording uses the per-session constant id.
 * Complementary, not overlapping — neither subsumes the other.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// ---- Mock SDK (ChatManager.start() calls startup() internally) ----
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  startup: vi.fn().mockResolvedValue({ query: vi.fn(), close: vi.fn() }),
  createSdkMcpServer: vi.fn(() => ({ type: "sdk", name: "mock-mcp" })),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => ({ name: _name, handler })),
}));

// ---- Mock store deps (prevent real DB, config, bus writes) ----
vi.mock("../../store/roles.js", () => ({
  getRole: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../manager/chat-system-prompt.js", () => ({
  buildChatSystemPrompt: vi.fn(() => "MOCKED_SYSTEM_PROMPT"),
}));
vi.mock("../../manager/adam-tools.js", () => ({
  createAdamTools: vi.fn(() => ({ getTools: vi.fn(() => []), callTool: vi.fn() })),
}));
vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));
vi.mock("../../store/server-state.js", () => ({
  getServerState: vi.fn().mockReturnValue({ sdkSessionId: undefined, userTaskSessionId: undefined }),
}));
vi.mock("../server/events/server-bus.js", () => ({
  serverBus: { on: vi.fn(), emit: vi.fn(), off: vi.fn() },
}));
vi.mock("../../store/goals.js", () => ({
  getGoal: vi.fn(), updateGoal: vi.fn(),
}));
vi.mock("../../store/tasks.js", () => ({
  getTask: vi.fn(), updateTask: vi.fn(), listTasksByParent: vi.fn(),
  getDueDelayedRetries: vi.fn(() => []), createDelayedRetry: vi.fn(),
  deleteDelayedRetry: vi.fn(), deleteDelayedRetryByTaskId: vi.fn(),
  getTaskTraceId: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../chat/session-manager.js", () => ({
  createSession: vi.fn(), getSession: vi.fn(), updateSessionActivity: vi.fn(),
}));
vi.mock("../../chat/context-builder.js", () => ({
  buildSessionContext: vi.fn().mockResolvedValue(""),
}));
vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: vi.fn(() => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined), deliver: vi.fn(), queue: vi.fn() })),
}));
vi.mock("../../config/runtime.js", () => ({
  buildSdkEnv: vi.fn(() => ({})),
  buildSdkAuthEnv: vi.fn(() => ({})),
  getRuntimeConfig: vi.fn(() => ({
    defaults: { maxBudgetUsd: 5 },
    anthropic: {},
    pricing: { models: {} },
    chat: { maxConcurrentLiveSessions: 3, liveSessionIdleMinutes: 30, sessionTimeoutMinutes: 30 },
  })),
}));
vi.mock("../../store/messages.js", () => ({ createMessage: vi.fn() }));
vi.mock("../../store/pending-prompts.js", () => ({
  listOpenPromptsByTask: vi.fn(() => []), expirePendingPrompt: vi.fn(),
}));

// ---- Spies ----
const mockRecordChatToolCall = vi.fn();
vi.mock("../../store/chat-tool-calls.js", () => ({
  recordChatToolCall: mockRecordChatToolCall,
}));
vi.mock("../../store/logs.js", () => ({
  createStepLog: vi.fn(),
}));
vi.mock("../../lib/trace-context.js", () => ({
  getCurrentTraceId: () => "spy-trace",
  withNewTrace: vi.fn((_origin: string, fn: () => void) => fn()),
  withTrace: vi.fn(),
  getTraceStore: vi.fn(),
}));

// ---- Imports (these use the mocks above) ----
const { ChatManager } = await import("../../manager/chat-manager.js");
const { buildSessionHooks } = await import("../../manager/hooks.js");

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  mockRecordChatToolCall.mockReset();
});

/** Build a per-session hook set the same way ChatManager does for each LiveSession. */
function perSessionHooks(manager: InstanceType<typeof ChatManager>, sessionId: string): ReturnType<typeof buildSessionHooks> {
  const built = (manager as unknown as {
    _buildPerSessionTools: (id: string | undefined, src: { type: string } | undefined) => { cachedHooks: ReturnType<typeof buildSessionHooks> };
  })._buildPerSessionTools(sessionId, { type: "web" });
  return built.cachedHooks;
}

describe("ChatManager per-session getChatSessionId hook binding", () => {
  it("each per-session hook set has a working PostToolUse hook", async () => {
    const manager = new ChatManager();
    await manager.start();

    const hooks = perSessionHooks(manager, "session-test-1");
    expect(hooks).toBeDefined();
    expect(hooks.PostToolUse).toBeDefined();
    expect(hooks.PostToolUse![0].hooks.length).toBeGreaterThan(0);

    manager.stop();
  });

  it("two per-session hooks each record chat_tool_calls under their OWN constant session id", async () => {
    const manager = new ChatManager();
    await manager.start();

    // Session 1's hook — bound to "session-test-1"
    const hooks1 = perSessionHooks(manager, "session-test-1");
    const postTool1 = hooks1.PostToolUse![0].hooks[0];
    await postTool1({ tool_name: "query_delivery_history", tool_input: {}, tool_response: {} } as any, undefined, {} as any);
    expect(mockRecordChatToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-test-1" }),
    );

    // Session 2's hook — a DIFFERENT LiveSession's hook, bound to "session-test-2"
    const hooks2 = perSessionHooks(manager, "session-test-2");
    const postTool2 = hooks2.PostToolUse![0].hooks[0];
    await postTool2({ tool_name: "query_execution_status", tool_input: {}, tool_response: {} } as any, undefined, {} as any);
    expect(mockRecordChatToolCall).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "session-test-2" }),
    );

    const calls = mockRecordChatToolCall.mock.calls;
    const id1 = calls[0][0] as { sessionId?: string };
    const id2 = calls[1][0] as { sessionId?: string };
    expect(id1.sessionId).not.toBe(id2.sessionId);

    manager.stop();
  });

  it("a single per-session hook's binding is CONSTANT across re-invocations (not mutable)", async () => {
    const manager = new ChatManager();
    await manager.start();

    const hooks = perSessionHooks(manager, "s-const");
    const postTool = hooks.PostToolUse![0].hooks[0];

    await postTool({ tool_name: "query_delivery_history", tool_input: { channelId: "ch-1" }, tool_response: {} } as any, undefined, {} as any);
    await postTool({ tool_name: "query_execution_status", tool_input: { executionId: "exec-1" }, tool_response: {} } as any, undefined, {} as any);

    expect(mockRecordChatToolCall).toHaveBeenCalledTimes(2);
    // Both invocations of the SAME session's hook record the SAME constant id.
    expect(mockRecordChatToolCall).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ sessionId: "s-const", toolName: "query_delivery_history" }),
    );
    expect(mockRecordChatToolCall).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ sessionId: "s-const", toolName: "query_execution_status" }),
    );

    manager.stop();
  });
});
