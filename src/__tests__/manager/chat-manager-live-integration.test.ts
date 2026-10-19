/**
 * Task 9: ChatManager live-session mocked-SDK integration test.
 *
 * Covers 5 end-to-end scenarios through ChatManager with a mocked SDK,
 * verifying the full wiring from handleMessage through LiveSession to results:
 *
 * 1. Multi-turn reuse — successive messages in the same session reuse one LiveSession
 *    (query() called once, each turn resolves independently).
 * 2. Resume on restart — a new ChatManager instance with a pre-seeded sdk_session_id
 *    creates a LiveSession with `resume` in the query options.
 * 3. Concurrent sessions no cross-talk — two sessions running in parallel each receive
 *    their own reply; no context bleed between sessions.
 * 4. Idle eviction — a session idle beyond liveSessionIdleMinutes is closed by the timer
 *    (fake timers advance); the next message recreates the session.
 * 5. Watchdog restart targets only stuck session — a session with a stale in-flight turn
 *    is closed by restartSession(); a healthy completed session survives.
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

vi.mock("../../chat/context-builder.js", () => ({
  buildSessionContext: vi.fn(async (_sessionId: string, msg: string) => msg),
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

import { ChatManager } from "../../manager/chat-manager.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeResultEvent(text: string, sessionId = "sdk-int-test") {
  return {
    type: "result",
    result: text,
    num_turns: 1,
    total_cost_usd: 0.001,
    session_id: sessionId,
    modelUsage: {},
    usage: { input_tokens: 5, output_tokens: 5 },
  };
}

/** A persistent streaming-input query that yields one result per non-seed message. */
function makeStreamingQuery(replyFn: (turnNum: number) => string, sessionId = "sdk-int-test") {
  let turnNum = 0;
  return async function* (params?: { prompt?: AsyncIterable<{ shouldQuery?: boolean }> }) {
    const prompt = params?.prompt;
    if (!prompt) {
      yield makeResultEvent(replyFn(0), sessionId);
      return;
    }
    for await (const userMsg of prompt) {
      if (userMsg?.shouldQuery === false) continue;
      turnNum++;
      yield makeResultEvent(replyFn(turnNum), sessionId);
    }
  };
}

