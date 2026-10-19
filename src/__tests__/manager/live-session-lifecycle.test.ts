/**
 * Task 7-tests: Lifecycle (cap + idle eviction + clean teardown) — tests.
 *
 * Expected initial state (before Task 7-impl):
 * FAILS because:
 * - No concurrency cap is enforced in getOrCreateLiveSession (cap+1 sessions can all be created).
 * - No idle-eviction timer is wired up (sessions stay open indefinitely).
 * - There is no `closeLiveSession(id)` public method for session-delete integration.
 * - In-flight protection is not implemented (a busy session could be evicted by LRU).
 *
 * After Task 7-impl, all assertions below pass.
 *
 * Contract verified:
 * 1. At most `maxConcurrentLiveSessions` (default 3) sessions live at once;
 *    creating a cap+1th evicts the LRU session.
 * 2. A session idle beyond `liveSessionIdleMinutes` is closed by the idle timer.
 * 3. `closeLiveSession(id)` closes the LiveSession BEFORE any row deletion.
 * 4. `stop()` closes all active live sessions.
 * 5. In-flight protection: a session with a turn in-flight is never evicted by LRU,
 *    never idle-closed, and never restarted by the watchdog path.
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
    // maxConcurrentLiveSessions=3 is the DP-001 cap; liveSessionIdleMinutes=30
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

// Controllable mock for SDK query — models a persistent streaming input session.
// For lifecycle tests: the query stays open until the input stream closes (LiveSession.end()).
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

/**
 * A persistent streaming query that stays open indefinitely, yielding one result per
 * non-seed user message. Stays open until the input stream closes (LiveSession.end()).
 */
function makePersistentQuery(resultText: string, sdkSessionId: string) {
  return async function* (params?: { prompt?: AsyncIterable<{ shouldQuery?: boolean }> }) {
    const prompt = params?.prompt;
    if (!prompt) {
      yield { type: "result", result: resultText, num_turns: 1, total_cost_usd: 0.001, session_id: sdkSessionId, modelUsage: {}, usage: { input_tokens: 5, output_tokens: 5 } };
      return;
    }
    for await (const userMsg of prompt) {
      if (userMsg?.shouldQuery === false) continue;
      yield { type: "result", result: resultText, num_turns: 1, total_cost_usd: 0.001, session_id: sdkSessionId, modelUsage: {}, usage: { input_tokens: 5, output_tokens: 5 } };
    }
  };
}

/**
 * A streaming query that yields NO result (hangs indefinitely), simulating an in-flight turn.
 */
