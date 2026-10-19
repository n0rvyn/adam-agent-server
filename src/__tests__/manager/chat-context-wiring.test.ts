/**
 * ChatManager message → LiveSession wiring (活法二 rework).
 *
 * Pre-rework this file asserted ChatManager enriched the user message via
 * buildSessionContext() and passed the enriched STRING as `query({prompt})`.
 * The live-session rework removed that: ChatManager no longer calls
 * buildSessionContext at all. With persistSession:true + a per-session LiveSession,
 * the SDK keeps the transcript itself; ChatManager pushes the RAW user content into
 * the session's streaming `query({prompt: AsyncIterable<SDKUserMessage>})`.
 *
 * Removed cases (behavior genuinely gone from ChatManager — NOT re-covered elsewhere):
 *   - "calls buildSessionContext with the correct sessionId"
 *   - "passes enriched prompt to SDK query when sessionId is provided"
 *   - "falls back to raw message when buildSessionContext throws"
 * (buildSessionContext seed/delta modes are unit-tested in context-builder-seed-delta.test.ts,
 *  but that covers the BUILDER in isolation; ChatManager does not inject context in this rework
 *  state — see deliverable note. No test asserts the old ChatManager-side enrichment because it
 *  no longer exists.)
 *
 * Retained behavior (live analogue of the old "raw message, no sessionId" case):
 *   - handleMessage(content) → anonymous LiveSession → push(raw content) → the raw user
 *     content reaches the streaming query's prompt stream as an SDKUserMessage.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("../../store/db.js", () => ({
  getDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    anthropic: { apiKey: "test-key", baseUrl: "", model: "claude-sonnet-4-6" },
    defaults: { maxTurns: 10, maxBudgetUsd: 5 },
    pricing: { models: {} },
    chat: { maxConcurrentLiveSessions: 3, liveSessionIdleMinutes: 30, sessionTimeoutMinutes: 30 },
  })),
  buildSdkAuthEnv: vi.fn(() => ({})),
  buildSdkEnv: vi.fn(() => ({})),
  initRuntimeConfig: vi.fn(),
  loadPersistedConfig: vi.fn(),
}));

vi.mock("../../manager/chat-system-prompt.js", () => ({
  buildChatSystemPrompt: vi.fn(() => "mocked system prompt"),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { on: vi.fn(), emit: vi.fn() },
}));

vi.mock("../../store/server-state.js", () => ({
  getServerState: vi.fn(() => ({})),
}));

vi.mock("../../store/messages.js", () => ({
  createMessage: vi.fn(),
  getMessage: vi.fn(),
  findEnvelopeByPlatformMessageId: vi.fn(),
  updateMessagePromptBinding: vi.fn(),
  updateMessageCost: vi.fn(),
}));

vi.mock("../../store/sessions.js", () => ({
  updateSession: vi.fn(),
  getSession: vi.fn(() => null),
  updateSessionSdkId: vi.fn(),
}));

vi.mock("../../store/roles.js", () => ({
  getRole: vi.fn(() => ({
    id: "role-chat-manager",
    name: "ChatManager",
    cagPrompt: "",
    permissionMode: "default",
    deniedReadPaths: [],
    allowedBashPatterns: [],
    deniedBashPatterns: [],
    disallowedTools: [],
    additionalDirectories: [],
    plugins: [],
    model: null,
    effort: null,
    maxTurns: null,
  })),
}));

vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: vi.fn(() => "/tmp/chat-manager-workspace"),
  ensureRoleWorkspace: vi.fn(() => "/tmp/chat-manager-workspace"),
}));

vi.mock("../../manager/role-mcp-registry.js", () => ({
  getSdkMcpServersForRole: vi.fn(() => []),
  SYSTEM_MCP_PREFIXES: new Set(["mcp__execution-tools__"]),
}));

vi.mock("../../lib/role-capabilities.js", () => ({
  resolveRolePluginPaths: vi.fn(() => []),
}));

vi.mock("../../lib/logger.js", () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

vi.mock("../../lib/trace-context.js", () => ({
  getCurrentTraceId: vi.fn(() => undefined),
  withNewTrace: vi.fn(async (_name: string, fn: () => unknown) => fn()),
  withTrace: vi.fn(async (_id: string, _name: string, fn: () => unknown) => fn()),
}));

vi.mock("../../store/memories.js", () => ({
  listBeliefsByRole: vi.fn(() => []),
}));

vi.mock("../../store/beliefs.js", () => ({
  listBeliefsByRole: vi.fn(() => []),
}));

vi.mock("../../chat/session-manager.js", () => ({
  incrementMessageCount: vi.fn(),
  touchSession: vi.fn(),
  getSession: vi.fn(() => null),
  updateSessionSdkId: vi.fn(),
}));

vi.mock("../../chat/context-builder.js", () => ({
  buildSessionContext: vi.fn(async (_sessionId: string, msg: string) => msg),
}));

vi.mock("../../store/tasks.js", () => ({
  getTask: vi.fn(() => undefined),
  updateTask: vi.fn(),
  getTaskTraceId: vi.fn(() => undefined),
}));

vi.mock("../../store/config.js", () => ({
  getConfigValue: vi.fn(() => null),
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: vi.fn(() => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined), send: vi.fn() })),
}));

const { mockQueryFn } = vi.hoisted(() => ({ mockQueryFn: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQueryFn,
  startup: vi.fn(async () => ({ query: vi.fn(), close: vi.fn() })),
  createSdkMcpServer: vi.fn(() => ({ type: "sdk", name: "mock-mcp" })),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => ({ name: _name, handler })),
}));

import { ChatManager } from "../../manager/chat-manager.js";

// ─── Streaming query mock (copied shape from chat-manager-live-routing.test.ts) ──

function makeResultEvent(resultText: string, sdkSessionId = "sdk-context-wiring") {
  return {
    type: "result",
    result: resultText,
    num_turns: 1,
    total_cost_usd: 0.001,
    session_id: sdkSessionId,
    modelUsage: {},
    usage: { input_tokens: 5, output_tokens: 5 },
  };
}

/**
 * Streaming query: reads params.prompt (the AsyncIterable<SDKUserMessage> ChatManager pushes
 * into), captures every non-seed user message's text, and yields one result per turn.
 * Captured user-message contents are recorded in `capturedUserContents` for assertions.
 */
