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

async function* defaultMockIterator() {
  yield { type: "result", result: "Build succeeded" };
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => defaultMockIterator()),
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

const mockSandboxSpawn = vi.fn((_opts: Record<string, unknown>) => {
  const { EventEmitter } = require("node:events");
  const proc = new EventEmitter();
  proc.pid = 12345;
  proc.stdout = null;
  proc.stderr = null;
  proc.kill = vi.fn();
  return proc;
});

vi.mock("../../sandbox/provider.js", () => ({
  getSandboxProvider: vi.fn(() => ({
    platform: "macos",
    isAvailable: vi.fn(async () => true),
    spawn: mockSandboxSpawn,
  })),
  isSandboxAvailable: vi.fn(async () => true),
}));

vi.mock("../../audit/violation-watcher.js", () => ({
  reportViolation: vi.fn(),
  startViolationWatcher: vi.fn(async () => () => {}),
  getViolationCount: vi.fn(() => 0),
  getRecentViolations: vi.fn(() => []),
}));

vi.mock("../../manager/execution-tools.js", () => ({
  createExecutionTools: vi.fn(() => ({ type: "sdk", name: "mock-exec-tools" })),
  EXECUTION_TOOLS_MCP_NAME: "execution-tools",
  EXECUTION_TOOLS_TOOL_PREFIX: "mcp__execution-tools__",
}));

vi.mock("../../lib/role-capabilities.js", () => ({
  resolveRolePluginPaths: vi.fn(() => []),
  generateCapabilitySummary: vi.fn(() => "Mock capabilities"),
  resolveRolePluginCapabilities: vi.fn(() => ({ pluginPaths: [], mcpServers: {} })),
}));

vi.mock("../../store/config.js", () => ({
  getConfigValue: vi.fn(() => undefined),
  setConfigValue: vi.fn(),
  getAllConfig: vi.fn(() => ({})),
}));

vi.mock("../../store/approval-rules.js", () => ({
  findMatchingRule: vi.fn(() => null),
  createApprovalRule: vi.fn(),
  listApprovalRules: vi.fn(() => []),
  deleteApprovalRule: vi.fn(),
}));

vi.mock("../../manager/execution-pool.js", () => ({
  registerTaskPid: vi.fn(),
  unregisterTaskPid: vi.fn(),
  lookupTaskByPid: vi.fn(),
}));

vi.mock("../../store/role-presets.js", () => ({
  CHAT_MANAGER_ROLE_ID: "role-chat-manager",
  initializeDefaultRoles: vi.fn(() => []),
}));

vi.mock("../../lib/path-permissions.js", () => ({
  resolveTilde: vi.fn((p: string) => p),
  redactSensitiveData: vi.fn((s: string) => s),
  FILE_TOOLS: new Set(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]),
  MAX_TOOL_OUTPUT_SIZE: 50000,
}));

