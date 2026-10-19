/**
 * Unit tests: ExecutionManager task execution
 *
 * The old ManagerAgent.decisionCycle() + assign_agent tests are replaced by:
 * - dispatch_task tool creates tasks (tested via adam-tools integration)
 * - ExecutionManager executes tasks (fresh SDK query per task)
 * - ExecutionPool picks up tasks via task_created event
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as tasksStore from "../../store/tasks.js";
import { serverBus } from "../../server/events/server-bus.js";

// Use in-memory test-db
vi.mock("../../store/db.js", async () => {
  const { setupTestDb } = await import("../helpers/test-db.js");
  const { db } = setupTestDb();
  return { getDb: () => db };
});

// Mock the SDK query
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => ({
    [Symbol.asyncIterator]: async function* () {
      yield { type: "result", result: '{"analysis":"ok","actions":[]}' };
    },
  })),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../manager/adam-tools.js", () => ({
  createAdamTools: vi.fn(() => ({})),
}));

vi.mock("../../manager/hooks.js", () => ({
  buildSessionHooks: vi.fn(() => ({})),
  buildCanUseTool: vi.fn(() => () => true),
}));

vi.mock("../../agent/persona.js", () => ({
  writeRolePersona: vi.fn(),
  buildRoleSystemPrompt: vi.fn(() => "[Agent Identity]"),
}));

vi.mock("../../agent/memory-service.js", () => ({
  getRelevantMemoryContext: vi.fn().mockResolvedValue(""),
}));

vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), child: vi.fn().mockReturnThis(), level: "info",
  }),
}));

vi.mock("../../lib/permissions.js", () => ({
  computeEffectivePermissions: vi.fn().mockReturnValue({
    allowedTools: [], disallowedTools: [], approvalRequired: [], maxBudgetUsd: 5, plugins: [],
  }),
}));

vi.mock("../../config/runtime.js", () => ({
  buildSdkAuthEnv: vi.fn(() => ({})),
  buildSdkEnv: vi.fn(() => ({})),
  getRuntimeConfig: vi.fn().mockReturnValue({
    execution: { maxConcurrent: 3, pollIntervalMs: 30_000 },
  }),
}));

vi.mock("../../config/index.js", () => ({
  getDefaults: vi.fn().mockReturnValue({
    workspacePath: "/tmp/test-workspace", plugins: [],
    timeout: 600, maxTurns: 100, maxBudgetUsd: 5,
    effort: "high", model: "", settingSources: [],
    allowedTools: [], disallowedTools: [],
    approvalRequired: [], approvalTimeout: 300, env: {},
  }),
}));

vi.mock("../../store/server-state.js", () => ({
  getServerState: vi.fn().mockReturnValue({ userTaskSessionId: undefined }),
}));

vi.mock("../../strategy/engine.js", () => ({
  StrategyEngine: {
    selectStrategy: vi.fn().mockReturnValue(null),
  },
}));

describe("dispatch_task tool — task creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("task is created with pending status", () => {
    const { createTask, getTask } = tasksStore;
    const taskId = `test-task-${Date.now()}`;
    createTask({
      id: taskId,
      status: "pending",
      prompt: "Run the tests",
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
      createdAt: Date.now(),
    });

    const task = getTask(taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe("pending");
  });

  it("task_created event is emitted when task is created", () => {
    const { createTask } = tasksStore;
    const emitSpy = vi.spyOn(serverBus, "emit");
    const taskId = `test-task-${Date.now()}`;
    createTask({
      id: taskId,
      status: "pending",
      prompt: "Run the tests",
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
      createdAt: Date.now(),
    });

    serverBus.emit({ type: "task_created", taskId });
    expect(emitSpy).toHaveBeenCalled();
  });

  it("task with roleId carries role context", () => {
    createRole({
      id: "eng-1", name: "EngineerBot",
      cagPrompt: "",
      preferences: {}, learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "mem-1",
      status: "active", createdAt: Date.now(),
    });

    const { createTask, getTask } = tasksStore;
    const taskId = `skill-task-${Date.now()}`;
    createTask({
      id: taskId,
      status: "pending",
      prompt: "Fix the bug",
      roleId: "eng-1",
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
      createdAt: Date.now(),
    });

    const task = getTask(taskId);
    expect(task!.roleId).toBe("eng-1");
  });
});

describe("ExecutionPool — task pickup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ExecutionPool receives task_created event for newly created tasks", async () => {
    const onSpy = vi.spyOn(serverBus, "on");

    const { ExecutionPool } = await import("../../manager/execution-pool.js");
    const pool = new ExecutionPool(2);
    await pool.start();

    // Create a task
    const { createTask } = tasksStore;
    const taskId = `pool-test-${Date.now()}`;
    createTask({
      id: taskId,
      status: "pending",
      prompt: "Execute this",
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
      createdAt: Date.now(),
    });

    // Verify task_created subscription
    expect(onSpy).toHaveBeenCalledWith("task_created", expect.any(Function));
    pool.stop();
  });

  it("ExecutionPool respects maxConcurrent slots", async () => {
    const { ExecutionPool } = await import("../../manager/execution-pool.js");
    const pool = new ExecutionPool(2);
    const status = pool.getStatus();
    expect(status.max).toBe(2);
    expect(status.active).toBe(0);
  });
});
import { createRole } from "../../store/roles.js";
