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
    anthropic: {
      apiKey: "",
      baseUrl: "",
      model: "",
      defaultOpusModel: "",
      defaultSonnetModel: "",
      defaultHaikuModel: "",
      smallFastModel: "",
    },
    defaults: {},
  })),
  initRuntimeConfig: vi.fn(),
  loadPersistedConfig: vi.fn(),
}));

async function* defaultMockIterator() {
  yield { type: "result", result: "Snapshot executed" };
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => defaultMockIterator()),
  createSdkMcpServer: vi.fn(() => ({ type: "sdk", name: "mock-mcp" })),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => ({
    name: _name,
    handler,
  })),
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
  updateTask: vi.fn(),
  getTask: vi.fn(() => undefined),
}));

vi.mock("../../store/roles.js", () => ({
  getRole: vi.fn(),
}));

vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: vi.fn((name: string) => `/tmp/workspace-${name}`),
  ensureRoleWorkspace: vi.fn(),
}));

vi.mock("../../store/task-plugins.js", () => ({
  recordTaskPlugins: vi.fn(),
}));

vi.mock("../../store/task-plans.js", () => ({
  createTaskPlan: vi.fn(),
  updateTaskPlanStatus: vi.fn(),
}));

vi.mock("../../sandbox/provider.js", () => ({
  getSandboxProvider: vi.fn(() => ({
    platform: "macos",
    isAvailable: vi.fn(async () => true),
    spawn: vi.fn(() => {
      const { EventEmitter } = require("node:events");
      const proc = new EventEmitter();
      proc.pid = 23456;
      proc.stdout = null;
      proc.stderr = null;
      proc.kill = vi.fn();
      return proc;
    }),
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
import { updateTask, getTask } from "../../store/tasks.js";
import { getRole } from "../../store/roles.js";
import type { Task, Role } from "../../shared/types.js";
import { EXECUTION_TOOLS_MCP_NAME } from "../../manager/execution-tools.js";
import { SYSTEM_MCP_PREFIXES } from "../../manager/role-mcp-registry.js";

const { query: mockQuery } = vi.mocked(
  await import("@anthropic-ai/claude-agent-sdk"),
);
const { buildExecutionSystemPrompt, buildExecutionSystemPromptParts } = vi.mocked(
  await import("../../manager/execution-system-prompt.js"),
);

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
});

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: "role-under-test",
    name: "UnderTest",
    cagPrompt: "snapshot prompt",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "",
    status: "active",
    createdAt: Date.now(),
    allowedTools: ["Read", "Write"],
    disallowedTools: [],
    approvalRequired: [],
    osCapabilities: [],
    additionalDirectories: [],
    ...overrides,
  } as Role;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-snapshot-test",
    status: "pending",
    prompt: "Run snapshot test",
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("ExecutionManager snapshot semantics", () => {
  it("uses frozen executionProfile even when live Role has been mutated (D-006/D-007)", async () => {
    // Snapshot captured at dispatch time — writer-like role
    const snapshot = makeRole({
      id: "role-snapshot",
      name: "SnapshotWriter",
      cagPrompt: "ORIGINAL persona captured at dispatch",
      allowedTools: ["Read", "Write"],
      disallowedTools: [],
      approvalRequired: [],
      additionalDirectories: [{ path: "/snapshot/data", mode: "rw" }],
    });

    // Live Role has been mutated after dispatch — different tools + persona + dirs
    const mutatedLiveRole = makeRole({
      id: "role-snapshot",
      name: "SnapshotWriter",
      cagPrompt: "MUTATED persona after dispatch",
      allowedTools: ["Read"], // lost Write
      disallowedTools: ["Write"],
      approvalRequired: ["Bash"],
      additionalDirectories: [{ path: "/mutated/data", mode: "ro" }],
    });
    vi.mocked(getRole).mockReturnValue(mutatedLiveRole);

    const manager = new ExecutionManager();
    const task = makeTask({
      roleId: "role-snapshot",
      config: {
        timeout: 600,
        approvalRequired: [],
        approvalTimeout: 300,
        executionProfile: snapshot,
      },
    });

    await manager.execute(task);

    // Invariant 1: getRole never consulted because snapshot is present
    expect(getRole).not.toHaveBeenCalled();

    // Invariant 2: system prompt built from snapshot persona, not live role
    expect(buildExecutionSystemPromptParts).toHaveBeenCalledWith(
      expect.objectContaining({
        roleName: "SnapshotWriter",
        roleCagPrompt: "ORIGINAL persona captured at dispatch",
        allowedTools: ["Read", "Write"],
      }),
    );

    // Invariant 3: SDK query options reflect snapshot dirs, not mutated dirs
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          additionalDirectories: ["/snapshot/data"],
        }),
      }),
    );

    // Invariant 4: execution did NOT write-back a new snapshot (one was already present)
    const writeBackCall = vi.mocked(updateTask).mock.calls.find(
      (call) => call[1]?.config?.executionProfile !== undefined,
    );
    expect(writeBackCall).toBeUndefined();
  });

  it("registers execution-tools MCP under the EXECUTION_TOOLS_MCP_NAME key", async () => {
    const snapshot = makeRole({
      id: "role-key-test",
      name: "KeyTestRole",
      cagPrompt: "key test prompt",
      allowedTools: ["Read"],
      disallowedTools: [],
    });
    vi.mocked(getRole).mockReturnValue(snapshot);

    const manager = new ExecutionManager();
    const task = makeTask({
      roleId: "role-key-test",
      config: {
        timeout: 600,
        approvalRequired: [],
        approvalTimeout: 300,
        executionProfile: snapshot,
      },
    });

    await manager.execute(task);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          mcpServers: expect.objectContaining({
            [EXECUTION_TOOLS_MCP_NAME]: expect.anything(),
          }),
        }),
      }),
    );

    // Pin the constant value so a future rename that drifts the carve-out prefix
    // surfaces as a separate failure here (together with the SYSTEM_MCP_PREFIXES
    // invariant test in hooks.test.ts, these lock the execution-tools namespace contract).
    expect(EXECUTION_TOOLS_MCP_NAME).toBe("execution-tools");
  });

  it("augments SDK options.allowedTools with SYSTEM_MCP_PREFIXES glob patterns when role has non-empty allowedTools", async () => {
    const snapshot = makeRole({
      id: "role-restrictive",
      name: "RestrictiveRole",
      cagPrompt: "restrictive prompt",
      allowedTools: ["WebSearch", "Read"],
      disallowedTools: [],
    });
    vi.mocked(getRole).mockReturnValue(snapshot);

    const manager = new ExecutionManager();
    const task = makeTask({
      id: "task-augmentation",
      roleId: "role-restrictive",
      config: {
        timeout: 600,
        approvalRequired: [],
        approvalTimeout: 300,
        executionProfile: snapshot,
      },
    });

    await manager.execute(task);

    // Build expected patterns from the live registry — keeps this test automatically
    // in sync with any future SYSTEM_MCP_PREFIXES addition.
    const expectedSystemPatterns = Array.from(SYSTEM_MCP_PREFIXES).map((p) => `${p}*`);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          allowedTools: expect.arrayContaining([
            "WebSearch",
            "Read",
            ...expectedSystemPatterns,
          ]),
        }),
      }),
    );
  });

  it("does NOT augment SDK options.allowedTools when role.allowedTools is undefined (no allowlist)", async () => {
    const snapshot = makeRole({
      id: "role-no-allowlist",
      name: "NoAllowlistRole",
      cagPrompt: "permissive role",
      allowedTools: undefined,
      disallowedTools: [],
    });
    vi.mocked(getRole).mockReturnValue(snapshot);

    const manager = new ExecutionManager();
    const task = makeTask({
      id: "task-no-allowlist",
      roleId: "role-no-allowlist",
      config: {
        timeout: 600,
        approvalRequired: [],
        approvalTimeout: 300,
        executionProfile: snapshot,
      },
    });

    await manager.execute(task);

    // Find the most recent mockQuery call (the one this test triggered)
    const lastCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    const opts = lastCall?.[0]?.options as { allowedTools?: unknown } | undefined;
    // When role.allowedTools is undefined, the ternary returns undefined verbatim —
    // SDK interprets undefined as "no allowlist, all tools auto-allowed" (covered by canUseTool path).
    expect(opts?.allowedTools).toBeUndefined();
  });

  it("does NOT augment SDK options.allowedTools when role.allowedTools is an empty array", async () => {
    const snapshot = makeRole({
      id: "role-empty-allowlist",
      name: "EmptyAllowlistRole",
      cagPrompt: "empty allowlist",
      allowedTools: [],
      disallowedTools: [],
    });
    vi.mocked(getRole).mockReturnValue(snapshot);

    const manager = new ExecutionManager();
    const task = makeTask({
      id: "task-empty-allowlist",
      roleId: "role-empty-allowlist",
      config: {
        timeout: 600,
        approvalRequired: [],
        approvalTimeout: 300,
        executionProfile: snapshot,
      },
    });

    await manager.execute(task);

    const lastCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    const opts = lastCall?.[0]?.options as { allowedTools?: unknown } | undefined;
    // Empty array `.length === 0` is falsy → ternary returns the empty array as-is.
    // SDK interprets empty allowedTools the same as undefined (no allowlist).
    // Critical: we must NOT silently turn `[]` into `[mcp__system__*, ...]` — that would
    // grant ONLY system tools to a fully-locked-down role, which is a different policy.
    expect(opts?.allowedTools).toEqual([]);
  });

  it("lazy-backfills executionProfile from live Role for legacy tasks and writes it back (D-008)", async () => {
    // Legacy task: no executionProfile set
    const legacyTask = makeTask({
      id: "task-legacy",
      roleId: "role-legacy",
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
    });

    const liveRole = makeRole({
      id: "role-legacy",
      name: "LegacyRole",
      cagPrompt: "live persona",
      allowedTools: ["Read", "Grep"],
      additionalDirectories: [{ path: "/legacy/src", mode: "ro" }],
    });
    vi.mocked(getRole).mockReturnValue(liveRole);

    // getTask returns a fresh view of the task (used by write-back to preserve config)
    vi.mocked(getTask).mockReturnValue(legacyTask);

    const manager = new ExecutionManager();
    await manager.execute(legacyTask);

    // Invariant 1: getRole called exactly once for backfill
    expect(getRole).toHaveBeenCalledTimes(1);
    expect(getRole).toHaveBeenCalledWith("role-legacy");

    // Invariant 2: executionProfile was written back to the task record
    const writeBackCall = vi.mocked(updateTask).mock.calls.find(
      (call) => call[1]?.config?.executionProfile !== undefined,
    );
    expect(writeBackCall).toBeDefined();
    expect(writeBackCall![0]).toBe("task-legacy");
    expect(writeBackCall![1].config!.executionProfile).toMatchObject({
      id: "role-legacy",
      name: "LegacyRole",
      cagPrompt: "live persona",
    });

    // Invariant 3: execution uses the backfilled snapshot (prompt + dirs from live role)
    expect(buildExecutionSystemPromptParts).toHaveBeenCalledWith(
      expect.objectContaining({
        roleName: "LegacyRole",
        roleCagPrompt: "live persona",
        allowedTools: ["Read", "Grep"],
      }),
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          additionalDirectories: ["/legacy/src"],
        }),
      }),
    );
  });
});
