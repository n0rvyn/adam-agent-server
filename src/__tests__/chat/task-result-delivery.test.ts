import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";

// --- Hoisted variables (accessible inside vi.mock factories) ---

const { serverBusMock, gatewayMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  const bus = new EventEmitter();
  const mock = {
    on: bus.on.bind(bus),
    removeAllListeners: bus.removeAllListeners.bind(bus),
    emit(event: { type: string;[k: string]: unknown }) {
      bus.emit(event.type, event);
    },
  };
  const sendFn = vi.fn().mockResolvedValue(undefined);
  const gateway = { send: sendFn, redeliverExecutionTo: vi.fn().mockResolvedValue(undefined) };
  return { serverBusMock: mock, gatewayMock: { gateway, sendFn } };
});

// --- Mocks (must be hoisted before imports) ---

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: serverBusMock,
}));

vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({
    execution: { maxConcurrent: 3 },
    pricing: { models: {} },
    chat: { maxConcurrentLiveSessions: 3, liveSessionIdleMinutes: 30, sessionTimeoutMinutes: 30 },
    anthropic: { apiKey: "test-key", baseUrl: "", model: "claude-sonnet-4-6" },
    defaults: {
      timeout: 600,
      maxTurns: 100,
      maxBudgetUsd: 5.0,
      effort: "high",
      model: "",
      settingSources: ["project"],
      allowedTools: [],
      disallowedTools: [],
      approvalRequired: [],
      approvalTimeout: 300,
      env: {},
    },
  }),
  buildSdkAuthEnv: vi.fn(() => ({})),
  buildSdkEnv: vi.fn(() => ({})),
}));

// --- LiveSession-path supporting mocks (per-session adam-tools/hooks construction) ---
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
vi.mock("../../store/config.js", () => ({ getConfigValue: vi.fn(() => null) }));
vi.mock("../../lib/trace-context.js", () => ({
  getCurrentTraceId: vi.fn(() => undefined),
  withNewTrace: vi.fn(async (_name: string, fn: () => unknown) => fn()),
  withTrace: vi.fn(async (_id: string, _name: string, fn: () => unknown) => fn()),
}));

vi.mock("../../config/index.js", () => ({
  getChatConfig: () => ({
    sessionTimeoutMinutes: 30,
    maxSessionTurns: 20,
    autoTitle: true,
    archiveExtractMemory: false,
  }),
  getDefaults: () => ({
    timeout: 600,
    maxTurns: 100,
    maxBudgetUsd: 5.0,
    effort: "high",
    model: "",
    settingSources: ["project"],
    allowedTools: [],
    disallowedTools: [],
    approvalRequired: [],
    approvalTimeout: 300,
    env: {},
  }),
  DEFAULT_CONFIG: { chat: { sessionTimeoutMinutes: 30, maxSessionTurns: 20, autoTitle: true, archiveExtractMemory: false } },
}));

vi.mock("../../store/server-state.js", () => ({
  getServerState: vi.fn(() => ({ sdkSessionId: undefined, workspacePath: undefined })),
}));

vi.mock("../../agent/persona.js", () => ({
  buildRoleSystemPrompt: vi.fn(() => "mock system prompt"),
}));

// 活法二 rework: completion/status report turns route through a per-session LiveSession
// streaming query. The SDK `query` is a STREAMING async generator that reads params.prompt
// and yields ONE result (with session_id — LiveSession.finishTurn requires it) per non-seed
// user message. Copied shape from chat-manager-live-routing.test.ts.
const { mockQueryFn } = vi.hoisted(() => ({ mockQueryFn: vi.fn() }));

function makeResultEvent(resultText: string, sdkSessionId = "sdk-task-result") {
  return {
    type: "result",
    result: resultText,
    num_turns: 1,
    total_cost_usd: 0.001,
    session_id: sdkSessionId,
    modelUsage: {},
    usage: { input_tokens: 5, output_tokens: 5 },
  };
}

function makeStreamingQuery(resultText = "mock response") {
  return async function* (params?: { prompt?: AsyncIterable<{ shouldQuery?: boolean }> }) {
    const prompt = params?.prompt;
    if (!prompt) { yield makeResultEvent(resultText); return; }
    for await (const userMsg of prompt) {
      if (userMsg?.shouldQuery === false) continue;
      yield makeResultEvent(resultText);
    }
  };
}

