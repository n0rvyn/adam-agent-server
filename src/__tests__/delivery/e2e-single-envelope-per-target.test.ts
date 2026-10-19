/**
 * E2E test — single-envelope per target dedup.
 *
 * Verifies Phase 4: when reportTo and deliverTo list the same channel,
 * gateway.send is called exactly once for that target (not twice).
 *
 * Uses the full ChatManager integration path via task_complete_event → handleTaskCompletion.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// Hoisted state — gwCalls must be hoisted so mock factories can push to it
const { gwCalls, mockGetTask, mockQueryFn } = vi.hoisted(() => {
  interface GwCall {
    taskId?: string; channelId?: string; chatId?: string;
    messageType: string; content?: string; attachments?: unknown[];
  }
  const gwCalls: GwCall[] = [];
  const mockGetTask = vi.fn<(id: string) => ReturnType<typeof import("../../store/tasks.js").getTask>>();
  const mockQueryFn = vi.fn();
  return { gwCalls, mockGetTask, mockQueryFn };
});

// 活法二: the completion-report turn routes through a per-session LiveSession streaming query.
// Without this mock the real SDK loads and LiveSession.push() hangs (60s timeout). Streaming
// query reads params.prompt and yields one result (with session_id) per non-seed user message.
function makeResultEvent(resultText: string, sdkSessionId = "sdk-e2e") {
  return {
    type: "result", result: resultText, num_turns: 1, total_cost_usd: 0.001,
    session_id: sdkSessionId, modelUsage: {}, usage: { input_tokens: 5, output_tokens: 5 },
  };
}
function makeStreamingQuery(resultText = "LLM E2E summary: Task completed successfully.") {
  return async function* (params?: { prompt?: AsyncIterable<{ shouldQuery?: boolean }> }) {
    const prompt = params?.prompt;
    if (!prompt) { yield makeResultEvent(resultText); return; }
    for await (const userMsg of prompt) {
      if (userMsg?.shouldQuery === false) continue;
      yield makeResultEvent(resultText);
    }
  };
}
/** Poll until predicate holds — flushes the fire-and-forget completion report-turn IIFE. */
async function flushUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < timeoutMs) {
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (opts: Record<string, unknown>) => {
      gwCalls.push({ ...opts } as any);
      return { success: true, logEntryId: `e2e-log-${gwCalls.length}`, messageId: `e2e-msg-${gwCalls.length}` };
    }),
  }),
}));

vi.mock("../../store/channels.js", () => ({
  getChannel: vi.fn((id: string) => {
    if (id === "e2e-ch-1") return { id, platform: "wechat" };
    if (id === "e2e-ch-2") return { id, platform: "telegram" };
    return undefined;
  }),
}));

vi.mock("../../store/messages.js", () => ({ createMessage: vi.fn(), updatePlatformMessageId: vi.fn(), getMessage: vi.fn() }));

vi.mock("../../store/tasks.js", () => ({
  getTask: mockGetTask,
  listTasksByParent: vi.fn().mockReturnValue([]),
  updateTask: vi.fn(),
  getTaskTraceId: vi.fn().mockReturnValue(undefined),
  createDelayedRetry: vi.fn(),
}));

vi.mock("../../store/goals.js", () => ({ getGoal: vi.fn().mockReturnValue(null), updateGoal: vi.fn() }));

vi.mock("../../store/roles.js", () => ({
  getRole: vi.fn(() => ({ id: "role-1", name: "E2ERole" })),
}));

vi.mock("../../chat/artifact-helper.js", () => ({
  createReportArtifact: vi.fn().mockReturnValue(null),
  ARTIFACT_THRESHOLD: 4000,
}));

vi.mock("../../chat/session-manager.js", () => ({
  getSession: vi.fn((id: string) => ({ id, source: { type: "web" }, status: "active", messageCount: 0, createdAt: Date.now(), lastActiveAt: Date.now() })),
  incrementMessageCount: vi.fn(),
  touchSession: vi.fn(),
}));

vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../manager/adam-tools.js", () => ({ createAdamTools: vi.fn(() => ({})) }));
vi.mock("../../manager/hooks.js", () => ({
  buildSessionHooks: vi.fn(() => ({})),
  buildCanUseTool: vi.fn(() => () => true),
}));
vi.mock("../../store/server-state.js", () => ({
  getServerState: vi.fn().mockReturnValue({ userTaskSessionId: undefined }),
}));
vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({
    defaults: { maxBudgetUsd: 5.0 },
    execution: { maxConcurrent: 3, pollIntervalMs: 30_000 },
    pricing: { models: {} },
    chat: { maxConcurrentLiveSessions: 3, liveSessionIdleMinutes: 30, sessionTimeoutMinutes: 30 },
    anthropic: { apiKey: "test-key", baseUrl: "", model: "claude-sonnet-4-6" },
  }),
  buildSdkAuthEnv: vi.fn(() => ({})),
  buildSdkEnv: vi.fn(() => ({})),
}));
vi.mock("../../chat/context-builder.js", () => ({
  buildSessionContext: vi.fn().mockResolvedValue(null),
}));

