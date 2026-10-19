/**
 * Task 4-tests: ExecutionManager cost-recompute tests
 *
 * These tests verify that on a `modelUsage`-bearing result event, ExecutionManager:
 * - stores the recomputed total in cost_usd (not the SDK value)
 * - populates cost_breakdown with provenance on BOTH completed and failed paths
 * - derives aggregate token_usage (incl. cache) from modelUsage
 * - marks unknown keys without zeroing the priced total
 *
 * These tests MUST FAIL before Task 4-impl wires the recompute.
 * Drive via ExecutionManager.execute(), asserting on updateTask.mock.calls.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { recomputeCost } from "../../lib/cost-pricing.js";
import type { PriceTable } from "../../lib/cost-pricing.js";

const { cleanup } = setupTestDb();

// ─── Price table fixture (matches plan spec) ─────────────────────────────────
const TEST_PRICE_TABLE: PriceTable = {
  "MiniMax-M2.7-highspeed": { input: 0.26, output: 1.00, cacheRead: 0.26, cacheCreation: 0.26 }, // confirmed
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 3.75, estimated: true },
};

// ─── Synthetic result event fixture (from plan spec) ─────────────────────────
const MINIMAX_MODEL_USAGE = {
  "MiniMax-M2.7-highspeed": {
    inputTokens: 117,
    outputTokens: 334,
    cacheReadInputTokens: 20081,
    cacheCreationInputTokens: 9086,
    costUSD: 0.075763,
    webSearchRequests: 0,
    contextWindow: 200000,
    maxOutputTokens: 32000,
  },
};

const MINIMAX_RESULT_EVENT = {
  type: "result",
  subtype: "success",
  num_turns: 3,
  total_cost_usd: 0.075763,
  usage: {
    input_tokens: 117,
    output_tokens: 334,
    cache_creation_input_tokens: 9086,
    cache_read_input_tokens: 20081,
  },
  modelUsage: MINIMAX_MODEL_USAGE,
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
    pricing: {
      models: TEST_PRICE_TABLE,
    },
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
  updateTaskConfig: vi.fn(),
  updateContextMeta: vi.fn(),
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

vi.mock("../../extensions/runtime-resolver.js", () => ({
  resolveExtensionsForTask: vi.fn(async () => ({})),
}));

vi.mock("../../store/extension-health.js", () => ({
  upsertHealth: vi.fn(),
}));

vi.mock("../../store/role-extensions.js", () => ({
  listBindingsByRole: vi.fn(() => []),
}));

vi.mock("../../platform/workspace-watcher.js", () => ({
  registerTask: vi.fn(),
  unregisterTask: vi.fn(),
}));

vi.mock("../../platform/workspace-snapshot.js", () => ({
  snapshot: vi.fn(async () => new Map()),
  diff: vi.fn(() => []),
  serializeTuples: vi.fn(() => []),
}));

vi.mock("../../store/task-files.js", () => ({
  insertTaskFilesDiff: vi.fn(),
}));

vi.mock("../../audit/violation-watcher.js", () => ({
  reportViolation: vi.fn(),
}));

vi.mock("../../store/config.js", () => ({
  getConfigValue: vi.fn(() => null),
}));

vi.mock("../../manager/role-mcp-registry.js", () => ({
  getSdkMcpServersForRole: vi.fn(() => []),
  SYSTEM_MCP_PREFIXES: new Set(["mcp__execution-tools__"]),
  externalOAuthDenyGlobs: vi.fn(() => []),
}));

vi.mock("../../lib/role-capabilities.js", () => ({
  resolveRolePluginPaths: vi.fn(() => []),
}));

vi.mock("../../store/approval-rules.js", () => ({
  findMatchingRule: vi.fn(() => null),
}));

vi.mock("../../manager/execution-pool.js", () => ({
  registerTaskPid: vi.fn(),
  unregisterTaskPid: vi.fn(),
}));

vi.mock("../../lib/trace-context.js", () => ({
  withTrace: vi.fn(async (_traceId: unknown, _name: unknown, fn: () => unknown) => fn()),
}));

vi.mock("../../store/task-templates.js", () => ({
  getTaskTemplate: vi.fn(() => null),
}));

vi.mock("../../store/contract-rules.js", () => ({
  ContractRuleSchema: { safeParse: vi.fn(() => ({ success: false })) },
  isTrackA: vi.fn(() => false),
}));

vi.mock("../../audit/pre-tool-verifier.js", () => ({
  buildTrackAHook: vi.fn(() => null),
}));

vi.mock("../../audit/hook-context-factory.js", () => ({
  buildAuditWriter: vi.fn(() => ({})),
  buildStepLogWriter: vi.fn(() => ({})),
}));

vi.mock("../../audit/post-tool-verifier.js", () => ({
  buildTrackBHook: vi.fn(() => null),
}));

vi.mock("../../lib/resolve-contract-rules.js", () => ({
  resolveContractRules: vi.fn(async () => []),
}));

vi.mock("../../lib/audio-analysis.js", () => ({
  analyzeAudioFile: vi.fn(async () => null),
}));

vi.mock("../../store/logs.js", () => ({
  createStepLog: vi.fn(),
}));

vi.mock("../../manager/execution-tools.js", () => ({
  createExecutionTools: vi.fn(() => ({
    tools: [],
    cleanup: vi.fn(),
  })),
  EXECUTION_TOOLS_MCP_NAME: "execution-tools",
  EXECUTION_TOOLS_MUTATION_TOOLS: [],
}));

vi.mock("../../lib/path-permissions.js", () => ({
  resolveTilde: vi.fn((p: string) => p),
}));

vi.mock("../../store/role-presets.js", () => ({
  CHAT_MANAGER_ROLE_ID: "chat-manager",
}));

vi.mock("../../manager/effort-tier-resolver.js", () => ({
  resolveTierModel: vi.fn(() => "claude-sonnet-4-6"),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { ExecutionManager } from "../../manager/execution-manager.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

afterAll(() => {
  cleanup();
});

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

/** Find an updateTask call matching a predicate on the updates arg. */
async function findUpdateCall(
  predicate: (updates: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | undefined> {
  const { updateTask } = await import("../../store/tasks.js");
  const calls = (updateTask as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>;
  return calls.find(([, updates]) => predicate(updates))?.[1];
}

/**
 * After Task 4, cost fields are written by recordLlmCost's mirror (a separate updateTask call
 * with costUsd/tokenUsage/costBreakdown but NO 'status' field). Find it by looking for the
 * cost-mirror call (has costUsd, lacks status).
 */
async function findCostMirrorCall(): Promise<Record<string, unknown> | undefined> {
  return findUpdateCall((u) => "costUsd" in u && !("status" in u));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ExecutionManager cost-recompute (Task 4-tests)", () => {
  it("TC1: completed path — stored cost_usd is recomputed, not SDK total_cost_usd", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const task = makeTask({ config: { timeout: 60, maxTurns: 10 } });

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() {
        yield MINIMAX_RESULT_EVENT;
      }
      return gen();
    });

    const em = new ExecutionManager();
    await em.execute(task);
    // Allow the async recordLlmCost mirror (void promise) to settle
    await new Promise((r) => setTimeout(r, 50));

    // Compute expected value
    const expected = recomputeCost(MINIMAX_MODEL_USAGE, TEST_PRICE_TABLE, MINIMAX_RESULT_EVENT.total_cost_usd);

    // After Task 4, cost is on the mirror updateTask call (has costUsd, no status field)
    const mirrorCall = await findCostMirrorCall();
    expect(mirrorCall).toBeDefined();

    // costUsd must NOT be the SDK value (0.075763); must be the recomputed value
    expect(mirrorCall!.costUsd).not.toBe(0.075763);
    expect(mirrorCall!.costUsd).toBeCloseTo(expected.costUsd, 8);
  });

  it("TC2: completed path — cost_breakdown has correct provenance (priced/estimated)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const task = makeTask({ config: { timeout: 60, maxTurns: 10 } });

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() {
        yield MINIMAX_RESULT_EVENT;
      }
      return gen();
    });

    const em = new ExecutionManager();
    await em.execute(task);
    await new Promise((r) => setTimeout(r, 50));

    const mirrorCall = await findCostMirrorCall();
    expect(mirrorCall).toBeDefined();

    const breakdown = mirrorCall!.costBreakdown as import("../../lib/cost-pricing.js").CostRecompute;
    expect(breakdown).toBeDefined();
    expect(breakdown.perModel).toHaveLength(1);
    expect(breakdown.perModel[0].model).toBe("MiniMax-M2.7-highspeed");
    expect(breakdown.perModel[0].priced).toBe(true);
    // No estimated flag in the table for MiniMax (operator-set) → estimated === false
    expect(breakdown.perModel[0].estimated).toBe(false);
    // SDK total is retained as reference
    expect(breakdown.sdkTotalCostUsd).toBe(0.075763);
    expect(breakdown.pricingStatus).toBe("priced");
    expect(breakdown.unknownModels).toHaveLength(0);
  });

  it("TC3: completed path — token_usage includes cacheRead and cacheCreation summed from modelUsage", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const task = makeTask({ config: { timeout: 60, maxTurns: 10 } });

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() {
        yield MINIMAX_RESULT_EVENT;
      }
      return gen();
    });

    const em = new ExecutionManager();
    await em.execute(task);
    await new Promise((r) => setTimeout(r, 50));

    // After Task 4, token_usage is on the mirror updateTask call (has costUsd, no status)
    const mirrorCall = await findCostMirrorCall();
    expect(mirrorCall).toBeDefined();

    const tokenUsage = mirrorCall!.tokenUsage as import("../../shared/types.js").TokenUsage;
    expect(tokenUsage).toBeDefined();
    expect(tokenUsage.input).toBe(117);
    expect(tokenUsage.output).toBe(334);
    expect(tokenUsage.cacheRead).toBe(20081);
    expect(tokenUsage.cacheCreation).toBe(9086);
  });

  it("TC4: failed path — cost_breakdown is written via recordLlmCost mirror", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const task = makeTask({ config: { timeout: 60, maxTurns: 10 } });

    // The generator yields the result event (sets function-scope costBreakdown) then throws.
    // recordLlmCost mirror must fire on the failed path too.
    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() {
        yield MINIMAX_RESULT_EVENT;
        throw new Error("simulated failure after result event");
      }
      return gen();
    });

    const em = new ExecutionManager();
    await em.execute(task);
    await new Promise((r) => setTimeout(r, 50));

    // Status call must be "failed" (no cost fields)
    const failedCall = await findUpdateCall((u) => u.status === "failed");
    expect(failedCall).toBeDefined();
    expect(failedCall!.costBreakdown).toBeUndefined();

    // Cost fields are on the mirror call
    const mirrorCall = await findCostMirrorCall();
    expect(mirrorCall).toBeDefined();
    const breakdown = mirrorCall!.costBreakdown as import("../../lib/cost-pricing.js").CostRecompute;
    expect(breakdown).toBeDefined();
    expect(breakdown.perModel).toHaveLength(1);
    expect(breakdown.perModel[0].model).toBe("MiniMax-M2.7-highspeed");
    expect(breakdown.perModel[0].priced).toBe(true);
    expect(breakdown.sdkTotalCostUsd).toBe(0.075763);
  });

  it("TC5: unknown model — cost_breakdown.pricingStatus is unknown, cost_usd is 0", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const task = makeTask({ config: { timeout: 60, maxTurns: 10 } });

    const unknownModelEvent = {
      ...MINIMAX_RESULT_EVENT,
      modelUsage: {
        "unknown-model-xyz": {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.05,
        },
      },
    };

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() {
        yield unknownModelEvent;
      }
      return gen();
    });

    const em = new ExecutionManager();
    await em.execute(task);
    await new Promise((r) => setTimeout(r, 50));

    const mirrorCall = await findCostMirrorCall();
    expect(mirrorCall).toBeDefined();

    const breakdown = mirrorCall!.costBreakdown as import("../../lib/cost-pricing.js").CostRecompute;
    expect(breakdown).toBeDefined();
    expect(breakdown.pricingStatus).toBe("unknown");
    expect(breakdown.unknownModels).toContain("unknown-model-xyz");
    // cost_usd must be 0 (no priced models)
    expect(mirrorCall!.costUsd).toBe(0);
  });

  it("TC6: seeded-key non-null — an event whose key IS in the table yields non-null cost_usd", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const task = makeTask({ config: { timeout: 60, maxTurns: 10 } });

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() {
        yield MINIMAX_RESULT_EVENT;
      }
      return gen();
    });

    const em = new ExecutionManager();
    await em.execute(task);
    await new Promise((r) => setTimeout(r, 50));

    const mirrorCall = await findCostMirrorCall();
    expect(mirrorCall).toBeDefined();
    expect(mirrorCall!.costUsd).toBeDefined();
    expect(typeof mirrorCall!.costUsd).toBe("number");
    expect((mirrorCall!.costUsd as number) > 0).toBe(true);
  });

  it("TC7: mixed models — partial pricingStatus, total reflects priced-only", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const task = makeTask({ config: { timeout: 60, maxTurns: 10 } });

    const mixedEvent = {
      ...MINIMAX_RESULT_EVENT,
      modelUsage: {
        "MiniMax-M2.7-highspeed": MINIMAX_MODEL_USAGE["MiniMax-M2.7-highspeed"],
        "unknown-model-xyz": {
          inputTokens: 200,
          outputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.01,
        },
      },
    };

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() {
        yield mixedEvent;
      }
      return gen();
    });

    const em = new ExecutionManager();
    await em.execute(task);
    await new Promise((r) => setTimeout(r, 50));

    const mirrorCall = await findCostMirrorCall();
    expect(mirrorCall).toBeDefined();

    const breakdown = mirrorCall!.costBreakdown as import("../../lib/cost-pricing.js").CostRecompute;
    expect(breakdown.pricingStatus).toBe("partial");
    expect(breakdown.unknownModels).toContain("unknown-model-xyz");

    // Total should equal the MiniMax priced cost only
    const expectedMinimax = recomputeCost(
      { "MiniMax-M2.7-highspeed": MINIMAX_MODEL_USAGE["MiniMax-M2.7-highspeed"] },
      TEST_PRICE_TABLE,
    );
    expect(mirrorCall!.costUsd).toBeCloseTo(expectedMinimax.costUsd, 8);
  });

  it("TC8: no modelUsage in event — fallback builds synthetic 'unknown' breakdown, mirrors cost_usd", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const task = makeTask({ config: { timeout: 60, maxTurns: 10 } });

    const noModelUsageEvent = {
      type: "result",
      num_turns: 2,
      total_cost_usd: 0.05,
      usage: { input_tokens: 100, output_tokens: 50 },
      // no modelUsage field
    };

    (query as ReturnType<typeof vi.fn>).mockImplementation(() => {
      async function* gen() {
        yield noModelUsageEvent;
      }
      return gen();
    });

    const em = new ExecutionManager();
    await em.execute(task);
    await new Promise((r) => setTimeout(r, 50));

    // After Task 4, fallback path builds a synthetic perModel with model='unknown'
    // and passes it to recordLlmCost, which mirrors costUsd to tasks.
    const mirrorCall = await findCostMirrorCall();
    expect(mirrorCall).toBeDefined();

    // costUsd should be the SDK total_cost_usd (from the fallback)
    expect(mirrorCall!.costUsd).toBeCloseTo(0.05, 8);

    // costBreakdown is now always present (synthetic 'unknown' on fallback path)
    const breakdown = mirrorCall!.costBreakdown as import("../../lib/cost-pricing.js").CostRecompute;
    expect(breakdown).toBeDefined();
    expect(breakdown.pricingStatus).toBe("unknown");
    expect(breakdown.perModel).toHaveLength(1);
    expect(breakdown.perModel[0].model).toBe("unknown");
  });
});
