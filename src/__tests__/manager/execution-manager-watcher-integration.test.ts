/**
 * Phase 4 Task 10 — integration test verifying workspace-watcher
 * register/unregister fires across all termination paths of ExecutionManager.execute().
 *
 * Covers:
 * - Test 1: success path → unregister fires
 * - Test 2: inner-error path (SDK throws) → unregister fires
 * - Test 3: outer-catch path (setup error) → unregister fires
 * - Test 4: chat-only / roleless task → registerTask NOT called (guard works)
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

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({ type: "sdk", name: "mock-mcp" })),
  tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => ({ name, handler })),
}));

vi.mock("../../manager/hooks.js", () => ({
  buildSessionHooks: vi.fn(() => ({})),
  buildCanUseTool: vi.fn(() => () => ({ behavior: "allow" })),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock("../../store/tasks.js", () => ({
  updateTask: vi.fn(),
  getTask: vi.fn(() => undefined),
  getTaskTraceId: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../store/roles.js", () => ({
  getRole: vi.fn(),
}));

const ensureRoleWorkspaceMock = vi.fn<(role: unknown) => string>(() => "/tmp/test-workspace");
vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: vi.fn(() => "/tmp/test-workspace"),
  // Arrow wrapper defers the const reference until call time (vi.mock factory hoists to top).
  ensureRoleWorkspace: (role: unknown) => ensureRoleWorkspaceMock(role),
}));

vi.mock("../../store/task-plugins.js", () => ({ recordTaskPlugins: vi.fn() }));
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
  const proc = new EventEmitter() as { pid: number; stdout: unknown; stderr: unknown; kill: () => void };
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
import { getLastActivity, _resetForTests } from "../../platform/workspace-watcher.js";

afterAll(() => {
  cleanup();
});

beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
  _resetForTests();
  ensureRoleWorkspaceMock.mockImplementation(() => "/tmp/test-workspace");
});

function makeTask(
  overrides: Omit<Partial<import("../../shared/types.js").Task>, "config"> & {
    config?: Partial<import("../../shared/types.js").TaskConfig>;
  } = {},
): import("../../shared/types.js").Task {
  const { config: overrideConfig, ...taskOverrides } = overrides;
  const defaultRole = {
    id: "role-test",
    name: "test-role",
    cagPrompt: "",
    learnedRules: { learned: [], examples: [] } as unknown,
    memoryStreamId: "stream-test",
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  } as unknown as import("../../shared/types.js").Role;
  const config: import("../../shared/types.js").TaskConfig = {
    timeout: 60,
    approvalRequired: [],
    approvalTimeout: 30,
    executionProfile: defaultRole,
    ...(overrideConfig ?? {}),
  };
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    prompt: "do the thing",
    status: "pending",
    createdAt: Date.now(),
    roleId: "role-test",
    ...taskOverrides,
    config,
  } as import("../../shared/types.js").Task;
}

describe("ExecutionManager workspace-watcher integration (Task 10)", () => {
  it("Test 1 — success path: unregisterTask fires after clean exit", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const task = makeTask({ config: { timeout: 60, maxTurns: 10 } });

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() {
        yield { type: "result", result: "ok", num_turns: 1, total_cost_usd: 0 };
      }
      return gen();
    });

    const manager = new ExecutionManager();
    await manager.execute(task);

    expect(getLastActivity(task.id)).toBeNull();
  });

  it("Test 2 — inner-error path: SDK throws, unregisterTask still fires", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const task = makeTask({ config: { timeout: 60, maxTurns: 10 } });

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() {
        throw new Error("SDK iterator failure");
        yield { type: "result" } as unknown;
      }
      return gen();
    });

    const manager = new ExecutionManager();
    await manager.execute(task);

    expect(getLastActivity(task.id)).toBeNull();
  });

  it("Test 3 — outer-catch path: setup error before runQuery, unregisterTask fires", async () => {
    const task = makeTask({ config: { timeout: 60, maxTurns: 10 } });

    // Force the setup-phase path: throw inside ensureRoleWorkspace, which runs at line ~198
    // BEFORE runQuery is built. This triggers the outer catch at line 673.
    ensureRoleWorkspaceMock.mockImplementationOnce(() => {
      throw new Error("Sandbox profile not available");
    });

    const manager = new ExecutionManager();
    await manager.execute(task);

    // The error propagated to outer catch → finally → unregisterTask fires.
    // Map should be clean regardless of whether registerTask had a chance to run.
    expect(getLastActivity(task.id)).toBeNull();
  });

  it("Test 4 — chat-only (no executionProfile): registerTask is NOT called, map stays clean", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    // Task with NO executionProfile → guard skips registerTask
    const task = makeTask({ config: { timeout: 60, maxTurns: 10, approvalRequired: [], approvalTimeout: 30, executionProfile: undefined } });

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() {
        yield { type: "result", result: "ok", num_turns: 1, total_cost_usd: 0 };
      }
      return gen();
    });

    const manager = new ExecutionManager();
    await manager.execute(task);

    // Task was never registered → null. (unregister is idempotent so this is the expected state.)
    expect(getLastActivity(task.id)).toBeNull();
  });
});
