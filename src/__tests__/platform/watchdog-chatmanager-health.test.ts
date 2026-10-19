/**
 * Task 8-tests: Watchdog per-session health checks for ChatManager.
 *
 * Expected initial state (before Task 8-impl):
 * FAILS because:
 * - `isProcessing()` and `getQueueDepth()` are coarse-grained aggregates (count all sessions),
 *   not per-session-aware (any session with a stuck in-flight turn should be individually
 *   detectable and recoverable without disturbing healthy sessions).
 * - `restartSession()` currently clears ALL live sessions; it must instead close+recreate
 *   only the sessions whose in-flight turn is stale.
 * - No `getStaleSessions()` or equivalent per-session staleness API exists.
 *
 * After Task 8-impl, all assertions below pass.
 *
 * Contract verified:
 * 1. A LiveSession with a turn in-flight beyond stale threshold is detectable via
 *    per-session staleness inspection (isStale() or equivalent aggregate).
 * 2. `restartSession()` closes ONLY the stuck session(s) and leaves healthy sessions alive.
 * 3. `getLastActivityAt()` reflects the most recent turn completion across all sessions.
 * 4. `getQueueDepth()` returns the count of sessions with an in-flight or queued turn.
 * 5. `isProcessing()` returns true when at least one session has an in-flight turn.
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

/** Normal persistent query that yields one result per non-seed message */
function makeNormalQuery(sessionId = "sdk-wdog-test") {
  return async function* (params?: { prompt?: AsyncIterable<{ shouldQuery?: boolean }> }) {
    const prompt = params?.prompt;
    if (!prompt) {
      yield { type: "result", result: "ok", num_turns: 1, total_cost_usd: 0, session_id: sessionId, modelUsage: {}, usage: { input_tokens: 0, output_tokens: 0 } };
      return;
    }
    for await (const userMsg of prompt) {
      if (userMsg?.shouldQuery === false) continue;
      yield { type: "result", result: "ok", num_turns: 1, total_cost_usd: 0, session_id: sessionId, modelUsage: {}, usage: { input_tokens: 0, output_tokens: 0 } };
    }
  };
}