/** Hanging query: never yields a result — used to simulate "LLM never responds". */
function makeHangingQuery() {
  return async function* (_params?: unknown) {
    await new Promise<void>(() => {}); // never resolves
    yield makeResultEvent("never");
  };
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQueryFn,
  startup: vi.fn(async () => ({ query: vi.fn(), close: vi.fn() })),
  tool: vi.fn((name: string, _desc: string, handler: unknown) => ({ name, handler })),
  createSdkMcpServer: vi.fn(() => ({ type: "sdk", name: "mock-mcp" })),
}));

vi.mock("../../agent/session-memory-extractor.js", () => ({
  processSessionArchive: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../manager/adam-tools.js", () => ({
  createAdamTools: vi.fn(() => ({ name: "adam-tools-mock" })),
}));

vi.mock("../../manager/hooks.js", () => ({
  buildSessionHooks: vi.fn(() => ({})),
  buildCanUseTool: vi.fn(() => () => undefined),
}));

vi.mock("../../manager/chat-system-prompt.js", () => ({
  buildChatSystemPrompt: vi.fn(() => "mock chat system prompt"),
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: vi.fn(() => gatewayMock.gateway),
}));

vi.mock("../../chat/artifact-helper.js", () => ({
  createReportArtifact: vi.fn(() => null),
  ARTIFACT_THRESHOLD: 4000,
}));

vi.mock("../../chat/attachment-converter.js", () => ({
  chatAttachmentToOutbound: vi.fn(() => null),
}));

import { getOutboundGateway } from "../../delivery/outbound-gateway.js";

vi.mock("../../store/goals.js", () => ({
  listGoals: vi.fn(() => []),
}));

vi.mock("../../agent/memory-service.js", () => ({
  queryMemory: vi.fn().mockResolvedValue([]),
  getRelevantMemoryContext: vi.fn().mockResolvedValue(""),
}));

// --- DB ref ---

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

// --- Imports (after mocks) ---

import { createTask, getTask } from "../../store/tasks.js";
import { getMessagesBySession } from "../../store/messages.js";
import { ChatManager } from "../../manager/chat-manager.js";
import * as sessionManager from "../../chat/session-manager.js";
import type { ChatSource, Task } from "../../shared/types.js";

