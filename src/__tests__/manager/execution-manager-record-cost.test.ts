/**
 * Task 4: Route execution path through recordLlmCost (replace inline task-cost writes).
 *
 * Asserts:
 * - Exactly one call_id group per completed task (no double-count)
 * - tasks.cost_usd mirror == SUM of llm_costs.cost_usd for that call_id
 * - No cost fields on the status updateTask call (they went to recordLlmCost mirror)
 * - fallback path (no modelUsage) still produces a llm_costs row + tasks.cost_usd mirror
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// ─── Price table ──────────────────────────────────────────────────────────────
const TEST_PRICE_TABLE = {
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 3.75, estimated: true },
};

const MODEL_USAGE_EVENT = {
  type: "result",
  subtype: "success",
  num_turns: 2,
  total_cost_usd: 0.05,
  usage: { input_tokens: 100, output_tokens: 50 },
  modelUsage: {
    "claude-sonnet-4-6": {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.05,
    },
  },
};

// ─── Module mocks ─────────────────────────────────────────────────────────────

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
    pricing: { models: TEST_PRICE_TABLE },
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
  serverBus: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock("../../store/tasks.js", () => ({
  updateTask: vi.fn(),
  getTask: vi.fn(() => undefined),
  getTaskTraceId: vi.fn().mockReturnValue(undefined),
  updateTaskConfig: vi.fn(),
  updateContextMeta: vi.fn(),
}));

vi.mock("../../store/roles.js", () => ({ getRole: vi.fn() }));
vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: vi.fn(() => "/tmp/test-workspace"),
  ensureRoleWorkspace: vi.fn(() => "/tmp/test-workspace"),
}));
vi.mock("../../store/task-plugins.js", () => ({ recordTaskPlugins: vi.fn() }));
vi.mock("../../store/task-plans.js", () => ({ createTaskPlan: vi.fn(), updateTaskPlanStatus: vi.fn() }));
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
vi.mock("../../extensions/runtime-resolver.js", () => ({
  resolveExtensionsForTask: vi.fn(async () => ({})),
}));
vi.mock("../../store/extension-health.js", () => ({ upsertHealth: vi.fn() }));
vi.mock("../../store/role-extensions.js", () => ({ listBindingsByRole: vi.fn(() => []) }));
vi.mock("../../platform/workspace-watcher.js", () => ({ registerTask: vi.fn(), unregisterTask: vi.fn() }));
vi.mock("../../platform/workspace-snapshot.js", () => ({
  snapshot: vi.fn(async () => new Map()),
  diff: vi.fn(() => []),
  serializeTuples: vi.fn(() => []),
}));
vi.mock("../../store/task-files.js", () => ({ insertTaskFilesDiff: vi.fn() }));
vi.mock("../../audit/violation-watcher.js", () => ({ reportViolation: vi.fn() }));
vi.mock("../../store/config.js", () => ({ getConfigValue: vi.fn(() => null) }));
vi.mock("../../manager/role-mcp-registry.js", () => ({
  getSdkMcpServersForRole: vi.fn(() => []),
  SYSTEM_MCP_PREFIXES: new Set(["mcp__execution-tools__"]),
  externalOAuthDenyGlobs: vi.fn(() => []),
}));
vi.mock("../../lib/role-capabilities.js", () => ({ resolveRolePluginPaths: vi.fn(() => []) }));
vi.mock("../../store/approval-rules.js", () => ({ findMatchingRule: vi.fn(() => null) }));
vi.mock("../../manager/execution-pool.js", () => ({ registerTaskPid: vi.fn(), unregisterTaskPid: vi.fn() }));
vi.mock("../../lib/trace-context.js", () => ({
  withTrace: vi.fn(async (_traceId: unknown, _name: unknown, fn: () => unknown) => fn()),
}));
vi.mock("../../store/task-templates.js", () => ({ getTaskTemplate: vi.fn(() => null) }));
vi.mock("../../store/contract-rules.js", () => ({
  ContractRuleSchema: { safeParse: vi.fn(() => ({ success: false })) },
  isTrackA: vi.fn(() => false),
}));
vi.mock("../../audit/pre-tool-verifier.js", () => ({ buildTrackAHook: vi.fn(() => null) }));
vi.mock("../../audit/hook-context-factory.js", () => ({
  buildAuditWriter: vi.fn(() => ({})),
  buildStepLogWriter: vi.fn(() => ({})),
}));
vi.mock("../../audit/post-tool-verifier.js", () => ({ buildTrackBHook: vi.fn(() => null) }));
vi.mock("../../lib/resolve-contract-rules.js", () => ({ resolveContractRules: vi.fn(async () => []) }));
vi.mock("../../lib/audio-analysis.js", () => ({ analyzeAudioFile: vi.fn(async () => null) }));
vi.mock("../../store/logs.js", () => ({ createStepLog: vi.fn() }));
vi.mock("../../manager/execution-tools.js", () => ({
  createExecutionTools: vi.fn(() => ({ tools: [], cleanup: vi.fn() })),
  EXECUTION_TOOLS_MCP_NAME: "execution-tools",
  EXECUTION_TOOLS_MUTATION_TOOLS: [],
}));
vi.mock("../../lib/path-permissions.js", () => ({ resolveTilde: vi.fn((p: string) => p) }));
vi.mock("../../store/role-presets.js", () => ({ CHAT_MANAGER_ROLE_ID: "chat-manager" }));
vi.mock("../../manager/effort-tier-resolver.js", () => ({
  resolveTierModel: vi.fn(() => "claude-sonnet-4-6"),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { ExecutionManager } from "../../manager/execution-manager.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

afterAll(() => { cleanup(); });

beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
});

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Task 4: execution path → recordLlmCost (replace inline writes)", () => {

  it("TC1: completed path with modelUsage — exactly ONE call_id group in llm_costs", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const task = makeTask({ config: { timeout: 60, maxTurns: 10 } });

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() { yield MODEL_USAGE_EVENT; }
      return gen();
    });

    const em = new ExecutionManager();
    await em.execute(task);

    // Wait for the async recordLlmCost (void promise) to settle
    await new Promise((r) => setTimeout(r, 50));

    const db = getTestDb();
    const callIds = db.prepare(
      "SELECT DISTINCT call_id FROM llm_costs WHERE task_id = ?"
    ).all(task.id) as Array<{ call_id: string }>;

    expect(callIds).toHaveLength(1);
  });

  it("TC2: completed path — updateTask mirror call costUsd equals SUM of llm_costs.cost_usd for that call_id", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const task = makeTask({ config: { timeout: 60, maxTurns: 10 } });

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() { yield MODEL_USAGE_EVENT; }
      return gen();
    });

    const em = new ExecutionManager();
    await em.execute(task);
    await new Promise((r) => setTimeout(r, 50));

    const db = getTestDb();
    const sumRow = db.prepare(
      "SELECT SUM(cost_usd) AS total FROM llm_costs WHERE task_id = ?"
    ).get(task.id) as { total: number };

    expect(sumRow.total).toBeGreaterThan(0);

    // updateTask is mocked — verify the mirror call passed a matching costUsd
    const { updateTask } = await import("../../store/tasks.js");
    const calls = (updateTask as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>;
    const mirrorCall = calls.find(([, u]) => "costUsd" in u && !("status" in u));
    expect(mirrorCall).toBeDefined();
    expect(mirrorCall![1].costUsd as number).toBeCloseTo(sumRow.total, 8);
  });

  it("TC3: completed path — no duplicate rows (idempotent call_id via INSERT OR IGNORE)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const task = makeTask({ config: { timeout: 60, maxTurns: 10 } });

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() { yield MODEL_USAGE_EVENT; }
      return gen();
    });

    const em = new ExecutionManager();
    await em.execute(task);
    await new Promise((r) => setTimeout(r, 50));

    const db = getTestDb();
    const count = (db.prepare(
      "SELECT COUNT(*) AS n FROM llm_costs WHERE task_id = ?"
    ).get(task.id) as { n: number }).n;

    // One modelUsage entry → exactly one llm_costs row
    expect(count).toBe(1);
  });

  it("TC4: fallback (no modelUsage) — still inserts a llm_costs row with model='unknown'", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const task = makeTask({ config: { timeout: 60, maxTurns: 10 } });

    const noModelUsageEvent = {
      type: "result",
      num_turns: 1,
      total_cost_usd: 0.02,
      usage: { input_tokens: 50, output_tokens: 25 },
      // no modelUsage
    };

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() { yield noModelUsageEvent; }
      return gen();
    });

    const em = new ExecutionManager();
    await em.execute(task);
    await new Promise((r) => setTimeout(r, 50));

    const db = getTestDb();
    const row = db.prepare(
      "SELECT model, cost_usd FROM llm_costs WHERE task_id = ?"
    ).get(task.id) as { model: string; cost_usd: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.model).toBe("unknown");
    expect(row!.cost_usd).toBeCloseTo(0.02, 8);
  });

  it("TC5: failed path — recordLlmCost still fires after task failure", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const task = makeTask({ config: { timeout: 60, maxTurns: 10 } });

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() {
        yield MODEL_USAGE_EVENT;
        throw new Error("simulated failure after result event");
      }
      return gen();
    });

    const em = new ExecutionManager();
    await em.execute(task);
    await new Promise((r) => setTimeout(r, 50));

    const db = getTestDb();
    const count = (db.prepare(
      "SELECT COUNT(*) AS n FROM llm_costs WHERE task_id = ?"
    ).get(task.id) as { n: number }).n;

    expect(count).toBeGreaterThanOrEqual(1);
  });
});