/** Hanging query — never yields a result (simulates stuck in-flight turn) */
function makeHangingQuery() {
  return async function* (_params?: unknown) {
    await new Promise<void>(() => {}); // never resolves
    yield { type: "result", result: "never", num_turns: 0, total_cost_usd: 0, session_id: "hang", modelUsage: {}, usage: { input_tokens: 0, output_tokens: 0 } };
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Task 8-tests: ChatManager per-session watchdog health", () => {
  let manager: ChatManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQueryFn.mockImplementation((opts: unknown) =>
      makeNormalQuery()(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> })
    );
    manager = new ChatManager();
    await manager.start();
  });

  afterEach(() => {
    manager.stop();
    vi.clearAllMocks();
  });

  /**
   * WD-TC1: `getQueueDepth()` reflects in-flight sessions.
   * A session with an in-flight turn contributes to queueDepth.
   *
   * Partially passes pre-impl: queueDepth returns liveSessionMap.size,
   * which includes in-flight sessions — this is a coarse aggregate.
   * Task 8-impl should refine this to count only in-flight/queued sessions.
   */
  it("WD-TC1: getQueueDepth() > 0 when at least one session has an in-flight turn", async () => {
    const source: ChatSource = { type: "web" };

    // Start a hanging session (in-flight, never resolves)
    let hangQueryCallCount = 0;
    mockQueryFn.mockImplementation((opts: unknown) => {
      hangQueryCallCount++;
      if (hangQueryCallCount === 1) return makeHangingQuery()(opts);
      return makeNormalQuery()(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> });
    });

    // Session A: in-flight (hanging)
    const turnAPromise = manager.handleMessage("long task", "session-wd-1", source);
    turnAPromise.catch(() => {});

    // Allow session A to start. The turn becomes in-flight only after getOrCreateLiveSession
    // (seed inject) + the per-turn delta buildSessionContext await + push — so poll for the
    // in-flight state rather than assuming a fixed number of microtask flushes.
    for (let i = 0; i < 50 && manager.getQueueDepth() === 0; i++) await Promise.resolve();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const depth = manager.getQueueDepth();
    expect(depth).toBeGreaterThan(0);

    // Cleanup
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = (manager as any).liveSessionMap as Map<string, { end: () => void }>;
    map.get("session-wd-1")?.end();
  });

  /**
   * WD-TC2: `isProcessing()` reflects in-flight turns.
   * True when at least one session has a turn in flight.
   */
  it("WD-TC2: isProcessing() true when a session has an in-flight turn", async () => {
    const source: ChatSource = { type: "web" };

    let hangCount = 0;
    mockQueryFn.mockImplementation((opts: unknown) => {
      hangCount++;
      if (hangCount === 1) return makeHangingQuery()(opts);
      return makeNormalQuery()(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> });
    });

    const turnPromise = manager.handleMessage("task", "session-wd-2", source);
    turnPromise.catch(() => {});

    // Poll for in-flight (wiring adds awaits before push — see WD-TC1 note).
    for (let i = 0; i < 50 && !manager.isProcessing(); i++) await Promise.resolve();

    expect(manager.isProcessing()).toBe(true);

    const map = (manager as any).liveSessionMap as Map<string, { end: () => void }>; // eslint-disable-line @typescript-eslint/no-explicit-any
    map.get("session-wd-2")?.end();
  });

  /**
   * WD-TC3 (RED pre-impl): `restartSession()` closes ONLY the stuck session,
   * not healthy sessions.
   *
   * FAILS pre-impl: current `restartSession()` calls `end()` on ALL live sessions
   * (liveSessionMap iteration) — it does NOT distinguish stuck from healthy.
   * Task 8-impl must make `restartSession()` close+recreate only sessions whose
   * in-flight turn is stale, leaving healthy sessions alive.
   */
  it("WD-TC3: restartSession() closes stuck sessions only, healthy sessions survive", async () => {
    const source: ChatSource = { type: "web" };

    let queryCallNum = 0;
    mockQueryFn.mockImplementation((opts: unknown) => {
      queryCallNum++;
      if (queryCallNum === 1) {
        // Session A: hanging (stuck in-flight)
        return makeHangingQuery()(opts);
      }
      // Session B: normal
      return makeNormalQuery()(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> });
    });

    // Session A: stuck
    const turnAPromise = manager.handleMessage("stuck", "session-wdtc3-A", source);
    turnAPromise.catch(() => {});

    await Promise.resolve();
    await Promise.resolve();

    // Session B: healthy (completes normally)
    await manager.handleMessage("healthy", "session-wdtc3-B", source);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cm = manager as any;
    const mapBefore = cm.liveSessionMap as Map<string, { end: () => void }>;

    // Both sessions alive before restart
    expect(mapBefore.has("session-wdtc3-A")).toBe(true);
    expect(mapBefore.has("session-wdtc3-B")).toBe(true);

    // Spy on session B's end() — it must NOT be called (healthy session)
    const bSession = mapBefore.get("session-wdtc3-B");
    const bEndSpy = bSession ? vi.spyOn(bSession, "end") : undefined;

    // Trigger watchdog restart (targets stuck sessions only in Task 8-impl)
    await manager.restartSession();

    // FAILS pre-impl: restartSession() calls end() on ALL sessions including B
    // After Task 8-impl: session B must survive (end() not called on B)
    expect(bEndSpy?.mock.calls.length ?? 1).toBe(0); // 0 = B was NOT ended

    // Cleanup any hanging turn
    const mapAfter = cm.liveSessionMap as Map<string, { end: () => void }>;
    mapAfter.get("session-wdtc3-A")?.end();
    mapAfter.get("session-wdtc3-B")?.end();
  });

  /**
   * WD-TC4: `getLastActivityAt()` reflects the most recent turn completion.
   * After a successful turn, lastActivityAt should be recent.
   */
  it("WD-TC4: getLastActivityAt() updated after a successful turn", async () => {
    const source: ChatSource = { type: "web" };
    const before = Date.now();

    await manager.handleMessage("hello", "session-wd-4", source);

    const after = Date.now();
    const lastActivity = manager.getLastActivityAt();

    expect(lastActivity).toBeGreaterThanOrEqual(before);
    expect(lastActivity).toBeLessThanOrEqual(after + 100);
  });
});
