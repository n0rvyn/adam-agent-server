import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { ExecutionManager } from "../../manager/execution-manager.js";
import type { Role, Task } from "../../shared/types.js";
import { getRole } from "../../store/roles.js";
import { getTask, updateTask } from "../../store/tasks.js";

const { cleanup } = setupTestDb();

async function* defaultMockIterator() {
  yield { type: "result", result: "ok" };
}

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/runtime.js", () => ({
  buildSdkAuthEnv: vi.fn(() => ({})),
  buildSdkEnv: vi.fn(() => ({})),
  getRuntimeConfig: vi.fn(() => ({
    anthropic: { apiKey: "", baseUrl: "", model: "", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", smallFastModel: "" },
    defaults: { maxBudgetUsd: 5 },
  })),
  initRuntimeConfig: vi.fn(),
  loadPersistedConfig: vi.fn(),
}));

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

vi.mock("../../store/roles.js", () => ({
  getRole: vi.fn<(id: string) => Role | undefined>(),
}));

vi.mock("../../store/tasks.js", () => ({
  updateTask: vi.fn<(id: string, updates: Record<string, unknown>) => void>(),
  getTask: vi.fn<(id: string) => Task | undefined>(),
  getTaskTraceId: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: vi.fn(() => "/tmp/test-workspace"),
  ensureRoleWorkspace: vi.fn(() => "/tmp/test-workspace"),
}));

vi.mock("../../store/task-plugins.js", () => ({ recordTaskPlugins: vi.fn() }));
vi.mock("../../store/task-plans.js", () => ({ createTaskPlan: vi.fn(), updateTaskPlanStatus: vi.fn() }));
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
  deleteApprovalRules: vi.fn(),
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

vi.mock("../../manager/execution-pool.js", () => ({
  registerTaskPid: vi.fn(),
  unregisterTaskPid: vi.fn(),
  lookupTaskByPid: vi.fn(),
}));

vi.mock("../../store/plugin-registry.js", () => ({
  listInstalledPlugins: vi.fn(() => []),
  getPluginManifest: vi.fn(() => null),
}));

vi.mock("../../strategy/engine.js", () => ({
  StrategyEngine: { selectStrategy: vi.fn(() => null) },
}));

vi.mock("../../manager/execution-system-prompt.js", () => ({
  buildExecutionSystemPrompt: vi.fn(() => "mock system prompt"),
  buildExecutionSystemPromptParts: vi.fn(() => ["mock-static", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", "mock-dynamic"]),
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

// Stable reference for assertions
const { query: mockQuery } = vi.mocked(await import("@anthropic-ai/claude-agent-sdk"));
const { buildExecutionSystemPromptParts } = vi.mocked(await import("../../manager/execution-system-prompt.js"));

beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-skills-test",
    status: "pending",
    prompt: "test prompt",
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: "role-test",
    name: "Test",
    cagPrompt: "You are a test role.",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "mem-test",
    status: "active",
    preferences: {},
    createdAt: Date.now(),
    ...overrides,
  } as Role;
}

describe("ExecutionManager skills pass-through", () => {
  it("passes skills: 'all' to SDK query when role has skills: 'all'", async () => {
    const role = makeRole({ skills: "all" });
    vi.mocked(getRole).mockReturnValue(role);
    const task = makeTask({ roleId: role.id });
    vi.mocked(getTask).mockReturnValue(task);

    mockQuery.mockReturnValueOnce(
      defaultMockIterator() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>,
    );

    const em = new ExecutionManager();
    await em.execute(task);

    expect(mockQuery).toHaveBeenCalled();
    const callArgs = mockQuery.mock.calls[0]?.[0] as { options?: Record<string, unknown> } | undefined;
    expect(callArgs?.options?.skills).toBe("all");
  });

  it("passes skills: ['pdf', 'docx'] to SDK query when role has array skills", async () => {
    const role = makeRole({ skills: ["pdf", "docx"] });
    vi.mocked(getRole).mockReturnValue(role);
    const task = makeTask({ roleId: role.id });
    vi.mocked(getTask).mockReturnValue(task);

    mockQuery.mockReturnValueOnce(
      defaultMockIterator() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>,
    );

    const em = new ExecutionManager();
    await em.execute(task);

    expect(mockQuery).toHaveBeenCalled();
    const callArgs = mockQuery.mock.calls[0]?.[0] as { options?: Record<string, unknown> } | undefined;
    expect(callArgs?.options?.skills).toEqual(["pdf", "docx"]);
  });

  it("omits skills key from query options when role has no skills field", async () => {
    const role = makeRole({ skills: undefined });
    vi.mocked(getRole).mockReturnValue(role);
    const task = makeTask({ roleId: role.id });
    vi.mocked(getTask).mockReturnValue(task);

    mockQuery.mockReturnValueOnce(
      defaultMockIterator() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>,
    );

    const em = new ExecutionManager();
    await em.execute(task);

    expect(mockQuery).toHaveBeenCalled();
    const callArgs = mockQuery.mock.calls[0]?.[0] as { options?: Record<string, unknown> } | undefined;
    expect(Object.prototype.hasOwnProperty.call(callArgs?.options, "skills")).toBe(false);
  });
});
