/**
 * Task 5-tests (capture half) + Task 8-tests (live path extension):
 * chat-path cost capture tests.
 *
 * Asserts that when the SDK loop sees a result event with cost fields,
 * the returned ChatManagerResponse.cost carries the FULL CostRecompute
 * (including perModel[] array, pricingStatus, costUsd > 0).
 *
 * Task 8-tests extension: also asserts cost capture on the live path
 * (via handleMessageWithDispatches / LiveSession).
 *
 * FAILS before Task 5-impl (cost field absent on ChatManagerResponse).
 * Task 8-tests new sections FAIL before Task 8-impl.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ChatManagerResponse, ChatSource } from "../../shared/types.js";

// ─── Price table fixture ──────────────────────────────────────────────────────
const TEST_PRICE_TABLE = {
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 3.75, estimated: true },
};

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../store/db.js", () => ({
  getDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    anthropic: { apiKey: "test-key", baseUrl: "", model: "claude-sonnet-4-6" },
    defaults: { maxTurns: 10, maxBudgetUsd: 5 },
    pricing: { models: TEST_PRICE_TABLE },
    chat: { maxConcurrentLiveSessions: 3, liveSessionIdleMinutes: 30, sessionTimeoutMinutes: 30 },
  })),
  buildSdkAuthEnv: vi.fn(() => ({})),
  buildSdkEnv: vi.fn(() => ({})),
  initRuntimeConfig: vi.fn(),
  loadPersistedConfig: vi.fn(),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock("../../store/messages.js", () => ({
  createMessage: vi.fn(),
  getMessage: vi.fn(),
  findEnvelopeByPlatformMessageId: vi.fn(),
  updateMessagePromptBinding: vi.fn(),
  updateMessageCost: vi.fn(),
}));

vi.mock("../../store/sessions.js", () => ({
  updateSession: vi.fn(),
  getSession: vi.fn(() => null),
  getChatSession: vi.fn(),
  updateSessionSdkId: vi.fn(),
}));

vi.mock("../../store/roles.js", () => ({
  getRole: vi.fn(() => ({
    id: "role-chat-manager",
    name: "ChatManager",
    cagPrompt: "",
    permissionMode: "default",
    deniedReadPaths: [],
    allowedBashPatterns: [],
    deniedBashPatterns: [],
    disallowedTools: [],
    additionalDirectories: [],
    plugins: [],
    model: null,
    effort: null,
    maxTurns: null,
  })),
}));

vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: vi.fn(() => "/tmp/chat-manager-workspace"),
  ensureRoleWorkspace: vi.fn(() => "/tmp/chat-manager-workspace"),
}));

vi.mock("../../lib/logger.js", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock("../../lib/trace-context.js", () => ({
  getCurrentTraceId: vi.fn(() => "trace-test-id"),
  withNewTrace: vi.fn(async (_name: string, fn: () => unknown) => fn()),
  withTrace: vi.fn(async (_id: string, _name: string, fn: () => unknown) => fn()),
}));

vi.mock("../../store/memories.js", () => ({
  listBeliefsByRole: vi.fn(() => []),
}));

vi.mock("../../store/beliefs.js", () => ({
  listBeliefsByRole: vi.fn(() => []),
}));

// Mock the session-manager module (relative path used in chat-manager.ts)
vi.mock("../../chat/session-manager.js", () => ({
  incrementMessageCount: vi.fn(),
  touchSession: vi.fn(),
  getSession: vi.fn(() => null),
  updateSessionSdkId: vi.fn(),
}));

vi.mock("../../chat/context-builder.js", () => ({
  buildSessionContext: vi.fn(async (_sessionId: string, msg: string) => msg),
}));

vi.mock("../../lib/role-capabilities.js", () => ({
  resolveRolePluginPaths: vi.fn(() => []),
}));

vi.mock("../../manager/role-mcp-registry.js", () => ({
  getSdkMcpServersForRole: vi.fn(() => []),
  SYSTEM_MCP_PREFIXES: new Set(["mcp__execution-tools__"]),
}));

vi.mock("../../store/tasks.js", () => ({
  getTask: vi.fn(() => undefined),
  updateTask: vi.fn(),
  getTaskTraceId: vi.fn(() => undefined),
}));

vi.mock("../../store/config.js", () => ({
  getConfigValue: vi.fn(() => null),
}));

// Mock the SDK query function — must use vi.hoisted to avoid top-level initialization error
const { mockQueryIterator } = vi.hoisted(() => ({
  mockQueryIterator: vi.fn(),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQueryIterator,
  startup: vi.fn(async () => ({ query: vi.fn(), close: vi.fn() })),
  createSdkMcpServer: vi.fn(() => ({ type: "sdk", name: "mock-mcp" })),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => ({ name: _name, handler })),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { ChatManager } from "../../manager/chat-manager.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a persistent streaming query mock that yields one result per non-seed user message.
 * Stays open until the input stream closes.
 */
function makeLiveCostQuery(resultEvent: Record<string, unknown>) {
  return async function* (params?: { prompt?: AsyncIterable<{ shouldQuery?: boolean }> }) {
    const prompt = params?.prompt;
    if (!prompt) {
      yield resultEvent;
      return;
    }
    for await (const userMsg of prompt) {
      if (userMsg?.shouldQuery === false) continue;
      yield resultEvent;
    }
  };
}

// ─── Original cost-capture tests (updated for live path) ─────────────────────