// --- Helpers ---

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    status: "pending",
    prompt: "test task prompt",
    config: {
      timeout: 600,
      approvalRequired: [],
      approvalTimeout: 300,
    },
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("task result delivery", () => {
  let chatManager: ChatManager;

  beforeAll(() => {
    const { db } = setupTestDb();
    dbRef = db;
  });

  afterAll(() => {
    dbRef.close();
  });

  // Stop the manager after each test so any real LiveSession's idle/inactivity setTimeouts
  // are cleared (project lesson: inactivity_loop_timer_leak — leaked handles drag the suite).
  afterEach(() => {
    try { chatManager?.stop(); } catch { /* already stopped */ }
  });

  beforeEach(async () => {
    clearTestDb();
    sessionManager._resetForTest();
    serverBusMock.removeAllListeners();
    mockQueryFn.mockReset().mockImplementation((opts: unknown) =>
      makeStreamingQuery()(opts as { prompt?: AsyncIterable<{ shouldQuery?: boolean }> }),
    );
    chatManager = new ChatManager();
    await chatManager.start();
  });

  // 活法二 P-1: primary origin attribution moved to the per-session onTaskDispatched callback
  // (race-free, bound to the dispatching session's constant id) — exercised via the dispatch path
  // in chat-session-context-binding.test.ts. A bare task_created no longer attributes (the old
  // racy map-scan was removed), so the only listener behavior left here is SUBTASK inheritance
  // (covered below) + the no-context negative case.

  // --- Test 1: sourceSessionId persisted on task ---

  describe("sourceSessionId persisted on task", () => {
    it("does not set sourceSessionId when no active chat context", () => {
      const task = makeTask();
      createTask(task);

      // Emit without setting active context
      serverBusMock.emit({ type: "task_created", taskId: task.id });

      const updated = getTask(task.id);
      expect(updated).toBeDefined();
      expect(updated!.sourceSessionId).toBeUndefined();
    });
  });

  // --- Test 2: Task completion creates chat message ---

  describe("task completion creates chat message", () => {
    it("creates assistant message in source session on success", async () => {
      const source: ChatSource = { type: "web" };
      const session = sessionManager.createSession(source);

      // Create task with sourceSessionId already set
      const task = makeTask({ sourceSessionId: session.id });
      createTask(task);

      // Prime the in-memory origin map via task_created event
      const cm = chatManager as unknown as Record<string, unknown>;
      cm["activeChatSessionId"] = session.id;
      cm["activeChatSource"] = source;
      serverBusMock.emit({ type: "task_created", taskId: task.id });

      // Clear active context (as handleMessage would after processing)
      cm["activeChatSessionId"] = undefined;
      cm["activeChatSource"] = undefined;

      // Emit task_complete_event
      serverBusMock.emit({
        type: "task_complete_event",
        taskId: task.id,
        result: "Task completed successfully",
      });

      // Phase 4: LLM completion path is async — message appears after SDK resolve callback fires.
      // The SDK mock returns immediately so the callback resolves quickly.
      await vi.waitFor(() => {
        const messages = getMessagesBySession(session.id);
        const assistantMsg = messages.find((m) => m.role === "assistant");
        expect(assistantMsg).toBeDefined();
        expect(assistantMsg!.content).toBeTruthy();
        expect(assistantMsg!.taskId).toBe(task.id);
      }, { timeout: 3000 });
    });

    it("creates assistant message with content on failure", async () => {
      const source: ChatSource = { type: "web" };
      const session = sessionManager.createSession(source);

      const task = makeTask({ sourceSessionId: session.id });
      createTask(task);

      const cm = chatManager as unknown as Record<string, unknown>;
      cm["activeChatSessionId"] = session.id;
      cm["activeChatSource"] = source;
      serverBusMock.emit({ type: "task_created", taskId: task.id });
      cm["activeChatSessionId"] = undefined;
      cm["activeChatSource"] = undefined;

      serverBusMock.emit({
        type: "task_complete_event",
        taskId: task.id,
        error: "Out of memory",
      });

      // Phase 4: LLM completion path is async — message appears after SDK resolve callback fires.
      await vi.waitFor(() => {
        const messages = getMessagesBySession(session.id);
        const assistantMsg = messages.find((m) => m.role === "assistant");
        expect(assistantMsg).toBeDefined();
        expect(assistantMsg!.content).toBeTruthy();
      }, { timeout: 3000 });
    });
  });

  // --- Test 3: Subtask inherits parent's sourceSessionId ---

  describe("subtask inherits parent sourceSessionId", () => {
    it("inherits sourceSessionId from parent task via in-memory map", () => {
      const source: ChatSource = { type: "web" };
      const session = sessionManager.createSession(source);

      // Create parent task with sourceSessionId
      const parentTask = makeTask({ sourceSessionId: session.id });
      createTask(parentTask);

      // Register parent in the origin map
      const cm = chatManager as unknown as Record<string, unknown>;
      cm["activeChatSessionId"] = session.id;
      cm["activeChatSource"] = source;
      serverBusMock.emit({ type: "task_created", taskId: parentTask.id });

      // Clear active context
      cm["activeChatSessionId"] = undefined;
      cm["activeChatSource"] = undefined;

      // Create subtask with parentId pointing to parent
      const subtask = makeTask({ parentId: parentTask.id });
      createTask(subtask);

      // Emit task_created for subtask (no active chat context, but should inherit from parent)
      serverBusMock.emit({ type: "task_created", taskId: subtask.id });

      const updatedSubtask = getTask(subtask.id);
      expect(updatedSubtask).toBeDefined();
      expect(updatedSubtask!.sourceSessionId).toBe(session.id);
    });

    it("inherits sourceSessionId from parent task via DB fallback", () => {
      const source: ChatSource = { type: "web" };
      const session = sessionManager.createSession(source);

      // Create parent task with sourceSessionId in DB (but NOT in the in-memory map)
      const parentTask = makeTask({ sourceSessionId: session.id });
      createTask(parentTask);

      // Create subtask referencing parent
      const subtask = makeTask({ parentId: parentTask.id });
      createTask(subtask);

      // Emit task_created for subtask; the listener checks parentId and DB
      serverBusMock.emit({ type: "task_created", taskId: subtask.id });

      const updatedSubtask = getTask(subtask.id);
      expect(updatedSubtask).toBeDefined();
      expect(updatedSubtask!.sourceSessionId).toBe(session.id);
    });
  });

  // --- Test 4: Channel delivery ---

  describe("channel delivery", () => {
    it("calls channel delivery for channel-sourced tasks", async () => {
      const channelSource: ChatSource = { type: "channel", channelId: "ch1", chatId: "chat1" };
      const session = sessionManager.createSession(channelSource);

      const task = makeTask({ sourceSessionId: session.id });
      createTask(task);

      // Register in origin map
      const cm = chatManager as unknown as Record<string, unknown>;
      cm["activeChatSessionId"] = session.id;
      cm["activeChatSource"] = channelSource;
      serverBusMock.emit({ type: "task_created", taskId: task.id });
      cm["activeChatSessionId"] = undefined;
      cm["activeChatSource"] = undefined;

      // Intercept gateway.send to capture calls
      const gatewaySendSpy = vi.fn().mockResolvedValue(undefined);
      gatewayMock.gateway.send = gatewaySendSpy;

      // Emit task completion
      serverBusMock.emit({
        type: "task_complete_event",
        taskId: task.id,
        result: "Channel task done",
      });

      // Phase 4: terminal completion sends a single result_delivery envelope per target.
      // Intermediate status_report is NOT sent for successful terminal completion.
      await vi.waitFor(() => {
        const deliveryCalls = gatewaySendSpy.mock.calls.filter(
          (call) => call[0]?.channelId === "ch1" && call[0]?.messageType === "result_delivery",
        );
        expect(deliveryCalls.length).toBeGreaterThan(0);
        expect(deliveryCalls[0][0].chatId).toBe("chat1");
      }, { timeout: 3000 });
    });

    it("does not call channel delivery for web-sourced tasks", async () => {
      const source: ChatSource = { type: "web" };
      const session = sessionManager.createSession(source);

      const task = makeTask({ sourceSessionId: session.id });
      createTask(task);

      const cm = chatManager as unknown as Record<string, unknown>;
      cm["activeChatSessionId"] = session.id;
      cm["activeChatSource"] = source;
      serverBusMock.emit({ type: "task_created", taskId: task.id });
      cm["activeChatSessionId"] = undefined;
      cm["activeChatSource"] = undefined;

      serverBusMock.emit({
        type: "task_complete_event",
        taskId: task.id,
        result: "Web task done",
      });

      // Phase 4: web-sourced tasks only write to session (not gateway).
      // The message appears asynchronously after SDK resolve callback.
      await vi.waitFor(() => {
        const messages = getMessagesBySession(session.id);
        expect(messages.find((m) => m.role === "assistant")).toBeDefined();
      }, { timeout: 3000 });
    });
  });

  // --- Test 5: Post-restart DB fallback ---

  describe("post-restart DB fallback", () => {
    it("resolves origin from DB when in-memory map is empty", async () => {
      const source: ChatSource = { type: "web" };
      const session = sessionManager.createSession(source);

      // Create task with sourceSessionId in DB (simulating a pre-restart task)
      const task = makeTask({ sourceSessionId: session.id });
      createTask(task);

      // Do NOT populate the in-memory origin map. This simulates a ChatManager restart.
      // Emit task completion
      serverBusMock.emit({
        type: "task_complete_event",
        taskId: task.id,
        result: "Recovered result",
      });

      // Phase 4: LLM completion is async; message appears after SDK resolve callback.
      await vi.waitFor(() => {
        const messages = getMessagesBySession(session.id);
        const assistantMsg = messages.find((m) => m.role === "assistant");
        expect(assistantMsg).toBeDefined();
        expect(assistantMsg!.content).toBeTruthy(); // LLM-generated, content varies
      }, { timeout: 3000 });
    });
  });

  // --- Test 6: task_status_change running triggers report ---

  describe("task_status_change triggers report", () => {
    it("task_status_change running triggers report to origin channel", async () => {
      const channelSource: ChatSource = { type: "channel", channelId: "ch1", chatId: "chat1" };
      const session = sessionManager.createSession(channelSource);

      const task = makeTask({ sourceSessionId: session.id });
      createTask(task);

      // 活法二: task_status_change "running" only fires a report when taskOriginMap has the
      // task. Register the origin directly (the listener path that would set it via
      // task_created+active-session is exercised by the sourceSessionId test above).
      const originMap = (chatManager as unknown as { taskOriginMap: Map<string, unknown> }).taskOriginMap;
      originMap.set(task.id, { chatSessionId: session.id, source: channelSource, createdAt: Date.now() });

      // Emit task_status_change with running
      serverBusMock.emit({
        type: "task_status_change",
        taskId: task.id,
        newStatus: "running",
      });

      // The streaming SDK mock resolves the report turn through the origin's LiveSession,
      // which triggers deliverReport → writes an assistant status_report to the session.
      await vi.waitFor(() => {
        const messages = getMessagesBySession(session.id);
        const assistantMsg = messages.find((m) => m.role === "assistant");
        expect(assistantMsg).toBeDefined();
        expect(assistantMsg!.content).toBeTruthy();
        expect(assistantMsg!.taskId).toBe(task.id);
      }, { timeout: 2000 });
    });
  });

  // --- Test 7: deliverTo origin channel fallback (Phase 4: unified sendEnvelope) ---

  describe("deliverTo origin channel fallback", () => {
    it("deliverTo fallback sends result_delivery to origin channel via gateway (Phase 4: no truncation, unified envelope)", async () => {
      // Phase 4: the old truncated "deliver" separate fallback is removed.
      // Now the unified sendEnvelope sends result_delivery to all targets (including origin).
      // Large results are artifact-ized automatically; the content passed is the LLM summary (short).
      const channelSource: ChatSource = { type: "channel", channelId: "ch1", chatId: "chat1" };
      const session = sessionManager.createSession(channelSource);

      const task = makeTask({ sourceSessionId: session.id });
      createTask(task);

      // Register in origin map
      const cm = chatManager as unknown as Record<string, unknown>;
      cm["activeChatSessionId"] = session.id;
      cm["activeChatSource"] = channelSource;
      serverBusMock.emit({ type: "task_created", taskId: task.id });
      cm["activeChatSessionId"] = undefined;
      cm["activeChatSource"] = undefined;

      // Intercept gateway.send to verify result_delivery is sent to origin channel
      const gatewaySendSpy = vi.fn().mockResolvedValue({ success: true });
      gatewayMock.gateway.send = gatewaySendSpy;

      // Emit task completion with no explicit deliverTo and a large result
      const longResult = "x".repeat(5000);
      serverBusMock.emit({
        type: "task_complete_event",
        taskId: task.id,
        result: longResult,
      });

      // Phase 4: result_delivery sent to origin channel via sendEnvelope -> gateway.send.
      // In the test, the SDK resolve callback is async so we use vi.waitFor.
      await vi.waitFor(() => {
        const deliverCalls = gatewaySendSpy.mock.calls.filter(
          (call) => call[0]?.channelId === "ch1" && call[0]?.messageType === "result_delivery",
        );
        expect(deliverCalls.length).toBeGreaterThan(0);
        // Phase 4: content is the LLM summary (short), not the raw result (long).
        // The raw result is artifact-ized as an attachment (not embedded in content).
        const content = deliverCalls[0][0].content as string;
        expect(content.length).toBeLessThan(500);
      }, { timeout: 3000 });
    });
  });

  // --- Test: LLM timeout triggers template fallback ---

  describe("LLM timeout fallback", () => {
    it("delivers template fallback when LLM does not respond within 30s", async () => {
      const channelSource: ChatSource = { type: "channel", channelId: "ch-timeout", chatId: "chat-timeout" };
      const session = sessionManager.createSession(channelSource);

      const task = makeTask({ sourceSessionId: session.id });
      createTask(task);

      // 活法二: simulate LLM silence with a HANGING LiveSession query — the per-turn push
      // never resolves, so handleTaskStatusReport's 30s reportTimeoutId fires the template
      // fallback (replaces the removed processQueue-override mechanism).
      mockQueryFn.mockReset().mockImplementation((opts: unknown) =>
        makeHangingQuery()(opts as unknown),
      );

      // Spy deliverToChannel to confirm the channel-origin fallback path runs.
      const cm = chatManager as unknown as Record<string, unknown>;
      const deliverSpy = vi.fn().mockResolvedValue(undefined);
      cm["deliverToChannel"] = deliverSpy;

      // Register the origin so the running-status report fires.
      const originMap = (chatManager as unknown as { taskOriginMap: Map<string, unknown> }).taskOriginMap;
      originMap.set(task.id, { chatSessionId: session.id, source: channelSource, createdAt: Date.now() });

      vi.useFakeTimers();
      try {
        // Emit task_status_change running — kicks off the report turn (hanging) + 30s timer.
        serverBusMock.emit({
          type: "task_status_change",
          taskId: task.id,
          oldStatus: "pending",
          newStatus: "running",
        });

        // Let the async report-turn IIFE reach `await liveSession.push(...)` (which hangs),
        // then advance past the 30s timeout so the fallback timer fires.
        await vi.advanceTimersByTimeAsync(31_000);
      } finally {
        vi.useRealTimers();
      }

      // Fallback delivered to the channel origin with the "已启动" template.
      expect(deliverSpy).toHaveBeenCalled();
      const [, , fallbackContent] = deliverSpy.mock.calls[0];
      expect(fallbackContent).toContain("已启动");

      // And the same fallback was written to the session as a status_report.
      const messages = getMessagesBySession(session.id);
      const fallbackMsg = messages.find((m) => m.role === "assistant" && m.taskId === task.id);
      expect(fallbackMsg).toBeDefined();
      expect(fallbackMsg!.content).toContain("已启动");
    });
  });
});