const capturedUserContents: string[] = [];
function makeCapturingQuery(resultText = "done") {
  return async function* (params?: { prompt?: AsyncIterable<{ shouldQuery?: boolean; message?: { content?: string } }> }) {
    const prompt = params?.prompt;
    if (!prompt) { yield makeResultEvent(resultText); return; }
    for await (const userMsg of prompt) {
      if (userMsg?.shouldQuery === false) continue; // seed/context injection — no turn
      capturedUserContents.push(userMsg?.message?.content ?? "");
      yield makeResultEvent(resultText);
    }
  };
}

describe("ChatManager message → LiveSession wiring", () => {
  let manager: ChatManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedUserContents.length = 0;
    mockQueryFn.mockImplementation((opts: unknown) =>
      makeCapturingQuery()(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean; message?: { content?: string } }> }),
    );
    manager = new ChatManager();
    await manager.start();
  });

  afterEach(() => {
    manager.stop();
    vi.clearAllMocks();
  });

  it("pushes the raw user content into the LiveSession's streaming query (no sessionId)", async () => {
    const reply = await manager.handleMessage("no session message");

    // The streaming query was created exactly once and received the raw content as an
    // SDKUserMessage on its prompt stream — ChatManager does NOT pre-enrich the prompt.
    expect(mockQueryFn).toHaveBeenCalled();
    expect(capturedUserContents).toContain("no session message");
    expect(reply).toBe("done");

    // buildSessionContext is no longer invoked by ChatManager (enrichment removed in 活法二).
    const { buildSessionContext } = await import("../../chat/context-builder.js");
    expect(buildSessionContext).not.toHaveBeenCalled();
  });

  it("enriches a named-session turn with delta context (buildSessionContext invoked)", async () => {
    const reply = await manager.handleMessage("session-bound message", "session-456", { type: "web" });

    expect(mockQueryFn).toHaveBeenCalled();
    // Delta-enriched per turn (Q3/Q4 wiring): the raw message is a SUBSTRING of the pushed
    // content, not an exact element. (The no-sessionId/anonymous path above stays raw.)
    expect(capturedUserContents.some((c) => c.includes("session-bound message"))).toBe(true);
    expect(reply).toBe("done");

    // ChatManager DOES invoke buildSessionContext for a named session (delta per turn,
    // + seed on a fresh session). Regression shield against the initially-unwired ship.
    const { buildSessionContext } = await import("../../chat/context-builder.js");
    expect(buildSessionContext).toHaveBeenCalled();
    const modes = (buildSessionContext as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[2] as { mode?: string } | undefined)?.mode,
    );
    expect(modes).toContain("delta");
  });
});
