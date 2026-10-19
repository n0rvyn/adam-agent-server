/**
 * Unit tests for ChatManager streaming-query behavior at the manager boundary.
 *
 * 活法二 rework: the message path runs through a per-session LiveSession streaming
 * query (no global messageQueue / single-shot runQuery). Per-turn inactivity now lives
 * inside LiveSession (reject the in-flight turn after INACTIVITY_MS).
 *
 * REMOVED case (tested the deleted messageQueue model — "processing resets and queue
 * advances after inactivity timeout"): the per-turn 6-min inactivity guard is now covered
 * by live-session.test.ts case 6 ("per-turn 6-min inactivity guard").
 *
 * KEPT:
 * - (b) Normal stream with stream_events + result → result returned, not processing.
 * - (c) Slow-but-active stream (events spaced below threshold) → no false timeout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Stable mock references via vi.hoisted ----
const { mockStartup, mockQuery, mockGetRole, mockBuildChatSystemPrompt, mockCreateAdamTools, mockBuildSessionHooks, mockBuildCanUseTool } = vi.hoisted(() => ({
  mockStartup: vi.fn(),
  mockQuery: vi.fn(),
  mockGetRole: vi.fn(),
  mockBuildChatSystemPrompt: vi.fn(() => "MOCKED_SYSTEM_PROMPT"),
  mockCreateAdamTools: vi.fn(() => ({
    getTools: vi.fn(() => []),
    callTool: vi.fn(),
  })),
  mockBuildSessionHooks: vi.fn(() => ({})),
  mockBuildCanUseTool: vi.fn(() => () => ({ behavior: "allow" })),
}));

// ---- Mock SDK ----
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
  startup: mockStartup,
}));

// ---- Mock dependencies ----
vi.mock("../../store/roles.js", () => ({
  getRole: mockGetRole,
}));

vi.mock("../../manager/chat-system-prompt.js", () => ({
  buildChatSystemPrompt: mockBuildChatSystemPrompt,
}));

vi.mock("../../manager/adam-tools.js", () => ({
  createAdamTools: mockCreateAdamTools,
}));

vi.mock("../../manager/hooks.js", () => ({
  buildSessionHooks: mockBuildSessionHooks,
  buildCanUseTool: mockBuildCanUseTool,
}));

vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
}));

vi.mock("../../store/server-state.js", () => ({
  getServerState: vi.fn().mockReturnValue({ sdkSessionId: undefined, userTaskSessionId: undefined }),
}));

vi.mock("../server/events/server-bus.js", () => ({
  serverBus: { on: vi.fn(), emit: vi.fn(), off: vi.fn() },
}));

vi.mock("../../store/goals.js", () => ({
  getGoal: vi.fn(),
  updateGoal: vi.fn(),
}));

vi.mock("../../store/tasks.js", () => ({
  getTask: vi.fn(),
  updateTask: vi.fn(),
  listTasksByParent: vi.fn(),
  getDueDelayedRetries: vi.fn(() => []),
  createDelayedRetry: vi.fn(),
  deleteDelayedRetry: vi.fn(),
  deleteDelayedRetryByTaskId: vi.fn(),
  getTaskTraceId: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../chat/session-manager.js", () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  updateSessionActivity: vi.fn(),
}));

vi.mock("../../chat/context-builder.js", () => ({
  buildSessionContext: vi.fn().mockResolvedValue(""),
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: vi.fn(() => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined), deliver: vi.fn(), queue: vi.fn() })),
}));

vi.mock("../../config/runtime.js", () => ({
  buildSdkEnv: vi.fn(() => ({})),
  getRuntimeConfig: vi.fn(() => ({
    defaults: { maxBudgetUsd: 5 },
    anthropic: {},
  })),
}));

vi.mock("../../store/messages.js", () => ({
  createMessage: vi.fn(),
}));

vi.mock("../../store/pending-prompts.js", () => ({
  listOpenPromptsByTask: vi.fn(() => []),
  expirePendingPrompt: vi.fn(),
}));

vi.mock("../../store/db.js", () => ({
  getDb: vi.fn(() => ({ prepare: vi.fn() })),
}));

vi.mock("../../lib/task-dispatch.js", () => ({
  createTaskWithAdmission: vi.fn(),
}));

vi.mock("../../lib/error-classifier.js", () => ({
  isClassifiedError: vi.fn(() => false),
}));

vi.mock("../../lib/template-execution-task.js", () => ({
  isTemplateExecutionStepTask: vi.fn(() => false),
}));

vi.mock("../../audit/delivery-claim-auditor.js", () => ({
  auditDeliveryClaims: vi.fn(),
}));

vi.mock("../../audit/claim-receipt-auditor.js", () => ({
  auditClaimsForTurn: vi.fn(),
}));

vi.mock("../../store/auditor-divergence.js", () => ({
  writeDivergenceLog: vi.fn(),
}));

vi.mock("../../store/assistant-delivery-commitments.js", () => ({
  findPendingDeliveryCommitmentsForTask: vi.fn(() => []),
  markDeliveryCommitmentFulfilled: vi.fn(),
  markDeliveryCommitmentFailed: vi.fn(),
}));

vi.mock("../../chat/artifact-helper.js", () => ({
  createReportArtifact: vi.fn(),
}));

vi.mock("../../chat/attachment-converter.js", () => ({
  chatAttachmentToOutbound: vi.fn(),
}));

vi.mock("../../chat/deliverable-resolver.js", () => ({
  resolveDeliverableArtifacts: vi.fn(),
}));

vi.mock("../../delivery/attachment-fanout.js", () => ({
  sendCommittedAttachmentFanout: vi.fn(),
}));

vi.mock("../../store/channels.js", () => ({
  getChannel: vi.fn(),
}));

vi.mock("../../lib/trace-context.js", () => ({
  withTrace: vi.fn((_traceId, _scope, fn) => fn()),
  getCurrentTraceId: vi.fn(),
}));

// ---- Import AFTER all mocks ----
import { ChatManager } from "../../manager/chat-manager.js";

// ---- Helpers ----

/** Async iterable yielding a fixed sequence of events. */
function makeSequenceAsyncIterable(events: Array<Record<string, unknown>>) {
  // Use a sync generator wrapped in an async iterable — events yield immediately
  return (async function* () {
    for (const ev of events) {
      yield ev;
    }
  })();
}

