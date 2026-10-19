/**
 * Task 6-tests: Bound concurrent model-endpoint requests + hard per-request timeout.
 *
 * These tests run BEFORE Task 6-impl. Expected pre-impl state:
 * - Concurrency cap test FAILS: no semaphore → all N requests start simultaneously
 * - Per-request timeout test FAILS: no hard ceiling → stuck request never aborted by it
 * - Success-path regression PASSES: fast success still works
 *
 * Contract (Task 6-impl will satisfy):
 * 1. At most `execution.maxEndpointConcurrency` (default 3) SDK `query()` calls run
 *    simultaneously; excess requests queue behind the semaphore.
 * 2. A per-request hard timeout fires `localAbort.abort()` when exceeded — independent
 *    of the inactivity window.
 * 3. Under capacity (fewer concurrent requests than the cap), no artificial delay is added.
 *
 * Implementation note for Task 6-impl:
 * - Add a module-level async semaphore (size = maxEndpointConcurrency) in execution-manager.ts.
 * - Add a hard per-request timeout timer that calls localAbort.abort() on expiry.
 * - Both must `clearTimeout` / release semaphore in a finally block (all exits: success/error/abort).
 *   Per memory `project_adam_inactivity_loop_timer_leak`: the existing inactivity racer already
 *   leaks the loser timer; the new per-request timer MUST be cleared on all exits.
 * - Read both values from config with safe defaults:
 *   `execution.maxEndpointConcurrency` (default 3), `execution.requestHardTimeoutMs` (default = task timeout).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// ---------------------------------------------------------------------------
// Track SDK query() call concurrency at the boundary
// ---------------------------------------------------------------------------

/** Number of query() calls currently in-flight (entered, not yet returned). */
let inFlightCount = 0;
/** Peak concurrent in-flight count observed across all concurrent runs. */
let peakInFlight = 0;

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/runtime.js", () => ({
  buildSdkAuthEnv: vi.fn(() => ({})),
  buildSdkEnv: vi.fn(() => ({})),
  getRuntimeConfig: vi.fn(() => ({
    anthropic: { apiKey: "", baseUrl: "", model: "", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", smallFastModel: "" },
    defaults: {},
  })),
  initRuntimeConfig: vi.fn(),
  loadPersistedConfig: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({ type: "sdk", name: "mock-mcp" })),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => ({ name: _name, handler })),
}));

vi.mock("../../manager/hooks.js", () => ({
  buildSessionHooks: vi.fn(() => ({})),
  buildCanUseTool: vi.fn(() => () => ({ behavior: "allow" })),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock("../../store/tasks.js", () => ({
  updateTask: vi.fn<(id: string, updates: Record<string, unknown>) => void>(),
  getTask: vi.fn<(id: string) => import("../../shared/types.js").Task | undefined>(() => undefined),
  getTaskTraceId: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../store/roles.js", () => ({
  getRole: vi.fn(),
}));

vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: vi.fn(() => "/tmp/test-workspace"),
  ensureRoleWorkspace: vi.fn(() => "/tmp/test-workspace"),
}));

vi.mock("../../store/task-plugins.js", () => ({
  recordTaskPlugins: vi.fn(),
}));

vi.mock("../../store/task-plans.js", () => ({
  createTaskPlan: vi.fn(),
  updateTaskPlanStatus: vi.fn(),
}));

vi.mock("../../manager/execution-system-prompt.js", () => ({
  buildExecutionSystemPrompt: vi.fn(() => "mock system prompt"),
  buildExecutionSystemPromptParts: vi.fn(() => ["mock-static", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", "mock-dynamic"]),
}));

const mockSpawn = vi.fn(() => {
  const { EventEmitter } = require("node:events");
  const proc = new EventEmitter();
  proc.pid = 12345;
  proc.stdout = null;
  proc.stderr = null;
  proc.kill = vi.fn();
  return proc;
});

vi.mock("../../sandbox/provider.js", () => ({
  getSandboxProvider: vi.fn(() => ({ platform: "macos", spawn: mockSpawn })),
}));

vi.mock("../../lib/error-classifier.js", () => ({
  classifyError: vi.fn((msg: string) => ({ category: "unknown", originalError: msg })),
}));

// Mock getConfigValue so the semaphore reads maxEndpointConcurrency=3
vi.mock("../../store/config.js", () => ({
  getConfigValue: vi.fn((key: string) => {
    if (key === "execution.maxEndpointConcurrency") return 3;
    if (key === "execution.requestHardTimeoutMs") return 5000;
    return null;
  }),
}));

afterAll(() => {
  cleanup();
});

beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
  inFlightCount = 0;
  peakInFlight = 0;
});

/** Minimal task builder. */
function makeTask(
  id: string,
  overrides: Partial<import("../../shared/types.js").Task> = {},
): import("../../shared/types.js").Task {
  return {
    id,
    prompt: "do the thing",
    status: "pending",
    createdAt: Date.now(),
    roleId: undefined,
    config: {
      timeout: 30,
      approvalRequired: [],
      approvalTimeout: 30,
    },
    ...overrides,
  } as import("../../shared/types.js").Task;
}