vi.mock("../../manager/execution-system-prompt.js", () => ({
  buildExecutionSystemPrompt: vi.fn(() => "mock system prompt"),
  buildExecutionSystemPromptParts: vi.fn(() => ["mock-static", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", "mock-dynamic"]),
}));

import { ExecutionManager } from "../../manager/execution-manager.js";
import { serverBus } from "../../server/events/server-bus.js";
import { updateTask, getTask } from "../../store/tasks.js";
import { getRole } from "../../store/roles.js";
import { buildCanUseTool } from "../../manager/hooks.js";
import type { Task } from "../../shared/types.js";

// Get a stable reference to the mocked query so tests can configure it
const { query: mockQuery } = vi.mocked(
  await import("@anthropic-ai/claude-agent-sdk"),
);
const { createExecutionTools } = vi.mocked(
  await import("../../manager/execution-tools.js"),
);
const { buildExecutionSystemPrompt, buildExecutionSystemPromptParts } = vi.mocked(
  await import("../../manager/execution-system-prompt.js"),
);

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-test-1",
    status: "pending",
    prompt: "Run the build",
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("ExecutionManager", () => {
  describe("execute", () => {
    it("updates task status to running then completed", async () => {
      const manager = new ExecutionManager();
      const task = makeTask();

      await manager.execute(task);

      expect(updateTask).toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({ status: "running" }),
      );
      expect(updateTask).toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({ status: "completed" }),
      );
    });

    it("emits task_status_change and task_complete_event via serverBus", async () => {
      const manager = new ExecutionManager();
      const task = makeTask();

      await manager.execute(task);

      expect(serverBus.emit).toHaveBeenCalledWith({
        type: "task_status_change",
        taskId: task.id,
        oldStatus: "pending",
        newStatus: "running",
      });
      expect(serverBus.emit).toHaveBeenCalledWith({
        type: "task_status_change",
        taskId: task.id,
        oldStatus: "running",
        newStatus: "completed",
      });
      expect(serverBus.emit).toHaveBeenCalledWith({
        type: "task_complete_event",
        taskId: task.id,
        result: expect.any(String),
      });
    });

    it("returns ExecutionResult with correct fields", async () => {
      const manager = new ExecutionManager();
      const task = makeTask();

      const result = await manager.execute(task);

      expect(result).toMatchObject({
        taskId: task.id,
        status: "completed",
        result: "Build succeeded",
      });
      expect(result).toHaveProperty("durationMs");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("passes task.id to createExecutionTools and templateExecutionStep to the system prompt", async () => {
      const roleMock = {
        id: "role-template-execution",
        name: "Template Execution Role",
        cagPrompt: "",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
      };
      vi.mocked(getRole).mockReturnValue(roleMock);

      const manager = new ExecutionManager();
      const task = makeTask({
        id: "task-step-1",
        roleId: "role-template-execution",
        parentId: "exec-55",
        stepId: "step-a",
      });

      await manager.execute(task);

      expect(createExecutionTools).toHaveBeenCalledWith("role-template-execution", "task-step-1", expect.any(Function));
      expect(buildExecutionSystemPromptParts).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "task-step-1",
          templateExecutionStep: {
            executionId: "exec-55",
            stepId: "step-a",
          },
        }),
      );
    });

    it("handles SDK errors and returns status failed", async () => {
      mockQuery.mockReturnValueOnce(
        (async function* () {
          throw new Error("SDK connection refused");
        })() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>,
      );

      const manager = new ExecutionManager();
      const task = makeTask();

      const result = await manager.execute(task);

      expect(result.status).toBe("failed");
      expect(result.error).toBe("SDK connection refused");
      expect(updateTask).toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({ status: "failed" }),
      );
      expect(serverBus.emit).toHaveBeenCalledWith({
        type: "task_status_change",
        taskId: task.id,
        oldStatus: "running",
        newStatus: "failed",
      });
    });

    it("persists SDK num_turns on success instead of counting result events locally", async () => {
      mockQuery.mockReturnValueOnce(
        (async function* () {
          yield {
            type: "result",
            subtype: "success",
            result: "Done",
            num_turns: 7,
            total_cost_usd: 0.42,
            usage: { input_tokens: 120, output_tokens: 34 },
          };
        })() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>,
      );

      const manager = new ExecutionManager();
      const task = makeTask();

      const result = await manager.execute(task);

      expect(result.status).toBe("completed");
      expect(result.numTurns).toBe(7);
      // Phase 2: status is written in the terminal updateTask call; cost/tokens/numTurns
      // are written via the recordLlmCost mirror (a SEPARATE updateTask call). The mirror
      // runs synchronously (recordLlmCost's mirror block has no preceding await), so both
      // writes land before execute() returns. tokenUsage now carries cache fields.
      expect(updateTask).toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({ status: "completed" }),
      );
      expect(updateTask).toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({
          numTurns: 7,
          costUsd: 0.42,
          tokenUsage: { input: 120, output: 34, cacheRead: 0, cacheCreation: 0 },
        }),
      );
    });

    it("preserves terminal SDK metrics when an error result is followed by iterator rejection", async () => {
      mockQuery.mockReturnValueOnce(
        (async function* () {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            num_turns: 5,
            total_cost_usd: 0.19,
            usage: { input_tokens: 80, output_tokens: 12 },
          };
          throw new Error("Claude Code returned an error result: Prompt is too long");
        })() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>,
      );

      const manager = new ExecutionManager();
      const task = makeTask();

      const result = await manager.execute(task);

      expect(result).toMatchObject({
        taskId: task.id,
        status: "failed",
        error: "Claude Code returned an error result: Prompt is too long",
        costUsd: 0.19,
        numTurns: 5,
        tokenUsage: { input: 80, output: 12 },
      });
      // Phase 2: status/error are written in the terminal updateTask call; cost/tokens/numTurns
      // are written via the recordLlmCost mirror (a SEPARATE updateTask call). Assert each on
      // its own call rather than assuming one combined "last call".
      const updateCalls = (updateTask as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === task.id && typeof call[1] === "object",
      );
      // Status/error call (Task 3: error is JSON-serialized ClassifiedError, DP-002)
      const statusCall = updateCalls.find((c) => (c[1] as Record<string, unknown>).status === "failed");
      expect(statusCall).toBeDefined();
      const statusUpdates = statusCall![1] as Record<string, unknown>;
      expect(statusUpdates.status).toBe("failed");
      const classified = JSON.parse(statusUpdates.error as string);
      expect(classified.category).toBe("CONTEXT_OVERFLOW");
      expect(classified.originalError).toContain("Prompt is too long");
      expect(classified.retryable).toBe(false);
      expect(statusUpdates.errorCategory).toBe("CONTEXT_OVERFLOW");
      // recordLlmCost mirror call (carries the terminal cost/tokens/numTurns)
      const mirrorCall = updateCalls.find((c) => (c[1] as Record<string, unknown>).costUsd !== undefined);
      expect(mirrorCall).toBeDefined();
      const mirrorUpdates = mirrorCall![1] as Record<string, unknown>;
      expect(mirrorUpdates.costUsd).toBe(0.19);
      expect(mirrorUpdates.numTurns).toBe(5);
      expect(mirrorUpdates.tokenUsage).toEqual({ input: 80, output: 12, cacheRead: 0, cacheCreation: 0 });
    });

    it("uses role for workspace when roleId is provided", async () => {
      const roleMock = {
        id: "role-test",
        name: "TestRole",
        cagPrompt: "",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
      };
      vi.mocked(getRole).mockReturnValue(roleMock);

      const manager = new ExecutionManager();
      const task = makeTask({ roleId: "role-test" });

      await manager.execute(task);

      expect(getRole).toHaveBeenCalledWith("role-test");
    });

    it("merges role additionalDirectories into SDK query options with deduplication", async () => {
      const roleMock = {
        id: "role-dirs",
        name: "MultiDirRole",
        cagPrompt: "",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
        additionalDirectories: [{ path: "/projects/frontend" }, { path: "/projects/shared" }, { path: "/projects/frontend" }],
      };
      vi.mocked(getRole).mockReturnValue(roleMock);

      const manager = new ExecutionManager();
      const task = makeTask({
        roleId: "role-dirs",
        config: {
          ...makeTask().config,
          workspacePath: "/projects/backend",
        },
      });

      await manager.execute(task);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            additionalDirectories: ["/projects/frontend", "/projects/shared"],
          }),
        }),
      );
    });

    it("deduplicates when role additionalDirectories overlaps with task workspacePath", async () => {
      const roleMock = {
        id: "role-overlap",
        name: "OverlapRole",
        cagPrompt: "",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
        additionalDirectories: [{ path: "/projects/backend" }, { path: "/projects/frontend" }],
      };
      vi.mocked(getRole).mockReturnValue(roleMock);

      const manager = new ExecutionManager();
      const task = makeTask({
        roleId: "role-overlap",
        config: {
          ...makeTask().config,
          workspacePath: "/projects/backend",
        },
      });

      await manager.execute(task);

      // Implementation extracts .path from AdditionalDirectory[] and deduplicates as flat strings
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            additionalDirectories: ["/projects/backend", "/projects/frontend"],
          }),
        }),
      );
    });

    it("uses empty additionalDirectories when role has none", async () => {
      const roleMock = {
        id: "role-nodir",
        name: "NoDirRole",
        cagPrompt: "",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
      };
      vi.mocked(getRole).mockReturnValue(roleMock);

      const manager = new ExecutionManager();
      const task = makeTask({
        roleId: "role-nodir",
        config: {
          ...makeTask().config,
          workspacePath: "/projects/solo",
        },
      });

      await manager.execute(task);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            additionalDirectories: [],
          }),
        }),
      );
    });

    it("does not call getRole when task has no roleId", async () => {
      const manager = new ExecutionManager();
      const task = makeTask();

      await manager.execute(task);

      expect(getRole).not.toHaveBeenCalled();
    });

    it("passes canUseTool to SDK query options", async () => {
      const manager = new ExecutionManager();
      const task = makeTask();

      await manager.execute(task);

      expect(buildCanUseTool).toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            canUseTool: expect.any(Function),
          }),
        }),
      );
    });

    it("passes abort signal to SDK without throwing", async () => {
      const manager = new ExecutionManager();
      const task = makeTask();
      const abortController = new AbortController();

      // Abort immediately
      abortController.abort();

      const result = await manager.execute(task, abortController.signal);

      // The abort handler logs a warning but execution continues
      expect(result).toHaveProperty("taskId", task.id);
    });

    it("accumulates token usage from SDK events", async () => {
      mockQuery.mockReturnValueOnce(
        (async function* () {
          yield { type: "result", result: "Done" };
        })() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>,
      );

      const manager = new ExecutionManager();
      const task = makeTask();

      const result = await manager.execute(task);

      expect(result).toHaveProperty("taskId");
      expect(result.status).toBe("completed");
    });

    it("passes permissionMode from role to SDK query options", async () => {
      const roleMock = {
        id: "role-perms",
        name: "PermsRole",
        cagPrompt: "",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
        permissionMode: "dontAsk" as const,
      };
      vi.mocked(getRole).mockReturnValue(roleMock);

      const manager = new ExecutionManager();
      const task = makeTask({ roleId: "role-perms" });

      await manager.execute(task);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            permissionMode: "dontAsk",
          }),
        }),
      );
    });

    it("adds allowDangerouslySkipPermissions when permissionMode is bypassPermissions", async () => {
      const roleMock = {
        id: "role-bypass",
        name: "BypassRole",
        cagPrompt: "",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
        permissionMode: "bypassPermissions" as const,
      };
      vi.mocked(getRole).mockReturnValue(roleMock);

      const manager = new ExecutionManager();
      const task = makeTask({ roleId: "role-bypass" });

      await manager.execute(task);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
          }),
        }),
      );
    });

    it("defaults permissionMode to 'default' when role has no permissionMode", async () => {
      const roleMock = {
        id: "role-default-pm",
        name: "DefaultPmRole",
        cagPrompt: "",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
      };
      vi.mocked(getRole).mockReturnValue(roleMock);

      const manager = new ExecutionManager();
      const task = makeTask({ roleId: "role-default-pm" });

      await manager.execute(task);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            permissionMode: "default",
          }),
        }),
      );
      // Should NOT have allowDangerouslySkipPermissions
      const callArgs = mockQuery.mock.calls[0]?.[0] as { options?: Record<string, unknown> } | undefined;
      expect(callArgs?.options).not.toHaveProperty("allowDangerouslySkipPermissions");
    });

    it("records completedAt in task update", async () => {
      const manager = new ExecutionManager();
      const task = makeTask();

      await manager.execute(task);

      const completedCall = vi.mocked(updateTask).mock.calls.find(
        (call) => call[1].status === "completed",
      );
      expect(completedCall).toBeDefined();
      expect(completedCall![1]).toHaveProperty("completedAt");
      expect(typeof completedCall![1].completedAt).toBe("number");
    });

    it("passes persistSession: false to SDK query() options", async () => {
      const roleMock = {
        id: "role-worker",
        name: "WorkerRole",
        cagPrompt: "",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
      };
      vi.mocked(getRole).mockReturnValue(roleMock);

      const manager = new ExecutionManager();
      const task = makeTask({ roleId: "role-worker" });
      await manager.execute(task);

      const queryArgs = mockQuery.mock.calls[0]?.[0] as { options?: { persistSession?: boolean } } | undefined;
      expect(queryArgs?.options?.persistSession).toBe(false);
    });

    it("excludes RUNTIME_DIR from visiblePaths for non-ChatManager roles", async () => {
      const roleMock = {
        id: "role-worker",
        name: "WorkerRole",
        cagPrompt: "",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
      };
      vi.mocked(getRole).mockReturnValue(roleMock);

      const manager = new ExecutionManager();
      const task = makeTask({ roleId: "role-worker" });

      await manager.execute(task);

      // Extract the spawnClaudeCodeProcess callback from query() call args
      const queryArgs = mockQuery.mock.calls[0]?.[0] as { options?: { spawnClaudeCodeProcess?: (opts: Record<string, unknown>) => unknown } } | undefined;
      const spawnFn = queryArgs?.options?.spawnClaudeCodeProcess;
      expect(spawnFn).toBeDefined();

      // Invoke it to trigger sandbox.spawn with the visiblePaths closure
      mockSandboxSpawn.mockClear();
      spawnFn!({ command: "echo", args: [], cwd: "/tmp", env: {}, signal: undefined });

      expect(mockSandboxSpawn).toHaveBeenCalledTimes(1);
      const spawnOpts = mockSandboxSpawn.mock.calls[0]![0] as { visiblePaths?: Array<{ path: string; mode: string }> };
      const paths = spawnOpts.visiblePaths?.map((vp) => vp.path) ?? [];
      // Non-CM role should NOT have ~/.adam/ in visiblePaths
      expect(paths.some((p) => p.includes(".adam"))).toBe(false);
    });

    it("includes RUNTIME_DIR in visiblePaths for ChatManager role", async () => {
      const roleMock = {
        id: "role-chat-manager",
        name: "ChatManagerRole",
        cagPrompt: "",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
      };
      vi.mocked(getRole).mockReturnValue(roleMock);

      const manager = new ExecutionManager();
      const task = makeTask({ roleId: "role-chat-manager" });

      await manager.execute(task);

      // Extract and invoke the spawnClaudeCodeProcess callback
      const queryArgs = mockQuery.mock.calls[0]?.[0] as { options?: { spawnClaudeCodeProcess?: (opts: Record<string, unknown>) => unknown } } | undefined;
      const spawnFn = queryArgs?.options?.spawnClaudeCodeProcess;
      expect(spawnFn).toBeDefined();

      mockSandboxSpawn.mockClear();
      spawnFn!({ command: "echo", args: [], cwd: "/tmp", env: {}, signal: undefined });

      expect(mockSandboxSpawn).toHaveBeenCalledTimes(1);
      const spawnOpts = mockSandboxSpawn.mock.calls[0]![0] as { visiblePaths?: Array<{ path: string; mode: string }> };
      const paths = spawnOpts.visiblePaths?.map((vp) => vp.path) ?? [];
      // ChatManager role SHOULD have ~/.adam/ in visiblePaths as read-only
      expect(paths.some((p) => p.includes(".adam"))).toBe(true);
      const adamPath = spawnOpts.visiblePaths?.find((vp) => vp.path.includes(".adam"));
      expect(adamPath?.mode).toBe("ro");
    });

    it("finalize does NOT overwrite status to 'failed' when report_blocked fires and abort triggers", async () => {
      // Configure mock query to abort (simulate report_blocked triggering localAbort.abort())
      // The SDK surfaces aborts as a plain Error with the message below, NOT as AbortError.
      // Use the production error shape so this test catches regressions like the err.name guard bug.
      mockQuery.mockReturnValueOnce(
        (async function* () {
          throw new Error("Claude Code process aborted by user");
        })() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>,
      );
      // Make getTask return 'blocked' so the catch-path guard fires
      vi.mocked(updateTask).mockImplementation((id, updates) => {
        // After blocked status is set, subsequent getTask should reflect it
        // The manager calls getTask(task.id) in the catch block to check current status
      });
      vi.mocked(getTask).mockImplementation((id: string) =>
        id === "task-test-1"
          ? { id, status: "blocked", blockReason: { reason: "missing_credential" }, prompt: "test", config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 }, createdAt: Date.now() }
          : undefined,
      );

      const manager = new ExecutionManager();
      const task = makeTask();

      const result = await manager.execute(task);

      // Manager should return blocked, not failed
      expect(result.status).toBe("blocked");
      expect(result.error).toBe("Claude Code process aborted by user");

      // updateTask should NOT have been called with status='failed'
      const failedCalls = vi.mocked(updateTask).mock.calls.filter(
        (call) => call[1]?.status === "failed",
      );
      expect(failedCalls.length).toBe(0);

      // Task should remain 'blocked' in DB
      expect(vi.mocked(getTask)("task-test-1")).toMatchObject({ status: "blocked" });
    });

    it("catch path preserves existing timeout failure instead of overwriting with SDK abort", async () => {
      mockQuery.mockReturnValueOnce(
        (async function* () {
          throw new Error("Claude Code process aborted by user");
        })() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>,
      );
      vi.mocked(getTask).mockImplementation((id: string) =>
        id === "task-test-1"
          ? {
              id,
              status: "failed",
              error: '{"category":"TIMEOUT","originalError":"Task inactivity timeout"}',
              errorCategory: "TIMEOUT",
              prompt: "test",
              config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
              createdAt: Date.now(),
            }
          : undefined,
      );

      const manager = new ExecutionManager();
      const task = makeTask();

      const result = await manager.execute(task);

      expect(result.status).toBe("failed");
      expect(result.error).toContain("Task inactivity timeout");
      const managerFailedWrites = vi.mocked(updateTask).mock.calls.filter(
        (call) => call[1]?.status === "failed" && call[1]?.error !== '{"category":"TIMEOUT","originalError":"Task inactivity timeout"}',
      );
      expect(managerFailedWrites).toHaveLength(0);
    });

    it("loop-end path preserves existing cancellation instead of writing completed", async () => {
      mockQuery.mockReturnValueOnce(
        (async function* () {
          yield { type: "result", result: "late success" };
        })() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>,
      );
      vi.mocked(getTask).mockImplementation((id: string) =>
        id === "task-test-1"
          ? {
              id,
              status: "cancelled",
              error: "Cancelled by user",
              prompt: "test",
              config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
              createdAt: Date.now(),
            }
          : undefined,
      );

      const manager = new ExecutionManager();
      const task = makeTask();

      const result = await manager.execute(task);

      expect(result.status).toBe("cancelled");
      expect(result.error).toBe("Cancelled by user");
      const completedWrites = vi.mocked(updateTask).mock.calls.filter(
        (call) => call[1]?.status === "completed",
      );
      expect(completedWrites).toHaveLength(0);
    });

    it("runPostCompletion gating precondition: manager returns 'blocked' so pool skips post-completion", async () => {
      // T7: runPostCompletion is gated by `if (taskStatus !== "blocked")` in execution-pool.ts:177.
      // This test verifies the prerequisite: the manager returns 'blocked', so when the pool
      // assigns `taskStatus = result.status` it will be 'blocked' and the gate fires.
      mockQuery.mockReturnValueOnce(
        (async function* () {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        })() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>,
      );
      vi.mocked(getTask).mockImplementation((id: string) =>
        id === "task-test-1"
          ? { id, status: "blocked", blockReason: { reason: "missing_target" }, prompt: "test", config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 }, createdAt: Date.now() }
          : undefined,
      );

      const manager = new ExecutionManager();
      const task = makeTask();

      const result = await manager.execute(task);

      // The manager MUST return 'blocked' — this is the prerequisite for pool gating to work
      expect(result.status).toBe("blocked");
    });
  });
});
