/**
 * Task 5-tests: ChatManager integration (map routing + persistSession + resume) — tests
 *
 * Expected initial state (before Task 5-impl):
 * FAILS because:
 * - ChatManager has no LiveSession map (still uses messageQueue/runQuery)
 * - buildSharedOptions sets persistSession: false
 * - updateSessionSdkId is never called
 * - No resume path from DB sdk_session_id
 * - Status/completion reports still push to messageQueue (not per-session LiveSession)
 *
 * After Task 5-impl, all assertions below pass.
 *
 * Contract verified:
 * 1. A message routes to a LiveSession for its session (creating one on first message).
 * 2. A second message to the same session reuses the same LiveSession (no new query() call).
 * 3. persistSession:true is set in buildSharedOptions / SDK options.
 * 4. sdkSessionId from the result is persisted via updateSessionSdkId.
 * 5. A message for a session with a known sdkSessionId but no live process creates a query with resume.
 * 6. No-origin case: a completion-report with origin === undefined does NOT call getOrCreateLiveSession.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChatSource } from "../../shared/types.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

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

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn(), on: vi.fn() },
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

vi.mock("../../lib/logger.js", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
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

const { mockBuildSessionContext } = vi.hoisted(() => ({
  mockBuildSessionContext: vi.fn(
    async (_sessionId: string, msg: string, opts?: { mode?: string }) =>
      opts?.mode ? `[ctx:${opts.mode}]` : msg,
  ),
}));
vi.mock("../../chat/context-builder.js", () => ({
  buildSessionContext: mockBuildSessionContext,
}));

vi.mock("../../lib/role-capabilities.js", () => ({
  resolveRolePluginPaths: vi.fn(() => []),
}));

vi.mock("../../manager/role-mcp-registry.js", () => ({
  getSdkMcpServersForRole: vi.fn(() => []),
  SYSTEM_MCP_PREFIXES: new Set(["mcp__execution-tools__"]),
}));

vi.mock("../../store/tasks.js", () => ({
  getTask: vi.fn(() => undefined),
  updateTask: vi.fn(),
  getTaskTraceId: vi.fn(() => undefined),
}));

vi.mock("../../store/config.js", () => ({
  getConfigValue: vi.fn(() => null),
}));

// Controllable mock for SDK query
const { mockQueryFn } = vi.hoisted(() => ({
  mockQueryFn: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQueryFn,
  startup: vi.fn(async () => ({ query: vi.fn(), close: vi.fn() })),
  createSdkMcpServer: vi.fn(() => ({ type: "sdk", name: "mock-mcp" })),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => ({ name: _name, handler })),
}));

// Import ChatManager after mocks
import { ChatManager } from "../../manager/chat-manager.js";

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeResultEvent(resultText: string, sdkSessionId: string) {
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
 * Models a persistent streaming-input query: reads the prompt AsyncIterable and yields
 * ONE result event per non-seed (shouldQuery !== false) user message, staying open until
 * the input stream closes (LiveSession.end()). This mirrors the real SDK — one query() call
 * serves the whole session lifetime (multiple turns), so a reused LiveSession does NOT
 * trigger a second query() call.
 *
 * `params` is the `{prompt, options}` object the SDK `query()` receives. If absent (legacy
 * single-shot caller), falls back to a single result so older call patterns still resolve.
 */
