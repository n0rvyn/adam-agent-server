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

import { ExecutionManager } from "../../manager/execution-manager.js";

afterAll(() => {
  cleanup();
});

beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
});

describe("SDK completion fix (DP-004 Option B)", () => {
  // Helper: build a minimal task
  function makeTask(
    overrides: Omit<Partial<import("../../shared/types.js").Task>, "config"> & {
      config?: Partial<import("../../shared/types.js").TaskConfig>;
    } = {},
  ): import("../../shared/types.js").Task {
    const { config: overrideConfig, ...taskOverrides } = overrides;
    const defaultConfig: import("../../shared/types.js").TaskConfig = {
      timeout: 60,
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

  it("Test 1: iterator emits result then closes — task completed within 5s", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const task = makeTask({ config: { timeout: 60, maxTurns: 10 } });

    // Mock: iterator yields one result then closes naturally
    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() {
        yield { type: "result", result: "Build succeeded", num_turns: 2, total_cost_usd: 0.01 };
      }
      return gen();
    });

    const em = new ExecutionManager();
    const result = await em.execute(task);

    console.log("Test 1 result:", JSON.stringify(result, null, 2));
    expect(result.status).toBe("completed");
    expect(result.result).toBe("Build succeeded");
  });

  it("Test 2: iterator never closes — after inactivity timeout, request aborted and task marked FAILED (not completed)", async () => {
    // Behavior change (2026-06-01 timeout-failfast plan): a force-closed-on-inactivity
    // task must NOT be recorded as `completed` with the sentinel as its result. It is
    // aborted (localAbort.abort) and routed to the failed path. This reverses the prior
    // "DP-004 Option B" fallback, which delivered the sentinel string to users as a
    // fake-success. See docs/06-plans/2026-06-01-timeout-failfast-plan.md Task 2.
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const task = makeTask({ config: { timeout: 2, maxTurns: 5 } });

    // Mock: iterator hangs forever (simulates the a6dedea8 hang)
    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() {
        // Never yields a result, never closes — simulates hang
        await new Promise<void>((resolve) => setTimeout(resolve, 30_000));
      }
      return gen();
    });

    const em = new ExecutionManager();
    const start = Date.now();
    const result = await em.execute(task);
    const elapsed = Date.now() - start;

    // Timeout → failed (NOT completed)
    expect(result.status).toBe("failed");
    // The internal sentinel must NOT be surfaced as a deliverable result
    expect(result.result ?? "").not.toBe("ExecutionManager: SDK loop force-closed after activity timeout");
    // Elapsed should be close to the inactivity window (INACTIVITY_MS = timeout/2 * 1000 = 1000ms)
    expect(elapsed).toBeGreaterThan(800);
    expect(elapsed).toBeLessThan(5000);

    // updateTask was called with status "failed" (not "completed")
    const { updateTask } = await import("../../store/tasks.js");
    const updateTaskCalls = (updateTask as ReturnType<typeof vi.fn>).mock.calls;
    const failedCall = updateTaskCalls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown>)?.status === "failed",
    );
    expect(failedCall).toBeDefined();
    const completedCall = updateTaskCalls.find(
      (call: unknown[]) => (call[1] as Record<string, unknown>)?.status === "completed",
    );
    expect(completedCall).toBeUndefined();
  });
});
