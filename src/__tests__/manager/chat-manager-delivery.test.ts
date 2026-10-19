/**
 * Tests for ChatManager delivery fixes:
 * - Bug 4a: activeChatSessionId race condition (push-time vs process-time)
 * - Bug 4b: deliverToChannel passes taskId for gateway dedup
 * - T17: blocked task delivery (deliverTo path, reportTo short-circuit, origin fallback, goal aggregation)
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { ChatManager } from "../../manager/chat-manager.js";
import { createMessage } from "../../store/messages.js";
import { updateGoal, getGoal } from "../../store/goals.js";
import { getTask, listTasksByParent } from "../../store/tasks.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Track serverBus events, especially task_created handler registration
const busHandlers = new Map<string, Array<(data: unknown) => void>>();
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: vi.fn((event: { type: string }) => {
      const handlers = busHandlers.get(event.type);
      if (handlers) handlers.forEach((h) => h(event));
    }),
    on: vi.fn((event: string, handler: (data: unknown) => void) => {
      if (!busHandlers.has(event)) busHandlers.set(event, []);
      busHandlers.get(event)!.push(handler);
    }),
  },
}));

// Track gateway.send calls
const gatewaySendCalls: Array<{ taskId?: string; channelId?: string; chatId?: string; messageType: string; content?: string }> = [];
vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: vi.fn(() => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (opts: { taskId?: string; channelId?: string; chatId?: string; messageType: string; content?: string }) => {
      gatewaySendCalls.push(opts);
      return { success: true, logEntryId: "log-1" };
    }),
  })),
}));

// Mock SDK to return immediately
let queryCallCount = 0;
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    queryCallCount++;
    return {
      [Symbol.asyncIterator]: async function* () {
        yield { type: "result", result: `Response ${queryCallCount}` };
      },
    };
  }),
  startup: vi.fn(async () => ({})),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn(() => ({})),
}));

vi.mock("../../manager/adam-tools.js", () => ({
  createAdamTools: vi.fn(() => ({})),
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
  }),
  buildSdkAuthEnv: vi.fn(() => ({})),
  buildSdkEnv: vi.fn(() => ({})),
}));

vi.mock("../../chat/context-builder.js", () => ({
  buildSessionContext: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../chat/session-manager.js", () => ({
  getSession: vi.fn((id: string) => ({
    id,
    source: { type: "channel", channelId: `ch-${id}`, chatId: `chat-${id}` },
    status: "active",
    messageCount: 0,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  })),
  incrementMessageCount: vi.fn(),
  touchSession: vi.fn(),
}));

vi.mock("../../store/messages.js", () => ({
  createMessage: vi.fn(),
}));

vi.mock("../../store/tasks.js", () => ({
  getTask: vi.fn((id: string) => ({
    id,
    status: "completed",
    prompt: "test",
    roleId: "role-1",
    result: "task result",
    reportTo: [],
    deliverTo: [{ type: "channel", channelId: "ch-target", chatId: "chat-target" }],
    createdAt: Date.now(),
  })),
  listTasksByParent: vi.fn().mockReturnValue([]),
  updateTask: vi.fn(),
  getTaskTraceId: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../store/goals.js", () => ({
  getGoal: vi.fn().mockReturnValue(null),
  updateGoal: vi.fn(),
}));

vi.mock("../../store/roles.js", () => ({
  getRole: vi.fn(() => ({ id: "role-1", name: "TestRole" })),
}));

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
  gatewaySendCalls.length = 0;
  queryCallCount = 0;
  busHandlers.clear();
});

describe("ChatManager delivery fixes", () => {
  // Bug 4a (queue race on the shared `activeChatSessionId` field) is OBSOLETE after the
  // live-session rework (活法二): each LiveSession binds its chatSessionId/source as a CONSTANT
  // at construction, so there is no shared mutable field to race. Concurrent-session attribution
  // is covered by src/__tests__/manager/chat-session-context-binding.test.ts.

  describe("Bug 4b: deliverToChannel passes taskId for dedup", () => {
    it("completion report to channel includes taskId in gateway.send", async () => {
      const cm = new ChatManager();
      await cm.start();

      // Simulate task completion event
      const handlers = busHandlers.get("task_complete_event");
      expect(handlers).toBeDefined();
      expect(handlers!.length).toBeGreaterThan(0);

      // Set up a known origin
      const originMap = (cm as unknown as { taskOriginMap: Map<string, unknown> }).taskOriginMap;
      originMap.set("task-abc", {
        chatSessionId: "session-ch",
        source: { type: "channel", channelId: "ch-origin", chatId: "chat-origin" },
        createdAt: Date.now(),
      });

      // Trigger task_complete_event
      handlers![0]({ type: "task_complete_event", taskId: "task-abc", result: "done" });

      // Wait for async processing (LLM queue + delivery)
      await new Promise((r) => setTimeout(r, 200));

      // Check gateway.send calls: all should have taskId
      const channelCalls = gatewaySendCalls.filter((c) => c.channelId);
      expect(channelCalls.length).toBeGreaterThan(0);
      for (const call of channelCalls) {
        // Completion-stage calls should have taskId for dedup
        if (call.messageType === "result_delivery" || call.messageType === "status_report" || call.messageType === "deliver" || call.messageType === "report") {
          expect(call.taskId).toBe("task-abc");
        }
      }

      cm.stop();
    });

    it("deliverTo explicit targets include taskId in gateway.send", async () => {
      const cm = new ChatManager();
      await cm.start();

      const originMap = (cm as unknown as { taskOriginMap: Map<string, unknown> }).taskOriginMap;
      originMap.set("task-del", {
        chatSessionId: "session-del",
        source: { type: "channel", channelId: "ch-src", chatId: "chat-src" },
        createdAt: Date.now(),
      });

      const handlers = busHandlers.get("task_complete_event");
      handlers![0]({ type: "task_complete_event", taskId: "task-del", result: "delivered" });

      await new Promise((r) => setTimeout(r, 200));

      // Find the "result_delivery" type calls (Phase 4: unified envelope replaces legacy "deliver")
      const deliverCalls = gatewaySendCalls.filter((c) => c.messageType === "result_delivery");
      expect(deliverCalls.length).toBeGreaterThan(0);
      for (const call of deliverCalls) {
        expect(call.taskId).toBe("task-del");
      }

      cm.stop();
    });
  });

  describe("blocked task delivery (T17)", () => {
    // Track message creation calls to detect LLM-based completion reports
    let messageCreateCalls: Array<{ content: string }>;
    beforeEach(() => {
      messageCreateCalls = [];
      vi.mocked(createMessage).mockImplementation((opts: { sessionId: string; content: string }) => {
        messageCreateCalls.push({ content: opts.content });
      });
    });

    it("blocked task triggers status_report envelope to deliverTo target (Phase 4: unified envelope)", async () => {
      const cm = new ChatManager();
      await cm.start();
      const taskId = "task-blocked-deliver";

      const originMap = (cm as unknown as { taskOriginMap: Map<string, unknown> }).taskOriginMap;
      originMap.set(taskId, {
        chatSessionId: `session-${taskId}`,
        source: { type: "channel", channelId: "ch-origin", chatId: "chat-origin" },
        createdAt: Date.now(),
      });
      vi.mocked(getTask).mockImplementation((id: string) => {
        if (id !== taskId) return undefined;
        return {
          id,
          status: "blocked",
          prompt: "test",
          config: { timeout: 0, approvalRequired: [], approvalTimeout: 0 },
          roleId: "role-1",
          blockReason: { reason: "missing_credential", missingPrereqs: ["MINIMAX_API_KEY"], resumeHint: "set MINIMAX_API_KEY" },
          deliverTo: [{ type: "channel", channelId: "ch-target", chatId: "chat-target" }],
          reportTo: [{ type: "channel", channelId: "ch-reporter", chatId: "chat-reporter" }],
          createdAt: Date.now(),
        } as ReturnType<typeof getTask>;
      });

      const handlers = busHandlers.get("task_complete_event");
      handlers![0]({ type: "task_complete_event", taskId, result: "stuck" });

      await new Promise((r) => setTimeout(r, 200));

      // Phase 4: blocked task sends one status_report envelope per unique target.
      // deliverTo target (ch-target) should get a status_report (not "deliver").
      const targetCalls = gatewaySendCalls.filter((c) => c.channelId === "ch-target");
      expect(targetCalls.length).toBeGreaterThan(0);
      expect(targetCalls[0].messageType).toBe("status_report");
      expect(targetCalls[0].content).toContain("任务卡住");
      expect(targetCalls[0].content).toContain("missing_credential");

      cm.stop();
    });

    it("blocked task does NOT trigger LLM-based completion report to reportTo target", async () => {
      const cm = new ChatManager();
      await cm.start();
      const taskId = "task-blocked-report";

      const originMap = (cm as unknown as { taskOriginMap: Map<string, unknown> }).taskOriginMap;
      originMap.set(taskId, {
        chatSessionId: `session-${taskId}`,
        source: { type: "channel", channelId: "ch-origin", chatId: "chat-origin" },
        createdAt: Date.now(),
      });
      vi.mocked(getTask).mockImplementation((id: string) => {
        if (id !== taskId) return undefined;
        return {
          id,
          status: "blocked",
          prompt: "test",
          config: { timeout: 0, approvalRequired: [], approvalTimeout: 0 },
          roleId: "role-1",
          blockReason: { reason: "missing_credential", missingPrereqs: ["MINIMAX_API_KEY"], resumeHint: "set MINIMAX_API_KEY" },
          deliverTo: [{ type: "channel", channelId: "ch-target", chatId: "chat-target" }],
          reportTo: [{ type: "channel", channelId: "ch-reporter", chatId: "chat-reporter" }],
          createdAt: Date.now(),
        } as ReturnType<typeof getTask>;
      });

      const handlers = busHandlers.get("task_complete_event");
      handlers![0]({ type: "task_complete_event", taskId, result: "stuck" });

      await new Promise((r) => setTimeout(r, 300));

      // No LLM message should be created (no completion instruction queued for blocked tasks)
      const completionMessages = messageCreateCalls.filter((c) =>
        c.content.includes("completed") || c.content.includes("✅"),
      );
      expect(completionMessages.length).toBe(0);

      cm.stop();
    });

    it("blocked task with no deliverTo/reportTo delivers blocked message to origin channel", async () => {
      const cm = new ChatManager();
      await cm.start();
      const taskId = "task-blocked-origin";

      const originMap = (cm as unknown as { taskOriginMap: Map<string, unknown> }).taskOriginMap;
      originMap.set(taskId, {
        chatSessionId: `session-${taskId}`,
        source: { type: "channel", channelId: "ch-origin", chatId: "chat-origin" },
        createdAt: Date.now(),
      });
      vi.mocked(getTask).mockImplementation((id: string) => {
        if (id !== taskId) return undefined;
        return {
          id,
          status: "blocked",
          prompt: "test",
          config: { timeout: 0, approvalRequired: [], approvalTimeout: 0 },
          roleId: "role-1",
          blockReason: { reason: "missing_input" },
          reportTo: [],
          deliverTo: [],
          createdAt: Date.now(),
        } as ReturnType<typeof getTask>;
      });

      const handlers = busHandlers.get("task_complete_event");
      handlers![0]({ type: "task_complete_event", taskId, result: "stuck" });

      await new Promise((r) => setTimeout(r, 200));

      // Blocked message should be sent to origin channel
      const originCalls = gatewaySendCalls.filter((c) => c.channelId === "ch-origin");
      expect(originCalls.length).toBeGreaterThan(0);

      cm.stop();
    });

    it("blocked sub-task causes parent Goal status to transition to 'failed'", async () => {
      const cm = new ChatManager();
      await cm.start();
      const taskId = "task-blocked-goal-child";
      const parentGoalId = "goal-parent-001";

      const originMap = (cm as unknown as { taskOriginMap: Map<string, unknown> }).taskOriginMap;
      originMap.set(taskId, {
        chatSessionId: `session-${taskId}`,
        source: { type: "channel", channelId: "ch-origin", chatId: "chat-origin" },
        createdAt: Date.now(),
      });
      vi.mocked(getTask).mockImplementation((id: string) => {
        if (id !== taskId) return undefined;
        return {
          id,
          status: "blocked",
          prompt: "test",
          config: { timeout: 0, approvalRequired: [], approvalTimeout: 0 },
          roleId: "role-1",
          parentId: parentGoalId,
          blockReason: { reason: "missing_target" },
          reportTo: [],
          deliverTo: [],
          createdAt: Date.now(),
        };
      });
      vi.mocked(listTasksByParent).mockImplementation((parentId: string) => {
        if (parentId !== parentGoalId) return [];
        return [
          { id: taskId, status: "blocked", parentId, prompt: "test", config: { timeout: 0, approvalRequired: [], approvalTimeout: 0 }, createdAt: Date.now() },
          { id: "task-sibling-1", status: "completed", parentId, prompt: "test", config: { timeout: 0, approvalRequired: [], approvalTimeout: 0 }, createdAt: Date.now() },
        ] as ReturnType<typeof listTasksByParent>;
      });
      vi.mocked(getGoal).mockImplementation((id: string) => {
        if (id !== parentGoalId) return undefined;
        return { id, status: "pending", prompt: "parent goal", name: "Test Goal", roleId: "role-1", metricType: "boolean" as const, targetValue: 1, currentValue: 0, createdAt: Date.now() } as unknown as ReturnType<typeof getGoal>;
      });

      const handlers = busHandlers.get("task_complete_event");
      handlers![0]({ type: "task_complete_event", taskId, result: "stuck" });

      await new Promise((r) => setTimeout(r, 300));

      // Goal should have been updated to 'failed' (not stuck in 'pending')
      expect(vi.mocked(updateGoal)).toHaveBeenCalledWith(
        parentGoalId,
        expect.objectContaining({ status: "failed" }),
      );

      cm.stop();
    });
  });
});