function makeResultQuery(resultText: string, sdkSessionId: string) {
  return async function* (params?: { prompt?: AsyncIterable<{ shouldQuery?: boolean }> }) {
    const prompt = params?.prompt;
    if (!prompt) {
      yield makeResultEvent(resultText, sdkSessionId);
      return;
    }
    for await (const userMsg of prompt) {
      if (userMsg?.shouldQuery === false) continue; // seed/context injection — no turn
      yield makeResultEvent(resultText, sdkSessionId);
    }
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Task 5-tests: ChatManager map routing + persistSession + resume", () => {
  let manager: ChatManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager = new ChatManager();
    await manager.start();
  });

  afterEach(() => {
    manager.stop();
    vi.clearAllMocks();
  });

  /**
   * TC1: A message routes to a LiveSession for its session (created on first message).
   * A second message to the SAME session reuses the SAME LiveSession — query() called once total.
   *
   * Pre-impl: messages go through messageQueue/runQuery, so query() is called once per message.
   * Post-impl: LiveSession is created on first message, reused on second → query() called ONCE total.
   *
   * This test FAILS before Task 5-impl (query is called twice, not once).
   */
  it("TC1: two messages to the same session reuse one LiveSession (query called once)", async () => {
    const sessionId = "session-tc1-001";
    const source: ChatSource = { type: "web" };

    let queryCallCount = 0;
    const capturedQueryOptions: Record<string, unknown>[] = [];

    mockQueryFn.mockImplementation((opts: unknown) => {
      queryCallCount += 1;
      capturedQueryOptions.push(opts as Record<string, unknown>);
      return makeResultQuery("reply", "sdk-sess-tc1")(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> });
    });

    // First message — should create a LiveSession
    await manager.handleMessage("first message", sessionId, source);
    // Second message — should reuse the same LiveSession (NOT create a new query call)
    await manager.handleMessage("second message", sessionId, source);

    // With the current messageQueue/runQuery model, query() is called once per message = 2 calls.
    // After LiveSession map: query() is called once for the session's lifetime.
    expect(queryCallCount).toBe(1); // FAILS pre-impl (will be 2)
  });

  /**
   * TC2: persistSession:true must be set in the SDK options.
   *
   * Pre-impl: buildSharedOptions sets persistSession: false.
   * Post-impl: persistSession: true.
   *
   * This test FAILS before Task 5-impl.
   */
  it("TC2: persistSession:true is passed to SDK query options", async () => {
    const sessionId = "session-tc2-001";
    const source: ChatSource = { type: "web" };

    let capturedOptions: Record<string, unknown> | undefined;
    mockQueryFn.mockImplementation((opts: unknown) => {
      capturedOptions = opts as Record<string, unknown>;
      return makeResultQuery("reply", "sdk-sess-tc2")(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> });
    });

    await manager.handleMessage("hello", sessionId, source);

    // options.options.persistSession should be true
    const sdkOptions = (capturedOptions as { options?: { persistSession?: boolean } })?.options;
    expect(sdkOptions?.persistSession).toBe(true); // FAILS pre-impl (false)
  });

  /**
   * TC3: updateSessionSdkId is called with the SDK session id from the result.
   *
   * Pre-impl: sdkSessionId is captured in ChatManagerResponse but not persisted via updateSessionSdkId.
   * Post-impl: updateSessionSdkId(sessionId, sdkSessionId) is called after each turn.
   *
   * This test FAILS before Task 5-impl.
   */
  it("TC3: updateSessionSdkId is called with the SDK session id after a turn", async () => {
    const { updateSessionSdkId } = await import("../../chat/session-manager.js");
    vi.clearAllMocks();

    const sessionId = "session-tc3-001";
    const source: ChatSource = { type: "web" };
    const expectedSdkSessionId = "sdk-session-id-xyz";

    mockQueryFn.mockImplementation((opts: unknown) => {
      return makeResultQuery("reply", expectedSdkSessionId)(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> });
    });

    await manager.handleMessage("hello", sessionId, source);

    // After Task 5-impl: updateSessionSdkId should be called with (sessionId, expectedSdkSessionId)
    expect(vi.isMockFunction(updateSessionSdkId)).toBe(true);
    const calls = (updateSessionSdkId as ReturnType<typeof vi.fn>).mock.calls;
    const matchingCall = calls.find(
      (c) => c[0] === sessionId && c[1] === expectedSdkSessionId,
    );
    expect(matchingCall).toBeDefined(); // FAILS pre-impl (never called)
  });

  /**
   * TC4: No-resume continuity — a session with a known sdkSessionId in the DB but no live
   * process must NOT pass `resume:<id>` to the query. Streaming-mode SDK sessions are not
   * persisted as resumable transcripts on disk, so `--resume` fails with "No conversation
   * found" → empty first turn (处理超时) that loops, and rapid follow-ups crash the process
   * with EPIPE. Cross-restart continuity is instead carried by replaying this session's
   * history into the first turn's prompt (the seed).
   */
  it("TC4: no-resume — known sdkSessionId does NOT set resume; continuity via seed replay", async () => {
    const { getSession } = await import("../../chat/session-manager.js");
    const existingSdkSessionId = "sdk-resume-id-abc";
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "session-tc4-001",
      source: { type: "web" },
      sdk_session_id: existingSdkSessionId,
      sdkSessionId: existingSdkSessionId,
    });
    mockBuildSessionContext.mockClear();

    const sessionId = "session-tc4-001";
    const source: ChatSource = { type: "web" };

    let capturedOptions: Record<string, unknown> | undefined;
    const pushedContents: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockQueryFn.mockImplementation((opts: any) => {
      capturedOptions = opts as Record<string, unknown>;
      return (async function* () {
        for await (const m of opts.prompt as AsyncIterable<{ message?: { content?: string } }>) {
          pushedContents.push(m.message?.content ?? "");
          yield makeResultEvent("resumed reply", "sdk-sess-tc4");
        }
      })();
    });

    await manager.handleMessage("first turn after restart", sessionId, source);

    // resume must NOT be set — it is broken in streaming mode.
    const sdkOptions = (capturedOptions as { options?: { resume?: string } })?.options;
    expect(sdkOptions?.resume).toBeUndefined();
    // Continuity instead via seed replay: the seed (mode:"seed") was built and folded into
    // the first turn's prompt.
    const modes = mockBuildSessionContext.mock.calls.map((c: unknown[]) => (c[2] as { mode?: string } | undefined)?.mode);
    expect(modes).toContain("seed");
    expect(pushedContents[0]).toContain("[ctx:seed]");
  });

  /**
   * TC5: No-origin case — handleTaskCompletion with origin === undefined must NOT call
   * getOrCreateLiveSession(undefined). The completion-report falls through to the 30s-fallback path.
   *
   * This is a negative test: asserts that no LiveSession is created when origin is absent.
   *
   * Pre-impl: completion report pushes to messageQueue regardless of origin — which is fine for
   * the serial case. Post-impl: must guard against getOrCreateLiveSession(undefined).
   *
   * We test the negative invariant: after a task_complete_event with no origin, query() is
   * NOT called (no new LiveSession created for the no-origin task).
   */
  it("TC5: no-origin task_complete_event does not create a LiveSession", async () => {
    const { serverBus } = await import("../../server/events/server-bus.js");
    vi.clearAllMocks();

    let queryCallCount = 0;
    mockQueryFn.mockImplementation((opts: unknown) => {
      queryCallCount += 1;
      return makeResultQuery("reply", "sdk-sess-tc5")(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> });
    });

    // Find the task_complete_event handler registered on serverBus.on
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onCalls = (serverBus.on as any).mock?.calls ?? [];
    const completionHandler = onCalls.find(
      (c: [string, unknown]) => c[0] === "task_complete_event",
    )?.[1] as ((event: { taskId: string; result?: string; error?: string }) => void) | undefined;

    if (completionHandler) {
      // Fire a task_complete_event with no matching session (origin=undefined scenario)
      completionHandler({ taskId: "task-no-origin-001", result: "done" });
      // Allow async handlers to settle
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    // No LiveSession should have been created (query() not called) for a no-origin task
    // The 30s-timeout fallback envelope path handles delivery instead.
    // Pre-impl: messageQueue may get a push but query() is still called eventually.
    // We only assert that query() was NOT called synchronously for a no-origin completion.
    // (The full 30s behavior is covered by integration tests.)
    expect(queryCallCount).toBe(0); // FAILS pre-impl if messageQueue processes no-origin turn
  });

  /**
   * TC6: Context wiring — a fresh session FOLDS the SEED into the first user turn's prompt
   * (NOT a separate shouldQuery:false push), and each user turn injects DELTA context.
   * Regression shield for #265: the streaming SDK answers every input message as a real turn,
   * so the mock here emits one result PER input message. Pre-fix the seed was a separate
   * input message → an extra (phantom) result → turn↔reply desync; the fix guarantees exactly
   * one input message per user turn. Also preserves the Task 5/6 wiring (cross-session
   * memory/"impression" Q4 + per-turn dynamic context Q3) the rework must keep.
   */
  it("TC6: fresh session folds seed into the first turn's prompt + per-turn delta context", async () => {
    const sessionId = "session-tc6-ctx";
    const source: ChatSource = { type: "web" };
    const pushedContents: string[] = [];

    // Ensure a FRESH session (no resume) — clearAllMocks does NOT reset mockReturnValue,
    // so TC4's getSession→{sdk_session_id} would leak here and suppress the seed.
    const { getSession } = await import("../../chat/session-manager.js");
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(null);
    mockBuildSessionContext.mockClear();

    // Faithful SDK contract: ONE result event per input user-message (no shouldQuery skip).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockQueryFn.mockImplementation((opts: any) => {
      return (async function* () {
        for await (const m of opts.prompt as AsyncIterable<{ message?: { content?: string } }>) {
          pushedContents.push(m.message?.content ?? "");
          yield makeResultEvent("reply", "sdk-tc6");
        }
      })();
    });

    const reply = await manager.handleMessage("hello there", sessionId, source);

    const modes = mockBuildSessionContext.mock.calls.map((c: unknown[]) => (c[2] as { mode?: string } | undefined)?.mode);
    expect(modes).toContain("seed");   // seed still built on session create
    expect(modes).toContain("delta");  // delta injected on the user turn
    // #265: exactly ONE input message reached the SDK for ONE user turn — no separate seed
    // message that would emit a phantom result and desync turn↔reply.
    expect(pushedContents).toHaveLength(1);
    // The seed is FOLDED into that first turn's prompt (not pushed separately).
    expect(pushedContents[0]).toContain("[ctx:seed]");
    expect(pushedContents[0]).toContain("hello there");
    // The turn resolved with the model's real answer (not an empty/phantom result).
    expect(reply).toBe("reply");
  });
});