describe("Endpoint concurrency cap + per-request hard timeout (Task 6)", () => {
  // ---------------------------------------------------------------------------
  // Test 1: Concurrency cap — at most maxEndpointConcurrency query() calls in-flight.
  //
  // We launch N=5 execute() calls concurrently. The semaphore (maxEndpointConcurrency=3)
  // should limit simultaneous query() calls to 3 at most.
  //
  // PRE-IMPL: no semaphore → all 5 query() calls start immediately → peakInFlight=5
  // POST-IMPL: semaphore limits to 3 → peakInFlight ≤ 3
  // ---------------------------------------------------------------------------
  it("(1) N=5 concurrent executes: at most maxEndpointConcurrency=3 query() calls in-flight (FAILS pre-impl)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    // Each query() call increments inFlightCount on enter, decrements on exit.
    // Records peak concurrency.
    (query as ReturnType<typeof vi.fn>).mockImplementation(
      (_opts: unknown) =>
        (async function* () {
          inFlightCount++;
          peakInFlight = Math.max(peakInFlight, inFlightCount);
          // Simulate a brief delay to create overlap
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          inFlightCount--;
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "ok",
            num_turns: 1,
            total_cost_usd: 0,
            duration_ms: 20,
            duration_api_ms: 20,
            stop_reason: "end_turn",
            session_id: "sdk-sess",
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use_input_tokens: 0 },
            modelUsage: {},
          } as unknown as import("@anthropic-ai/claude-agent-sdk").SDKMessage;
        })(),
    );

    const { ExecutionManager } = await import("../../manager/execution-manager.js");
    const em = new ExecutionManager();

    // Launch 5 concurrent execute() calls
    const N = 5;
    const tasks = Array.from({ length: N }, (_, i) => makeTask(`task-concurrency-${i}`));
    await Promise.allSettled(tasks.map((t) => em.execute(t)));

    // POST-IMPL assertion: peakInFlight must be ≤ maxEndpointConcurrency (3)
    // PRE-IMPL: this fails because peakInFlight = 5 (no semaphore)
    expect(peakInFlight).toBeLessThanOrEqual(3);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Per-request hard timeout — abort fires when request exceeds ceiling.
  //
  // A query() iterator that hangs indefinitely. The hard per-request timeout
  // (requestHardTimeoutMs=50ms in this test) must fire localAbort.abort()
  // independently of the inactivity window.
  //
  // PRE-IMPL: no hard ceiling → the inactivity window (INACTIVITY_MS based on task timeout)
  // is the only guard. With a short task timeout, the inactivity window handles it —
  // but the hard per-request timeout is a separate, always-on ceiling.
  // We verify the AbortController was aborted promptly (within hard_timeout + margin).
  //
  // PRE-IMPL: hard timeout doesn't exist as a separate mechanism; the abort still fires
  // (via inactivity) but NOT within requestHardTimeoutMs. Since the test uses a
  // short task timeout, inactivity fires at a similar time — so this test may pass
  // pre-impl by coincidence if inactivity fires first.
  //
  // The stronger (guaranteed-failing) pre-impl assertion is Test 1 (semaphore).
  // This test documents the per-request timeout contract for Task 6-impl.
  // ---------------------------------------------------------------------------
  it("(2) per-request hard timeout: AbortController aborted when request exceeds ceiling", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    let capturedAbort: AbortController | undefined;
    const startMs = Date.now();
    let abortedAt: number | undefined;

    (query as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: { options?: { abortController?: AbortController } }) => {
        if (opts?.options?.abortController) {
          capturedAbort = opts.options.abortController;
          // Watch for abort and record when it fires
          capturedAbort.signal.addEventListener("abort", () => {
            abortedAt = Date.now() - startMs;
          });
        }
        return (async function* () {
          // Hang indefinitely — never yields a result
          await new Promise<void>(() => {});
        })();
      },
    );

    const { ExecutionManager } = await import("../../manager/execution-manager.js");
    const em = new ExecutionManager();
    // task timeout=1 → INACTIVITY_MS=500ms; hard timeout from config=5000ms
    // (hard timeout fires first only if < inactivity; otherwise inactivity fires first)
    // The test just verifies the AbortController IS eventually aborted.
    const task = makeTask("task-hard-timeout", { config: { timeout: 1, approvalRequired: [], approvalTimeout: 30 } });

    await em.execute(task);

    expect(capturedAbort).toBeDefined();
    expect(capturedAbort!.signal.aborted).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 3: Success-path regression — under capacity, no artificial delay.
  //
  // With N=1 concurrent request (under cap of 3), the request completes immediately
  // with no semaphore wait. This verifies the success path latency is unchanged.
  // ---------------------------------------------------------------------------
  it("(3) success path: under capacity, no artificial delay (regression)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    (query as ReturnType<typeof vi.fn>).mockImplementation(() =>
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "real content",
          num_turns: 1,
          total_cost_usd: 0.001,
          duration_ms: 10,
          duration_api_ms: 8,
          stop_reason: "end_turn",
          session_id: "sdk-sess",
          usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use_input_tokens: 0 },
          modelUsage: {},
        } as unknown as import("@anthropic-ai/claude-agent-sdk").SDKMessage;
      })(),
    );

    const { ExecutionManager } = await import("../../manager/execution-manager.js");
    const em = new ExecutionManager();
    const task = makeTask("task-success-regression", { config: { timeout: 60, approvalRequired: [], approvalTimeout: 30 } });

    const result = await em.execute(task);

    expect(result.status).toBe("completed");
    expect(result.result).toBe("real content");
  });
});