/** Async iterable that yields events with a delay between each (for slow-but-active testing). */
function makeDelayedAsyncIterable(events: Array<Record<string, unknown>>, delayMs: number) {
  return (async function* () {
    for (const ev of events) {
      await new Promise((r) => setTimeout(r, delayMs));
      yield ev;
    }
  })();
}

// ---- Tests ----

describe("ChatManager inactivity timeout (hung query recovery)", () => {
  let mockSetInterval: ReturnType<typeof vi.spyOn>;
  let mockClearInterval: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSetInterval = vi.spyOn(global, "setInterval").mockReturnValue(123 as unknown as ReturnType<typeof setInterval>);
    mockClearInterval = vi.spyOn(global, "clearInterval").mockReturnValue(undefined);
    mockBuildChatSystemPrompt.mockReturnValue("MOCKED_SYSTEM_PROMPT");
    mockGetRole.mockReturnValue(undefined);
    mockCreateAdamTools.mockReturnValue({
      getTools: vi.fn(() => []),
      callTool: vi.fn(),
    });
    mockBuildSessionHooks.mockReturnValue({});
    mockBuildCanUseTool.mockReturnValue(() => ({ behavior: "allow" }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Case (b): normal stream — no timeout", () => {
    beforeEach(() => {
      // Use real timers for normal flow test
      vi.useRealTimers();
      mockStartup.mockRejectedValue(new Error("warm not available"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns result text normally when SDK events arrive without delay", async () => {
      // Stream events then a final result
      mockQuery.mockReturnValue(
        makeSequenceAsyncIterable([
          { type: "stream_event" },
          { type: "stream_event" },
          { type: "result", result: "ok" },
        ]),
      );

      const cm = new ChatManager();
      await cm.start();

      const result = await cm.handleMessage("hello");

      expect(result).toBe("ok");
      expect(cm.isProcessing()).toBe(false);
    });
  });

  describe("Case (c): slow but active — no false timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      mockStartup.mockRejectedValue(new Error("warm not available"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not timeout when events arrive consistently below inactivity threshold", async () => {
      // Each event arrives after a 100ms delay; 6 events total = 500ms of wall time.
      // Each individual gap (100ms) is far below the inactivity threshold (360s).
      // Total duration (500ms) is also below the threshold.
      // Without the fix: this works fine (no timeout logic at all).
      // With the fix: per-event reset keeps the timeout from firing.
      mockQuery.mockReturnValue(
        makeDelayedAsyncIterable(
          [
            { type: "stream_event" },
            { type: "stream_event" },
            { type: "stream_event" },
            { type: "stream_event" },
            { type: "stream_event" },
            { type: "result", result: "slow-but-ok" },
          ],
          100,
        ),
      );

      const cm = new ChatManager();
      await cm.start();

      const resultPromise = cm.handleMessage("hello");

      // Advance timers step by step to let each delayed event fire
      // 6 events * 100ms each = 600ms total; advance 1s to be safe
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await resultPromise;
      expect(result).toBe("slow-but-ok");
      expect(cm.isProcessing()).toBe(false);
    });
  });
});
