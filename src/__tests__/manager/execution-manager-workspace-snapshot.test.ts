/**
 * Task 4-tests: ExecutionManager snapshot hooks — integration tests
 *
 * Verifies that:
 * - At task start, a workspace snapshot is persisted to tasks.context_meta.startSnapshot
 * - At task end, a diff is computed and rows inserted into task_files
 * - startSnapshot is cleared from context_meta after task completion
 * - Tasks that touch no files produce 0 task_files rows
 *
 * These tests fail before Task 4-impl (the snapshot hooks are not yet wired).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  query: vi.fn((() => {
    const gen = (async function* () {
      yield { type: "result", result: "done", num_turns: 1, total_cost_usd: 0 };
    })();
    (gen as unknown as Record<string, unknown>).mcpServerStatus = vi.fn(async () => []);
    return gen;
  })),
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

vi.mock("../../store/roles.js", () => ({
  getRole: vi.fn(),
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

vi.mock("../../sandbox/provider.js", () => ({
  getSandboxProvider: vi.fn(() => ({
    platform: "macos",
    isAvailable: vi.fn(async () => true),
    spawn: vi.fn(() => {
      const { EventEmitter } = require("node:events");
      const proc = new EventEmitter();
      proc.pid = 12345;
      proc.stdout = null;
      proc.stderr = null;
      proc.kill = vi.fn();
      return proc;
    }),
  })),
  isSandboxAvailable: vi.fn(async () => true),
}));

vi.mock("../../lib/error-classifier.js", () => ({
  classifyError: vi.fn((msg: string) => ({ category: "unknown", originalError: msg })),
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

// extensions (phase 3)
vi.mock("../../extensions/runtime-resolver.js", () => ({
  resolveExtensionsForTask: vi.fn(async () => ({ extensionBindingMcp: {}, extensionsSnapshot: undefined })),
}));

vi.mock("../../manager/role-mcp-registry.js", () => ({
  SYSTEM_MCP_PREFIXES: new Set<string>(),
  isSystemMcpTool: vi.fn(() => false),
  getSdkMcpServersForRole: vi.fn(async () => ({})),
  externalOAuthDenyGlobs: vi.fn(() => []),
}));

vi.mock("../../lib/tracing.js", () => ({
  withTrace: vi.fn(async (_id: unknown, _name: unknown, fn: () => unknown) => fn()),
}));

const ensureRoleWorkspaceMock = vi.fn<(role: unknown) => string>();

vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: vi.fn(() => "/tmp/ws-snap-test"),
  ensureRoleWorkspace: (role: unknown) => ensureRoleWorkspaceMock(role),
}));

import { ExecutionManager } from "../../manager/execution-manager.js";
import { createTask } from "../../store/tasks.js";
import { getTaskFiles } from "../../store/task-files.js";
import { _resetForTests } from "../../platform/workspace-watcher.js";

afterAll(() => cleanup());

let workspace: string;

beforeEach(async () => {
  clearTestDb();
  vi.clearAllMocks();
  _resetForTests();
  workspace = await mkdtemp(join(tmpdir(), "em-snap-"));
  const { getRoleWorkspacePath } = await import("../../store/role-workspace.js");
  (getRoleWorkspacePath as ReturnType<typeof vi.fn>).mockReturnValue(workspace);
  ensureRoleWorkspaceMock.mockImplementation(() => workspace);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function makeTask(id: string, overrides: Record<string, unknown> = {}) {
  const defaultRole = {
    id: "role-test",
    name: "test-role",
    cagPrompt: "",
    learnedRules: { learned: [], examples: [] },
    memoryStreamId: "stream-test",
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  };
  const task = {
    id,
    prompt: "do the thing",
    status: "pending" as const,
    createdAt: Date.now(),
    roleId: "role-test",
    config: {
      timeout: 60,
      approvalRequired: [],
      approvalTimeout: 30,
      executionProfile: defaultRole,
    },
    ...overrides,
  };
  return task as unknown as import("../../shared/types.js").Task;
}

describe("ExecutionManager workspace snapshot hooks (Task 4)", () => {
  it("captures start snapshot and stores in tasks.context_meta.startSnapshot before run", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const taskId = "snap-test-start";
    const task = makeTask(taskId);

    // Write a seed file in workspace before task starts
    await writeFile(join(workspace, "seed.txt"), "existing content");

    let contextMetaDuringRun: string | null = null;

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const gen = (async function* () {
        // Capture context_meta mid-execution (after startSnapshot should be written)
        const db = getTestDb();
        const row = db.prepare("SELECT context_meta FROM tasks WHERE id = ?").get(taskId) as
          | { context_meta: string | null }
          | undefined;
        contextMetaDuringRun = row?.context_meta ?? null;
        yield { type: "result", result: "done", num_turns: 1, total_cost_usd: 0 };
      })();
      (gen as unknown as Record<string, unknown>).mcpServerStatus = vi.fn(async () => []);
      return gen;
    });

    createTask(task);
    const manager = new ExecutionManager();
    await manager.execute(task);

    // startSnapshot should have been written to context_meta before the SDK iterator started
    expect(contextMetaDuringRun).not.toBeNull();
    const parsed = JSON.parse(contextMetaDuringRun!);
    expect(parsed).toHaveProperty("startSnapshot");
    expect(Array.isArray(parsed.startSnapshot)).toBe(true);
  });

  it("writes added rows to task_files when task creates new files", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const taskId = "snap-test-added";
    const task = makeTask(taskId);

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const gen = (async function* () {
        // Simulate role writing a file mid-execution
        await writeFile(join(workspace, "output.mp3"), "fake-mp3-bytes");
        yield { type: "result", result: "done", num_turns: 1, total_cost_usd: 0 };
      })();
      (gen as unknown as Record<string, unknown>).mcpServerStatus = vi.fn(async () => []);
      return gen;
    });

    createTask(task);
    const manager = new ExecutionManager();
    await manager.execute(task);

    const files = getTaskFiles(taskId);
    expect(files).toHaveLength(1);
    expect(files[0].op).toBe("added");
    expect(files[0].path).toContain("output.mp3");
  });

  it("writes 0 rows when task touches no files", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const taskId = "snap-test-no-files";
    const task = makeTask(taskId);

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const gen = (async function* () {
        // No file activity
        yield { type: "result", result: "done", num_turns: 1, total_cost_usd: 0 };
      })();
      (gen as unknown as Record<string, unknown>).mcpServerStatus = vi.fn(async () => []);
      return gen;
    });

    createTask(task);
    const manager = new ExecutionManager();
    await manager.execute(task);

    const files = getTaskFiles(taskId);
    expect(files).toHaveLength(0);
  });

  it("clears startSnapshot from context_meta after task completes", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const taskId = "snap-test-clear";
    const task = makeTask(taskId);

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const gen = (async function* () {
        yield { type: "result", result: "done", num_turns: 1, total_cost_usd: 0 };
      })();
      (gen as unknown as Record<string, unknown>).mcpServerStatus = vi.fn(async () => []);
      return gen;
    });

    createTask(task);
    const manager = new ExecutionManager();
    await manager.execute(task);

    // After endTask, startSnapshot should be cleared
    const db = getTestDb();
    const row = db.prepare("SELECT context_meta FROM tasks WHERE id = ?").get(taskId) as
      | { context_meta: string | null }
      | undefined;
    if (row?.context_meta) {
      const parsed = JSON.parse(row.context_meta);
      expect(parsed).not.toHaveProperty("startSnapshot");
    }
    // If context_meta is null/empty, that also means no startSnapshot — pass
  });

  it("writes modified rows when task changes pre-existing files", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const taskId = "snap-test-modified";
    const task = makeTask(taskId);

    // Seed a pre-existing file BEFORE task starts — it goes into baseline snapshot
    const filePath = join(workspace, "pre-existing.txt");
    await writeFile(filePath, "v1");

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const gen = (async function* () {
        // Mutate the pre-existing file mid-execution — both size and mtime change
        await new Promise((resolve) => setTimeout(resolve, 20)); // ensure mtime tick
        await writeFile(filePath, "v2-much-longer-content-to-change-size-too");
        yield { type: "result", result: "done", num_turns: 1, total_cost_usd: 0 };
      })();
      (gen as unknown as Record<string, unknown>).mcpServerStatus = vi.fn(async () => []);
      return gen;
    });

    createTask(task);
    const manager = new ExecutionManager();
    await manager.execute(task);

    const files = getTaskFiles(taskId);
    expect(files).toHaveLength(1);
    expect(files[0].op).toBe("modified");
    expect(files[0].path).toContain("pre-existing.txt");
  });
});
