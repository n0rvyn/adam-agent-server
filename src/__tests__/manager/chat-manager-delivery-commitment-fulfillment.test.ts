import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

const busHandlers = new Map<string, Array<(event: any) => void>>();
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: vi.fn((event: { type: string }) => {
      for (const handler of busHandlers.get(event.type) ?? []) handler(event);
    }),
    on: vi.fn((type: string, handler: (event: any) => void) => {
      if (!busHandlers.has(type)) busHandlers.set(type, []);
      busHandlers.get(type)!.push(handler);
    }),
  },
}));

const { mockGatewaySend } = vi.hoisted(() => ({
  mockGatewaySend: vi.fn(),
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ send: mockGatewaySend , redeliverExecutionTo: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("../../server/routes/channels.js", () => ({
  getChannelManager: () => ({
    getCapabilities: () => ({
      canEdit: false,
      canQuote: true,
      canParseQuote: true,
      canInlineButtons: false,
      maxTextLength: 4000,
      supportsAttachments: true,
      maxAttachmentsPerMessage: 1,
    }),
  }),
}));

// 活法二: completion-report turn routes through a per-session LiveSession streaming query.
// Streaming mock reads params.prompt and yields one result (with session_id) per non-seed
// user message so the report turn resolves and proceeds to sendEnvelope.
const { mockQueryFn } = vi.hoisted(() => ({ mockQueryFn: vi.fn() }));
function makeResultEvent(resultText: string, sdkSessionId = "sdk-commitment") {
  return {
    type: "result", result: resultText, num_turns: 1, total_cost_usd: 0.001,
    session_id: sdkSessionId, modelUsage: {}, usage: { input_tokens: 5, output_tokens: 5 },
  };
}
function makeStreamingQuery(resultText = "任务完成，附件已发送。") {
  return async function* (params?: { prompt?: AsyncIterable<{ shouldQuery?: boolean }> }) {
    const prompt = params?.prompt;
    if (!prompt) { yield makeResultEvent(resultText); return; }
    for await (const userMsg of prompt) {
      if (userMsg?.shouldQuery === false) continue;
      yield makeResultEvent(resultText);
    }
  };
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQueryFn,
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
  getSession: vi.fn((id: string) => ({ id, source: { type: "channel", channelId: "wechat-1", chatId: "chat-1" }, status: "active", messageCount: 0, createdAt: Date.now(), lastActiveAt: Date.now() })),
  incrementMessageCount: vi.fn(),
  touchSession: vi.fn(),
  updateSessionSdkId: vi.fn(),
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
vi.mock("../../lib/trace-context.js", () => ({
  getCurrentTraceId: vi.fn(() => undefined),
  withNewTrace: vi.fn(async (_name: string, fn: () => unknown) => fn()),
  withTrace: vi.fn(async (_id: string, _name: string, fn: () => unknown) => fn()),
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

import { ChatManager } from "../../manager/chat-manager.js";
import { createTask } from "../../store/tasks.js";
import {
  createDeliveryCommitment,
  getDeliveryCommitment,
} from "../../store/assistant-delivery-commitments.js";

afterAll(() => {
  cleanup();
});

beforeEach(() => {
  clearTestDb();
  busHandlers.clear();
  mockQueryFn.mockReset().mockImplementation((opts: unknown) =>
    makeStreamingQuery()(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> }),
  );
  mockGatewaySend.mockReset().mockImplementation(async (_opts: unknown) => ({
    success: true,
    logEntryId: `log-${mockGatewaySend.mock.calls.length}`,
  }));
});

function createCompletedTask(id: string, result: string): void {
  createTask({
    id,
    status: "completed",
    prompt: "generate images",
    result,
    // 活法二: sourceSessionId lets handleTaskCompletion resolve an origin so the LLM
    // completion-report turn runs through the LiveSession (session-manager.getSession mocked).
    sourceSessionId: "session-1",
    deliverTo: [{ type: "channel", channelId: "wechat-1", chatId: "chat-1" }],
    config: { timeout: 60, approvalRequired: [], approvalTimeout: 60 },
    createdAt: Date.now(),
  });
}

function createImages(taskId: string): string[] {
  const root = join(process.env.ADAM_TEST_DIR!, "artifacts", taskId);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return [1, 2, 3].map((index) => {
    const file = join(root, `${index}.png`);
    writeFileSync(file, `png-${index}`);
    return file;
  });
}

async function triggerCompletion(cm: ChatManager, taskId: string): Promise<void> {
  const handler = busHandlers.get("task_complete_event")?.[0];
  expect(handler).toBeDefined();
  const row = getTestDb().prepare("SELECT result FROM tasks WHERE id = ?").get(taskId) as { result?: string } | undefined;
  handler!({ type: "task_complete_event", taskId, result: row?.result });
  await vi.waitFor(() => {
    expect(mockGatewaySend).toHaveBeenCalled();
  });
}

describe("ChatManager delivery commitment fulfillment", () => {
  it("sends committed PNG artifacts and marks the commitment fulfilled", async () => {
    const cm = new ChatManager();
    await cm.start();
    const taskId = "task-committed-images";
    const files = createImages(taskId);
    createCompletedTask(taskId, files.join("\n"));
    createDeliveryCommitment({
      traceId: "trace-images",
      sessionId: "session-1",
      taskId,
      target: { type: "channel", channelId: "wechat-1", chatId: "chat-1" },
      artifactExpectation: { kind: "image", count: 3 },
    });

    await triggerCompletion(cm, taskId);

    await vi.waitFor(() => {
      const row = getTestDb().prepare("SELECT id FROM assistant_delivery_commitments WHERE task_id = ?").get(taskId) as { id: string };
      const commitment = getDeliveryCommitment(row.id);
      expect(commitment?.status).toBe("fulfilled");
      expect(commitment?.evidence).toHaveLength(3);
    });
    const attachmentCalls = mockGatewaySend.mock.calls.filter((call) => call[0].dedupDiscriminator);
    expect(attachmentCalls).toHaveLength(3);
    expect(attachmentCalls.map((call) => call[0].attachments[0].filename)).toEqual(["1.png", "2.png", "3.png"]);
    cm.stop();
  });

  it("does not auto-send task result PNG paths without a pending commitment", async () => {
    const cm = new ChatManager();
    await cm.start();
    const taskId = "task-no-promise";
    const files = createImages(taskId);
    createCompletedTask(taskId, files.join("\n"));

    await triggerCompletion(cm, taskId);

    const attachmentCalls = mockGatewaySend.mock.calls.filter((call) => call[0].dedupDiscriminator);
    expect(attachmentCalls).toHaveLength(0);
    cm.stop();
  });

  it("marks the commitment failed when artifact resolution finds no sendable files", async () => {
    const cm = new ChatManager();
    await cm.start();
    const taskId = "task-missing-artifacts";
    createCompletedTask(taskId, join(process.env.ADAM_TEST_DIR!, "artifacts", taskId, "missing.png"));
    const commitment = createDeliveryCommitment({
      traceId: "trace-missing",
      sessionId: "session-1",
      taskId,
      target: { type: "channel", channelId: "wechat-1", chatId: "chat-1" },
      artifactExpectation: { kind: "image", count: 1 },
    });

    const handler = busHandlers.get("task_complete_event")?.[0];
    expect(handler).toBeDefined();
    handler!({ type: "task_complete_event", taskId, result: "missing" });
    await vi.waitFor(() => {
      expect(getDeliveryCommitment(commitment.id)?.status).toBe("failed");
    });
    expect(getDeliveryCommitment(commitment.id)?.failureReason).toBe("no_deliverable_artifacts");
    cm.stop();
  });
});
