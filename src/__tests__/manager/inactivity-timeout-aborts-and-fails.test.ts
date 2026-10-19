/**
 * Task 2-tests: Inactivity timeout aborts the request and marks the task `failed`.
 *
 * These tests run BEFORE the implementation exists (Task 2-impl). Expected BEFORE state:
 * - "stalled iterator → task failed" FAILS: status is currently "completed" (sentinel path)
 * - "success path regression" PASSES (already working)
 *
 * Contract:
 * 1. When the SDK loop goes silent past INACTIVITY_MS, the task ends `failed` (not `completed`).
 * 2. The result does NOT equal/contain "force-closed after activity timeout".
 * 3. The AbortController passed to query() was aborted (localAbort.abort() was called).
 * 4. A normal `result` event still yields `completed` with the real result (success path).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

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

// Capture the AbortController passed to query() so tests can assert .signal.aborted.
let capturedAbortController: AbortController | undefined;

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

afterAll(() => {
  cleanup();
});

beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
  capturedAbortController = undefined;
});

/** Minimal task builder. Use timeout=1 so INACTIVITY_MS = max(500, min(180000, 500)) = 500ms. */
function makeTask(
  overrides: Omit<Partial<import("../../shared/types.js").Task>, "config"> & {
    config?: Partial<import("../../shared/types.js").TaskConfig>;
  } = {},
): import("../../shared/types.js").Task {
  const { config: overrideConfig, ...taskOverrides } = overrides;
  const defaultConfig: import("../../shared/types.js").TaskConfig = {
    timeout: 1,            // 1s → INACTIVITY_MS = max(500, min(180000, 500)) = 500ms
    approvalRequired: [],
    approvalTimeout: 30,
    ...(overrideConfig ?? {}),
  };
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    prompt: "do the thing",
    status: "pending",
    createdAt: Date.now(),
    roleId: "role-test",
    ...taskOverrides,
    config: defaultConfig,
  } as import("../../shared/types.js").Task;
}

describe("Inactivity timeout: aborts request and marks task failed (Task 2)", () => {
  it("stalled iterator → task failed, result does not contain sentinel, abort was signalled", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    (query as ReturnType<typeof vi.fn>).mockImplementation((opts: { options?: { abortController?: AbortController } }) => {
      // Capture the AbortController passed by ExecutionManager so we can assert .signal.aborted
      if (opts?.options?.abortController) {
        capturedAbortController = opts.options.abortController;
      }

      // Return an iterator that emits one non-result event then hangs forever.
      // The inactivity racer will win after INACTIVITY_MS (~500ms for timeout=1).
      async function* gen() {
        // Emit a system_prompt event (not a result event) to show the loop starts
        yield { type: "system_prompt", system_prompt: "you are an agent" } as unknown as import("@anthropic-ai/claude-agent-sdk").SDKMessage;
        // Then hang indefinitely
        await new Promise<void>(() => {});
      }
      return gen();
    });

    const { ExecutionManager } = await import("../../manager/execution-manager.js");
    const em = new ExecutionManager();
    const task = makeTask();

    const result = await em.execute(task);

    // EXPECTED AFTER IMPL: status is "failed" because timeout routes to catch path
    // EXPECTED BEFORE IMPL: status is "completed" — this line FAILS before Task 2-impl
    expect(result.status).toBe("failed");

    // The result must not contain the internal sentinel string
    expect(result.result ?? "").not.toContain("force-closed after activity timeout");

    // The AbortController should have been aborted (localAbort.abort() was called)
    expect(capturedAbortController).toBeDefined();
    expect(capturedAbortController!.signal.aborted).toBe(true);

    // updateTask should have been called with status "failed" (not "completed")
    const { updateTask } = await import("../../store/tasks.js");
    const calls = (updateTask as ReturnType<typeof vi.fn>).mock.calls;
    const failedCall = calls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown>)?.status === "failed",
    );
    expect(failedCall).toBeDefined();

    // Must NOT have a completed call
    const completedCall = calls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown>)?.status === "completed",
    );
    expect(completedCall).toBeUndefined();
  });

  it("success path regression: normal result event yields completed with real result", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "real content from the model",
          num_turns: 1,
          total_cost_usd: 0.001,
          duration_ms: 100,
          duration_api_ms: 80,
          stop_reason: "end_turn",
          session_id: "sdk-sess-test",
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use_input_tokens: 0 },
          modelUsage: {},
        } as unknown as import("@anthropic-ai/claude-agent-sdk").SDKMessage;
      }
      return gen();
    });

    const { ExecutionManager } = await import("../../manager/execution-manager.js");
    const em = new ExecutionManager();
    const task = makeTask({ config: { timeout: 60 } });

    const result = await em.execute(task);

    expect(result.status).toBe("completed");
    expect(result.result).toBe("real content from the model");
  });
});
