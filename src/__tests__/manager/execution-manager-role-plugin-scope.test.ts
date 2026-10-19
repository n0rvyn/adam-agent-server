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
  yield { type: "result", result: "ok" };
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
  serverBus: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock("../../store/tasks.js", () => ({
  updateTask: vi.fn(),
  getTask: vi.fn(() => undefined),
  getTaskTraceId: vi.fn().mockReturnValue(undefined),
  updateTaskConfig: vi.fn(),
  updateContextMeta: vi.fn(),
}));

vi.mock("../../store/roles.js", () => ({
  getRole: vi.fn(),
}));

vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: vi.fn(() => "/tmp/test-role-workspace"),
  ensureRoleWorkspace: vi.fn(() => "/tmp/test-role-workspace"),
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

const FAKE_PLUGIN_PATH = "/Users/example/.claude/plugins/cache/personal-os/tts-toolkit/0.3.1";
const FAKE_PLUGIN_PATH_2 = "/Users/example/.claude/plugins/cache/minimax-skills/minimax-skills/1.0.0";

vi.mock("../../lib/role-capabilities.js", () => ({
  resolveRolePluginPaths: vi.fn(() => [FAKE_PLUGIN_PATH, FAKE_PLUGIN_PATH_2]),
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
import { buildCanUseTool } from "../../manager/hooks.js";
import { recordTaskPlugins } from "../../store/task-plugins.js";
import type { Task, Role } from "../../shared/types.js";

const { query: mockQuery } = vi.mocked(
  await import("@anthropic-ai/claude-agent-sdk"),
);

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
});

function makeRole(): Role {
  return {
    id: "role-with-plugin",
    name: "test-plugin-role",
    cagPrompt: "",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "ms-1",
    status: "active",
    preferences: {},
    createdAt: Date.now(),
    additionalDirectories: [
      { path: "/tmp/extra-rw-dir", mode: "rw" },
    ],
  } as Role;
}

function makeTask(role: Role): Task {
  return {
    id: "task-plugin-scope-test",
    roleId: role.id,
    status: "pending",
    prompt: "Run synth-auto",
    config: {
      timeout: 600,
      approvalRequired: [],
      approvalTimeout: 300,
      executionProfile: role,
    },
    createdAt: Date.now(),
  } as Task;
}

describe("execution-manager — taskPluginPaths must flow into 3 permission sinks", () => {
  it("[Case 1] SDK additionalDirectories option includes plugin install paths", async () => {
    const role = makeRole();
    const task = makeTask(role);
    const manager = new ExecutionManager();

    await manager.execute(task);

    expect(mockQuery).toHaveBeenCalled();
    const options = mockQuery.mock.calls[0][0].options as { additionalDirectories?: string[] };
    expect(options.additionalDirectories).toBeDefined();
    expect(options.additionalDirectories).toContain(FAKE_PLUGIN_PATH);
    expect(options.additionalDirectories).toContain(FAKE_PLUGIN_PATH_2);
    // Pre-existing addDirs entries still present
    expect(options.additionalDirectories).toContain("/tmp/extra-rw-dir");
  });

  it("[Case 2] buildCanUseTool roleScope includes plugin install paths", async () => {
    const role = makeRole();
    const task = makeTask(role);
    const manager = new ExecutionManager();

    await manager.execute(task);

    const mockedBuild = vi.mocked(buildCanUseTool);
    expect(mockedBuild).toHaveBeenCalled();
    const optsArg = mockedBuild.mock.calls[0][2] as { roleScope?: string[] };
    expect(optsArg.roleScope).toBeDefined();
    expect(optsArg.roleScope).toContain(FAKE_PLUGIN_PATH);
    expect(optsArg.roleScope).toContain(FAKE_PLUGIN_PATH_2);
    // cwd (role workspace) still present in scope
    expect(optsArg.roleScope).toContain("/tmp/test-role-workspace");
  });

  it("[Case 3] sandbox visiblePaths includes plugin paths with mode=ro", async () => {
    const role = makeRole();
    const task = makeTask(role);
    const manager = new ExecutionManager();

    await manager.execute(task);

    // Invoke the spawnClaudeCodeProcess closure that the SDK was given,
    // so the sandbox spawn arg gets captured.
    const options = mockQuery.mock.calls[0][0].options as {
      spawnClaudeCodeProcess?: (opts: Record<string, unknown>) => unknown;
    };
    expect(options.spawnClaudeCodeProcess).toBeDefined();
    options.spawnClaudeCodeProcess!({
      command: "/bin/true",
      args: [],
      cwd: "/tmp/test-role-workspace",
      env: {},
      signal: new AbortController().signal,
    });

    expect(mockSandboxSpawn).toHaveBeenCalled();
    const spawnArgs = mockSandboxSpawn.mock.calls[0][0] as {
      visiblePaths: Array<{ path: string; mode: string }>;
    };
    const pluginEntry = spawnArgs.visiblePaths.find((v) => v.path === FAKE_PLUGIN_PATH);
    const pluginEntry2 = spawnArgs.visiblePaths.find((v) => v.path === FAKE_PLUGIN_PATH_2);
    expect(pluginEntry).toBeDefined();
    expect(pluginEntry?.mode).toBe("ro");
    expect(pluginEntry2).toBeDefined();
    expect(pluginEntry2?.mode).toBe("ro");
    // Role's own cwd still rw
    const cwdEntry = spawnArgs.visiblePaths.find((v) => v.path === "/tmp/test-role-workspace");
    expect(cwdEntry?.mode).toBe("rw");
  });

  it("[Case 4] recordTaskPlugins still receives the same plugin paths (audit semantics unchanged)", async () => {
    const role = makeRole();
    const task = makeTask(role);
    const manager = new ExecutionManager();

    await manager.execute(task);

    const mockedRecord = vi.mocked(recordTaskPlugins);
    expect(mockedRecord).toHaveBeenCalledWith(
      task.id,
      [FAKE_PLUGIN_PATH, FAKE_PLUGIN_PATH_2],
      role.id,
    );
  });
});
