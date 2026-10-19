import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

const busHandlers = new Map<string, Array<(event: Record<string, unknown>) => void | Promise<void>>>();
const mockGatewaySend = vi.fn().mockResolvedValue({ success: true, logEntryId: "gw-log" });

// 活法二: the completion-report turn routes through a per-session LiveSession streaming query.
// Streaming mock reads params.prompt and yields one result (with session_id) per non-seed user
// message, so handleTaskCompletion's report turn resolves and proceeds to sendEnvelope.
function makeResultEvent(resultText: string, sdkSessionId = "sdk-tmpl-step") {
  return {
    type: "result", result: resultText, num_turns: 1, total_cost_usd: 0.001,
    session_id: sdkSessionId, modelUsage: {}, usage: { input_tokens: 5, output_tokens: 5 },
  };
}
const mockQuery = vi.fn((params?: { prompt?: AsyncIterable<{ shouldQuery?: boolean }> }) => {
  return (async function* () {
    const prompt = params?.prompt;
    if (!prompt) { yield makeResultEvent("manager completion summary"); return; }
    for await (const userMsg of prompt) {
      if (userMsg?.shouldQuery === false) continue;
      yield makeResultEvent("manager completion summary");
    }
  })();
});

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: vi.fn((event: Record<string, unknown>) => {
      const handlers = busHandlers.get(event.type as string) ?? [];
      for (const handler of handlers) void handler(event);
    }),
    on: vi.fn((event: string, handler: (event: Record<string, unknown>) => void | Promise<void>) => {
      if (!busHandlers.has(event)) busHandlers.set(event, []);
      busHandlers.get(event)!.push(handler);
    }),
  },
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => mockQuery(args as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> }),
  startup: vi.fn(async () => ({ query: vi.fn(), close: vi.fn() })),
  createSdkMcpServer: vi.fn(() => ({ type: "sdk", name: "mock-mcp" })),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: unknown) => ({ name: _name, handler })),
}));

vi.mock("../../manager/adam-tools.js", () => ({
  createAdamTools: vi.fn(() => ({})),
}));

// --- LiveSession-path supporting mocks ---
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
vi.mock("../../chat/session-manager.js", () => ({
  getSession: vi.fn((id: string) => ({ id, source: { type: "web" }, status: "active", messageCount: 0, createdAt: Date.now(), lastActiveAt: Date.now() })),
  incrementMessageCount: vi.fn(),
  touchSession: vi.fn(),
  updateSessionSdkId: vi.fn(),
}));
vi.mock("../../chat/context-builder.js", () => ({
  buildSessionContext: vi.fn(async (_sessionId: string, msg: string) => msg),
}));
vi.mock("../../lib/trace-context.js", () => ({
  getCurrentTraceId: vi.fn(() => undefined),
  withNewTrace: vi.fn(async (_name: string, fn: () => unknown) => fn()),
  withTrace: vi.fn(async (_id: string, _name: string, fn: () => unknown) => fn()),
}));
vi.mock("../../store/messages.js", () => ({
  createMessage: vi.fn(), updatePlatformMessageId: vi.fn(), getMessage: vi.fn(),
}));
vi.mock("../../store/roles.js", () => ({
  getRole: vi.fn(() => ({ id: "role-1", name: "TestRole" })),
}));
vi.mock("../../chat/artifact-helper.js", () => ({
  createReportArtifact: vi.fn(() => null), ARTIFACT_THRESHOLD: 4000,
}));
vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

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
    anthropic: { apiKey: "test-key", baseUrl: "", model: "claude-sonnet-4-6" },
    execution: { maxConcurrent: 3, pollIntervalMs: 30_000 },
    pricing: { models: {} },
    chat: { maxConcurrentLiveSessions: 3, liveSessionIdleMinutes: 30, sessionTimeoutMinutes: 30 },
  }),
  buildSdkEnv: vi.fn(() => ({})),
  buildSdkAuthEnv: vi.fn(() => ({})),
}));

vi.mock("../../store/goals.js", () => ({
  getGoal: vi.fn().mockReturnValue(undefined),
  listGoals: vi.fn().mockReturnValue([]),
  updateGoal: vi.fn(),
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined),
    send: mockGatewaySend,
  }),
}));

import { ChatManager } from "../../manager/chat-manager.js";
import { createTask } from "../../store/tasks.js";
import { serverBus } from "../../server/events/server-bus.js";

afterAll(() => cleanup());

function seedCompletedTask(id: string, overrides: Record<string, unknown> = {}): void {
  createTask({
    id,
    status: "completed",
    prompt: "task prompt",
    result: "task result",
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
    createdAt: Date.now(),
    completedAt: Date.now(),
    ...overrides,
  });
}

async function emitCompletion(taskId: string): Promise<void> {
  serverBus.emit({ type: "task_complete_event", taskId, result: "task result" });
}

/** Poll until predicate holds — flushes the fire-and-forget completion report-turn IIFE. */
async function flushUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < timeoutMs) {
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

describe("ChatManager TemplateExecution step delivery isolation", () => {
  beforeEach(() => {
    clearTestDb();
    busHandlers.clear();
    mockGatewaySend.mockClear();
    mockQuery.mockClear();
  });

  it("does not create direct result delivery for TemplateExecution child tasks", async () => {
    const manager = new ChatManager();
    await manager.start();
    seedCompletedTask("task-template-step", {
      parentId: "exec-1",
      templateId: "tmpl-1",
      stepId: "polish",
      sourceSessionId: "session-x",
      deliverTo: [{ type: "channel", channelId: "ch-1", chatId: "chat-1" }],
    });

    await emitCompletion("task-template-step");
    // Give any (incorrect) async report turn a chance to fire before asserting absence.
    await new Promise((r) => setTimeout(r, 50));
    manager.stop();

    // TemplateExecution step tasks return early — no LLM report turn, no gateway delivery.
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockGatewaySend).not.toHaveBeenCalled();
  });

  it("still delivers normal ad-hoc task results", async () => {
    const manager = new ChatManager();
    await manager.start();
    // 活法二: the LLM completion-report turn runs through the origin session's LiveSession.
    // An ad-hoc chat-originated task carries sourceSessionId (session-manager.getSession is
    // mocked to resolve it), so origin resolves and the report turn fires.
    seedCompletedTask("task-normal", {
      sourceSessionId: "session-normal",
      deliverTo: [{ type: "channel", channelId: "ch-1", chatId: "chat-1" }],
    });

    await emitCompletion("task-normal");
    await flushUntil(() => mockGatewaySend.mock.calls.some(
      (c) => (c[0] as { channelId?: string })?.channelId === "ch-1",
    ));
    manager.stop();

    expect(mockQuery).toHaveBeenCalled();
    expect(mockGatewaySend).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-normal",
        channelId: "ch-1",
        chatId: "chat-1",
        messageType: "result_delivery",
      }),
    );
  });
});