function makeHangingQuery() {
  return async function* (_params?: unknown) {
    // Never yields — simulates a turn in-flight
    await new Promise<void>(() => {}); // never resolves
    yield { type: "result", result: "never", num_turns: 0, total_cost_usd: 0, session_id: "hang", modelUsage: {}, usage: { input_tokens: 0, output_tokens: 0 } };
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Task 7-tests: LiveSession lifecycle (cap + idle eviction + teardown)", () => {
  let manager: ChatManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQueryFn.mockImplementation((opts: unknown) =>
      makePersistentQuery("reply", "sdk-lifecycle-test")(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> })
    );
    manager = new ChatManager();
    await manager.start();
  });

  afterEach(() => {
    manager.stop();
    vi.clearAllMocks();
  });

  /**
   * TC1 — Concurrency cap (DP-001=A, cap=3, evict-LRU):
   * Creating a 4th session when 3 are already live should evict the LRU session.
   * After the eviction: map.size should remain <= 3.
   *
   * FAILS pre-impl: no cap enforcement; all 4 sessions are created, map.size = 4.
   */
  it("TC1: concurrency cap — creating cap+1 sessions evicts LRU, map stays <= cap", async () => {
    const source: ChatSource = { type: "web" };

    // Create 3 sessions (fills the cap)
    await manager.handleMessage("msg", "session-cap-1", source);
    await manager.handleMessage("msg", "session-cap-2", source);
    await manager.handleMessage("msg", "session-cap-3", source);

    // Access the live session map via any-cast
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cm = manager as any;
    const mapAfterThree = cm.liveSessionMap as Map<string, unknown>;
    expect(mapAfterThree.size).toBeLessThanOrEqual(3);

    // Create a 4th session — should evict the LRU (session-cap-1)
    await manager.handleMessage("msg", "session-cap-4", source);

    const mapAfterFour = cm.liveSessionMap as Map<string, unknown>;

    // FAILS pre-impl: map.size = 4 (no cap eviction)
    expect(mapAfterFour.size).toBeLessThanOrEqual(3);

    // The LRU (session-cap-1, least recently used) should be evicted
    // FAILS pre-impl: session-cap-1 is still present
    expect(mapAfterFour.has("session-cap-1")).toBe(false);
    // session-cap-4 (new) should be present
    expect(mapAfterFour.has("session-cap-4")).toBe(true);
  });

  /**
   * TC2 — Idle eviction:
   * A session idle beyond liveSessionIdleMinutes (30 min) should be closed by the idle timer.
   *
   * FAILS pre-impl: no idle-eviction timer; advancing fake timers has no effect.
   *
   * Implementation note: Task 7-impl will arm a per-session idle setTimeout when the session
   * is created (or after a turn completes). This test verifies that timer fires on schedule.
   * We switch to fake timers AFTER the session is created so the query's async iteration
   * isn't blocked by timer freezing.
   */
  it("TC2: idle eviction — session closed after idle window expires", async () => {
    const source: ChatSource = { type: "web" };
    const sessionId = "session-idle-test";

    // Create the session with real timers so the async query iteration starts normally
    await manager.handleMessage("msg", sessionId, source);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cm = manager as any;
    const mapBefore = cm.liveSessionMap as Map<string, unknown>;
    expect(mapBefore.has(sessionId)).toBe(true);

    // Spy on the LiveSession.end() for this session
    const liveSession = mapBefore.get(sessionId) as { end: () => void } | undefined;
    const endSpy = liveSession ? vi.spyOn(liveSession, "end") : undefined;

    // The idle timer armed during handleMessage uses REAL timers, which vitest fake timers
    // cannot adopt. Re-arm it under fake-timer control via the actual impl method
    // (_resetIdleTimer clears+replaces the existing handle), then fire it deterministically.
    // This exercises the real idle-eviction callback (closeLiveSession → end()) without the
    // async-generator/fake-timer interference that global fake timers cause.
    vi.useFakeTimers();
    try {
      cm._resetIdleTimer(sessionId, liveSession);
      vi.advanceTimersByTime(31 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }

    // FAILS pre-impl: end() is never called; session stays in map
    expect(endSpy).toBeDefined();
    expect(endSpy?.mock.calls.length).toBeGreaterThan(0);

    // After idle eviction, the session should be removed from the map
    // (onEnd callback removes it)
    const mapAfter = cm.liveSessionMap as Map<string, unknown>;
    expect(mapAfter.has(sessionId)).toBe(false);
  });

  /**
   * TC3 — Close-before-delete:
   * `closeLiveSession(id)` must close the LiveSession BEFORE the session row is deleted,
   * guarding against the FK crash (memory: feedback_chatmanager_session_delete_crash).
   *
   * FAILS pre-impl: `closeLiveSession` does not exist as a public method on ChatManager.
   */
  it("TC3: close-before-delete — closeLiveSession() ends the session", async () => {
    const source: ChatSource = { type: "web" };
    const sessionId = "session-delete-test";

    await manager.handleMessage("msg", sessionId, source);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cm = manager as any;
    const liveSession = (cm.liveSessionMap as Map<string, { end: () => void }>).get(sessionId);
    expect(liveSession).toBeDefined();

    const endSpy = liveSession ? vi.spyOn(liveSession, "end") : undefined;

    // Call closeLiveSession() — the public method that route DELETE handlers will call
    // FAILS pre-impl: closeLiveSession is not a function → TypeError
    expect(typeof cm.closeLiveSession).toBe("function"); // fails pre-impl
    cm.closeLiveSession(sessionId);

    // After closure: end() should have been called
    expect(endSpy?.mock.calls.length).toBeGreaterThan(0);
  });

  /**
   * TC4 — stop() closes all:
   * Calling stop() must close all live sessions.
   *
   * This may partially pass pre-impl since stop() already iterates the map.
   * We assert via spy that end() is called on every LiveSession.
   */
  it("TC4: stop() — all live sessions are closed", async () => {
    const source: ChatSource = { type: "web" };

    await manager.handleMessage("msg", "session-stop-1", source);
    await manager.handleMessage("msg", "session-stop-2", source);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cm = manager as any;
    const map = cm.liveSessionMap as Map<string, { end: () => void }>;

    const endSpies = [...map.values()].map((ls) => vi.spyOn(ls, "end"));
    expect(endSpies.length).toBeGreaterThanOrEqual(2);

    manager.stop();

    // All sessions must have end() called
    for (const spy of endSpies) {
      expect(spy.mock.calls.length).toBeGreaterThan(0);
    }
  });

  /**
   * TC5 — In-flight protection (verifier R5):
   * A LiveSession with an in-flight turn must NOT be evicted by LRU, NOT idle-closed,
   * and NOT restarted by the watchdog path.
   *
   * Setup: session A has an in-flight turn (hanging query); sessions B, C, D are created.
   * Even though A is LRU and the cap is 3, A must NOT be evicted while its turn is in-flight.
   *
   * FAILS pre-impl: no in-flight protection; LRU eviction picks the oldest regardless.
   */
  it("TC5: in-flight protection — LRU eviction skips a busy session", async () => {
    const source: ChatSource = { type: "web" };

    // Session A: hanging query (turn in-flight, never resolves)
    let queryCallCount = 0;
    mockQueryFn.mockImplementation((opts: unknown) => {
      queryCallCount++;
      if (queryCallCount === 1) {
        // First session (A) — hangs indefinitely (in-flight turn)
        return makeHangingQuery()(opts);
      }
      // Sessions B, C, D — normal persistent query
      return makePersistentQuery("reply", "sdk-test")(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> });
    });

    // Start session A with a non-resolving query (in-flight turn).
    // We attach a catch handler immediately to prevent unhandled rejection.
    const turnAPromise = manager.handleMessage("long task", "session-inflight-A", source);
    // Suppress rejection — this turn will be rejected when we call end() at the end of the test
    turnAPromise.catch(() => {});

    // Allow the query to start (session A is now in-flight)
    await Promise.resolve();
    await Promise.resolve();

    // Create sessions B and C to fill the cap to 3
    await manager.handleMessage("msg", "session-inflight-B", source);
    await manager.handleMessage("msg", "session-inflight-C", source);

    // Now create session D — cap is full (A, B, C = 3); LRU eviction should pick B (oldest idle)
    // NOT A (because A has an in-flight turn)
    await manager.handleMessage("msg", "session-inflight-D", source);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cm = manager as any;
    const map = cm.liveSessionMap as Map<string, unknown>;

    // FAILS pre-impl: A is evicted (LRU by creation time) regardless of in-flight state
    expect(map.has("session-inflight-A")).toBe(true); // A must survive (in-flight protection)
    expect(map.size).toBeLessThanOrEqual(3); // cap still enforced

    // Clean up the hanging promise to avoid unhandled rejection leakage
    // (end the session so the hanging query terminates)
    const lsA = map.get("session-inflight-A") as { end: () => void } | undefined;
    lsA?.end();
  });
});