/** A hanging query — never yields a result (simulates stuck in-flight turn). */
function makeHangingQuery() {
  return async function* (_params?: unknown) {
    await new Promise<void>(() => {}); // never resolves
    yield makeResultEvent("never");
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Task 9: ChatManager live-session integration", () => {
  let manager: ChatManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQueryFn.mockImplementation((opts: unknown) =>
      makeStreamingQuery((n) => `reply-${n}`)(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> })
    );
    manager = new ChatManager();
    await manager.start();
  });

  afterEach(() => {
    manager.stop();
    vi.clearAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 1: Multi-turn reuse
  // ──────────────────────────────────────────────────────────────────────────

  it("Scenario 1: multi-turn reuse — successive messages in the same session reuse one LiveSession", async () => {
    const sessionId = "int-session-multiturn";
    const source: ChatSource = { type: "web" };

    let queryCallCount = 0;
    const replies: string[] = [];
    mockQueryFn.mockImplementation((opts: unknown) => {
      queryCallCount++;
      return makeStreamingQuery((n) => `turn-${n}`, "sdk-mt")(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> });
    });

    const reply1 = await manager.handleMessage("first message", sessionId, source);
    const reply2 = await manager.handleMessage("second message", sessionId, source);
    const reply3 = await manager.handleMessage("third message", sessionId, source);
    replies.push(reply1, reply2, reply3);

    // All three turns served by a single query() invocation (persistent live session).
    expect(queryCallCount).toBe(1);

    // Each turn produced a distinct reply.
    expect(replies[0]).toBe("turn-1");
    expect(replies[1]).toBe("turn-2");
    expect(replies[2]).toBe("turn-3");

    // LiveSession map still holds one entry for this session.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lsMap = (manager as any).liveSessionMap as Map<string, unknown>;
    expect(lsMap.has(sessionId)).toBe(true);
    expect(lsMap.size).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 2: No-resume on restart (continuity via seed replay, not CLI --resume)
  // ──────────────────────────────────────────────────────────────────────────

  it("Scenario 2: no-resume on restart — pre-seeded sdk_session_id is NOT passed as resume", async () => {
    const sessionId = "int-session-resume";
    const source: ChatSource = { type: "web" };
    const storedSdkId = "sdk-session-id-from-prev-boot";

    // Seed the session mock to return a stored sdk_session_id (simulates post-restart state).
    const { getSession } = await import("../../chat/session-manager.js");
    vi.mocked(getSession).mockReturnValue({
      id: sessionId,
      source,
      sdkSessionId: storedSdkId,
      messageCount: 5,
      createdAt: Date.now() - 3600_000,
      updatedAt: Date.now() - 60_000,
      lastActiveAt: Date.now() - 60_000,
      status: "active",
    } as ReturnType<typeof getSession>);

    let capturedQueryOpts: Record<string, unknown> | undefined;
    mockQueryFn.mockImplementation((opts: unknown) => {
      capturedQueryOpts = opts as Record<string, unknown>;
      return makeStreamingQuery((n) => `resumed-reply-${n}`, storedSdkId)(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> });
    });

    // Stop + recreate manager to simulate a server restart (no live session in map).
    manager.stop();
    manager = new ChatManager();
    await manager.start();

    const reply = await manager.handleMessage("hello after restart", sessionId, source);
    expect(reply).toBe("resumed-reply-1");

    // resume must NOT be set — streaming-mode SDK sessions are not resumable from disk
    // ("No conversation found" → empty first turn that loops + EPIPE on rapid follow-ups).
    // Cross-restart continuity is carried by replaying the session's history into the first
    // turn's prompt (the seed), not by CLI --resume.
    const options = (capturedQueryOpts as { options?: { resume?: string } })?.options;
    expect(options?.resume).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 3: Concurrent sessions — no cross-talk
  // ──────────────────────────────────────────────────────────────────────────

  it("Scenario 3: concurrent sessions — two sessions respond with their own replies, no cross-talk", async () => {
    const sourceA: ChatSource = { type: "web" };
    const sourceB: ChatSource = { type: "tui" };

    let queryIndex = 0;
    mockQueryFn.mockImplementation((opts: unknown) => {
      queryIndex++;
      const sessionLabel = queryIndex === 1 ? "session-A" : "session-B";
      return makeStreamingQuery((n) => `${sessionLabel}-reply-${n}`, `sdk-${sessionLabel}`)(
        opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> }
      );
    });

    // Fire two sessions concurrently.
    const [replyA1, replyB1] = await Promise.all([
      manager.handleMessage("msg from A", "int-concurrent-A", sourceA),
      manager.handleMessage("msg from B", "int-concurrent-B", sourceB),
    ]);

    // Each session gets its own reply — no bleed.
    expect(replyA1).toContain("session-A");
    expect(replyB1).toContain("session-B");
    expect(replyA1).not.toBe(replyB1);

    // Second turn in A must not see B's session.
    const replyA2 = await manager.handleMessage("follow-up from A", "int-concurrent-A", sourceA);
    expect(replyA2).toContain("session-A");

    // Two distinct LiveSessions exist.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lsMap = (manager as any).liveSessionMap as Map<string, unknown>;
    expect(lsMap.has("int-concurrent-A")).toBe(true);
    expect(lsMap.has("int-concurrent-B")).toBe(true);
    expect(lsMap.size).toBe(2);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 4: Idle eviction
  // ──────────────────────────────────────────────────────────────────────────

  it("Scenario 4: idle eviction — session is closed after liveSessionIdleMinutes elapses", async () => {
    vi.useFakeTimers();
    const sessionId = "int-session-idle";
    const source: ChatSource = { type: "web" };

    let queryCallCount = 0;
    mockQueryFn.mockImplementation((opts: unknown) => {
      queryCallCount++;
      return makeStreamingQuery((n) => `idle-reply-${n}`, "sdk-idle")(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> });
    });

    try {
      // Complete a turn — session is now idle.
      await manager.handleMessage("first turn", sessionId, source);
      expect(queryCallCount).toBe(1);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let lsMap = (manager as any).liveSessionMap as Map<string, unknown>;
      expect(lsMap.has(sessionId)).toBe(true);

      // Advance fake timers past the idle window (30 min = 1,800,000 ms).
      vi.advanceTimersByTime(31 * 60 * 1000);

      // Session should now be evicted.
      lsMap = (manager as any).liveSessionMap as Map<string, unknown>;
      expect(lsMap.has(sessionId)).toBe(false);

      // Sending another message should recreate the session (new query() call).
      await manager.handleMessage("after idle eviction", sessionId, source);
      expect(queryCallCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 5: Watchdog restart targets only stuck session
  // ──────────────────────────────────────────────────────────────────────────

  it("Scenario 5: watchdog restart closes only stuck (stale in-flight) sessions, healthy sessions survive", async () => {
    const source: ChatSource = { type: "web" };

    let callNum = 0;
    mockQueryFn.mockImplementation((opts: unknown) => {
      callNum++;
      if (callNum === 1) {
        // First session: hang forever (stuck in-flight).
        return makeHangingQuery()(opts);
      }
      // Second session: normal.
      return makeStreamingQuery((n) => `healthy-reply-${n}`, "sdk-healthy")(
        opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> }
      );
    });

    // Session A: stuck (hanging query, turn in-flight).
    const turnAPromise = manager.handleMessage("stuck task", "int-wdog-stuck", source);
    turnAPromise.catch(() => {}); // suppress unhandled rejection

    // Wait for the hanging session to start.
    await Promise.resolve();
    await Promise.resolve();

    // Session B: healthy (completes normally).
    await manager.handleMessage("healthy task", "int-wdog-healthy", source);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cm = manager as any;
    const lsMapBefore = cm.liveSessionMap as Map<string, { end: () => void; isInFlight: boolean }>;
    expect(lsMapBefore.has("int-wdog-stuck")).toBe(true);
    expect(lsMapBefore.has("int-wdog-healthy")).toBe(true);

    // Spy on the healthy session's end() — it must NOT be called.
    const healthySession = lsMapBefore.get("int-wdog-healthy");
    const healthyEndSpy = healthySession ? vi.spyOn(healthySession, "end") : undefined;

    // Force the stuck session to appear stale by back-dating its turnStartedAt.
    const stuckSession = lsMapBefore.get("int-wdog-stuck");
    if (stuckSession) {
      // Access private field to simulate 31 minutes elapsed since turn start.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (stuckSession as any).turnStartedAt = Date.now() - 31 * 60 * 1000;
    }

    // Trigger watchdog restart — should only close the stuck session.
    await manager.restartSession();

    // Healthy session must survive (end() not called).
    expect(healthyEndSpy?.mock.calls.length ?? 1).toBe(0);

    // Stuck session should be evicted from the map.
    const lsMapAfter = cm.liveSessionMap as Map<string, unknown>;
    expect(lsMapAfter.has("int-wdog-stuck")).toBe(false);
    expect(lsMapAfter.has("int-wdog-healthy")).toBe(true);

    // Cleanup any remaining hanging turn.
    lsMapAfter.get("int-wdog-healthy") && (lsMapAfter.get("int-wdog-healthy") as { end(): void })?.end();
  });
});