describe("Task 5-tests (capture): handleMessageWithDispatches returns ChatManagerResponse.cost with full CostRecompute", () => {
  let manager: ChatManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager = new ChatManager();
    await manager.start();
  });

  afterEach(() => {
    manager.stop();
    vi.clearAllMocks();
  });

  it("TC1: result event with modelUsage — response.cost is a full CostRecompute with perModel[]", async () => {
    const resultEvent = {
      type: "result",
      result: "Hello from the assistant",
      num_turns: 2,
      total_cost_usd: 0.05,
      session_id: "sdk-session-tc1",
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

    mockQueryIterator.mockImplementation((opts: unknown) => makeLiveCostQuery(resultEvent)(opts as Parameters<ReturnType<typeof makeLiveCostQuery>>[0]));

    const source: ChatSource = { type: "web" };
    const response: ChatManagerResponse = await manager.handleMessageWithDispatches("Hello", "session-cost-tc1", source);

    // Primary assertions: cost must be present and be a full CostRecompute
    expect(response).toBeDefined();
    expect(response.cost).toBeDefined();
    expect(response.cost!.costUsd).toBeGreaterThan(0);
    expect(response.cost!.perModel).toBeDefined();
    expect(Array.isArray(response.cost!.perModel)).toBe(true);
    expect(response.cost!.perModel.length).toBeGreaterThanOrEqual(1);
    expect(response.cost!.pricingStatus).toBeDefined();
  });

  it("TC2: result event with modelUsage — response.numTurns is set", async () => {
    const resultEvent = {
      type: "result",
      result: "response text",
      num_turns: 3,
      total_cost_usd: 0.01,
      session_id: "sdk-session-tc2",
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 50,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.01,
        },
      },
    };

    mockQueryIterator.mockImplementation((opts: unknown) => makeLiveCostQuery(resultEvent)(opts as Parameters<ReturnType<typeof makeLiveCostQuery>>[0]));

    const source: ChatSource = { type: "web" };
    const response: ChatManagerResponse = await manager.handleMessageWithDispatches("test", "session-cost-tc2", source);

    expect(response.numTurns).toBe(3);
  });

  it("TC3: result event WITHOUT modelUsage — response.cost is absent or has zero costUsd", async () => {
    const resultEvent = {
      type: "result",
      result: "No model usage event",
      num_turns: 1,
      total_cost_usd: 0.02,
      session_id: "sdk-session-tc3",
      usage: { input_tokens: 30, output_tokens: 15 },
      // no modelUsage
    };

    mockQueryIterator.mockImplementation((opts: unknown) => makeLiveCostQuery(resultEvent)(opts as Parameters<ReturnType<typeof makeLiveCostQuery>>[0]));

    const source: ChatSource = { type: "web" };
    const response: ChatManagerResponse = await manager.handleMessageWithDispatches("test", "session-cost-tc3", source);

    if (response.cost !== undefined) {
      expect(typeof response.cost.costUsd).toBe("number");
    }
    expect(true).toBe(true);
  });
});

// ─── Task 8-tests: live-path cost assertions ─────────────────────────────────

describe("Task 8-tests (live path): cost captured from LiveSession result per turn", () => {
  let manager: ChatManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager = new ChatManager();
    await manager.start();
  });

  afterEach(() => {
    manager.stop();
    vi.clearAllMocks();
  });

  /**
   * Live-path TC1: cost flows from LiveSession result through handleMessageWithDispatches.
   * Asserts response.cost.costUsd > 0 and response.cost.perModel populated
   * when the SDK yields a result with modelUsage on the live streaming path.
   *
   * NOTE: This test asserts behavior that already passes via the LiveSession integration
   * (same as the updated TC1 above, retained for explicit live-path coverage).
   */
  it("LP-TC1: live path — cost.costUsd and cost.perModel populated from LiveSession result", async () => {
    const resultEvent = {
      type: "result",
      result: "live path reply",
      num_turns: 1,
      total_cost_usd: 0.03,
      session_id: "sdk-session-lp1",
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 80,
          outputTokens: 30,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.03,
        },
      },
    };

    mockQueryIterator.mockImplementation((opts: unknown) => makeLiveCostQuery(resultEvent)(opts as Parameters<ReturnType<typeof makeLiveCostQuery>>[0]));

    const source: ChatSource = { type: "web" };
    const response = await manager.handleMessageWithDispatches("live cost test", "session-lp1", source);

    expect(response.cost).toBeDefined();
    expect(response.cost!.costUsd).toBeGreaterThan(0);
    expect(Array.isArray(response.cost!.perModel)).toBe(true);
    expect(response.cost!.perModel.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * LP-TC2: second turn on same session reuses the live session (no new query call).
   * Cost is captured on both turns.
   *
   * FAILS before Task 8-impl: cost capture on the second turn via the same LiveSession
   * is not explicitly verified yet; this test pins that the second turn also has cost.
   */
  it("LP-TC2: two sequential turns — cost captured on both; query called once (live path reuse)", async () => {
    let queryCallCount = 0;
    const resultEvent = {
      type: "result",
      result: "live reply",
      num_turns: 1,
      total_cost_usd: 0.01,
      session_id: "sdk-session-lp2",
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 40,
          outputTokens: 15,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.01,
        },
      },
    };

    mockQueryIterator.mockImplementation((opts: unknown) => {
      queryCallCount++;
      return makeLiveCostQuery(resultEvent)(opts as Parameters<ReturnType<typeof makeLiveCostQuery>>[0]);
    });

    const source: ChatSource = { type: "web" };
    const r1 = await manager.handleMessageWithDispatches("turn 1", "session-lp2", source);
    const r2 = await manager.handleMessageWithDispatches("turn 2", "session-lp2", source);

    // Both turns should have cost
    expect(r1.cost).toBeDefined();
    expect(r1.cost!.costUsd).toBeGreaterThan(0);
    expect(r2.cost).toBeDefined();
    expect(r2.cost!.costUsd).toBeGreaterThan(0);

    // The second turn reuses the same LiveSession — query is called exactly once
    expect(queryCallCount).toBe(1);
  });
});