// --- LiveSession-path supporting mocks ---
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQueryFn,
  startup: vi.fn(async () => ({ query: vi.fn(), close: vi.fn() })),
  createSdkMcpServer: vi.fn(() => ({ type: "sdk", name: "mock-mcp" })),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => ({ name: _name, handler })),
}));
vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: vi.fn(() => "/tmp/chat-manager-workspace"),
  ensureRoleWorkspace: vi.fn(() => "/tmp/chat-manager-workspace"),
}));
vi.mock("../../manager/role-mcp-registry.js", () => ({
  getSdkMcpServersForRole: vi.fn(() => []),
  SYSTEM_MCP_PREFIXES: new Set(["mcp__execution-tools__"]),
}));
vi.mock("../../lib/role-capabilities.js", () => ({
  resolveRolePluginPaths: vi.fn(() => []),
}));
vi.mock("../../store/memories.js", () => ({ listBeliefsByRole: vi.fn(() => []) }));
vi.mock("../../store/beliefs.js", () => ({ listBeliefsByRole: vi.fn(() => []) }));
vi.mock("../../store/sessions.js", () => ({
  updateSession: vi.fn(), getSession: vi.fn(() => null), updateSessionSdkId: vi.fn(),
}));
vi.mock("../../store/config.js", () => ({ getConfigValue: vi.fn(() => null) }));
vi.mock("../../lib/trace-context.js", () => ({
  getCurrentTraceId: vi.fn(() => undefined),
  withNewTrace: vi.fn(async (_name: string, fn: () => unknown) => fn()),
  withTrace: vi.fn(async (_id: string, _name: string, fn: () => unknown) => fn()),
}));

import { ChatManager } from "../../manager/chat-manager.js";

afterAll(() => cleanup());

// Track the per-test ChatManager so afterEach can stop it — real LiveSessions arm idle/
// inactivity setTimeouts (project lesson: inactivity_loop_timer_leak). Cleared per test.
let activeManager: ChatManager | undefined;

beforeEach(() => {
  clearTestDb();
  gwCalls.length = 0;
  mockGetTask.mockReset();
  vi.clearAllMocks();
  mockQueryFn.mockReset().mockImplementation((opts: unknown) =>
    makeStreamingQuery()(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> }),
  );
});

afterEach(() => {
  try { activeManager?.stop(); } catch { /* already stopped */ }
  activeManager = undefined;
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Inject a task origin into the ChatManager's taskOriginMap. */
function setTaskOrigin(cm: ChatManager, taskId: string, opts: {
  source?: { type: string; channelId?: string; chatId?: string };
  chatSessionId?: string;
}) {
  const map = (cm as unknown as { taskOriginMap: Map<string, unknown> }).taskOriginMap;
  map.set(taskId, {
    chatSessionId: opts.chatSessionId ?? `session-${taskId}`,
    source: opts.source ?? { type: "web" },
    createdAt: Date.now(),
  });
}

function makeTaskId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Single-envelope per target (E2E)", () => {

  it("ux-012-single-envelope-per-target-dedup: reportTo + deliverTo same channel → gateway.send called exactly once", async () => {
    const taskId = makeTaskId("e2e-dedup");
    const cm = new ChatManager();
    activeManager = cm;

    mockGetTask.mockReturnValue({
      id: taskId,
      status: "completed",
      roleId: "role-1",
      prompt: "E2E dedup test",
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
      reportTo: [{ type: "channel", channelId: "e2e-ch-1", chatId: "e2e-chat-1" }],
      deliverTo: [{ type: "channel", channelId: "e2e-ch-1", chatId: "e2e-chat-1" }],
      createdAt: Date.now(),
    });

    setTaskOrigin(cm, taskId, { chatSessionId: "e2e-session", source: { type: "web" } });

    await (cm as unknown as { handleTaskCompletion: (id: string, r?: string, e?: string) => Promise<void> }).handleTaskCompletion(taskId, "E2E dedup test result");
    await flushUntil(() => gwCalls.length > 0);

    // Deduplication: both reportTo and deliverTo → same (channelId, chatId) → 1 call
    const e2eCh1Calls = gwCalls.filter((c) => c.channelId === "e2e-ch-1");
    expect(e2eCh1Calls).toHaveLength(1);
    expect(e2eCh1Calls[0].messageType).toBe("result_delivery");
    expect(e2eCh1Calls[0].taskId).toBe(taskId);
  });

  it("distinct channels in reportTo and deliverTo → gateway.send called once per distinct channel", async () => {
    const taskId = makeTaskId("e2e-distinct");
    const cm = new ChatManager();
    activeManager = cm;

    mockGetTask.mockReturnValue({
      id: taskId,
      status: "completed",
      roleId: "role-1",
      prompt: "E2E distinct channels test",
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
      reportTo: [{ type: "channel", channelId: "e2e-ch-1", chatId: "e2e-chat-1" }],
      deliverTo: [{ type: "channel", channelId: "e2e-ch-2", chatId: "e2e-chat-2" }],
      createdAt: Date.now(),
    });

    setTaskOrigin(cm, taskId, { chatSessionId: "e2e-session-2", source: { type: "web" } });

    await (cm as unknown as { handleTaskCompletion: (id: string, r?: string, e?: string) => Promise<void> }).handleTaskCompletion(taskId, "E2E distinct channels test");
    await flushUntil(() => gwCalls.filter((c) => c.channelId === "e2e-ch-1").length > 0 && gwCalls.filter((c) => c.channelId === "e2e-ch-2").length > 0);

    // Each distinct channel gets exactly one call
    const ch1Calls = gwCalls.filter((c) => c.channelId === "e2e-ch-1");
    const ch2Calls = gwCalls.filter((c) => c.channelId === "e2e-ch-2");
    expect(ch1Calls).toHaveLength(1);
    expect(ch2Calls).toHaveLength(1);
    expect(ch1Calls[0].messageType).toBe("result_delivery");
    expect(ch2Calls[0].messageType).toBe("result_delivery");
  });
});
