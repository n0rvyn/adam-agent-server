/**
 * Unit tests for ChatManager.restartSession().
 *
 * 活法二 rework: restartSession no longer aborts a single global in-flight turn,
 * rebuilds a warm subprocess, or preserves a global messageQueue. It now closes ONLY
 * the per-session LiveSessions whose in-flight turn is stale (age > threshold); healthy
 * sessions are untouched and recovery is lazy (next message recreates via
 * getOrCreateLiveSession).
 *
 * REMOVED cases (tested the deleted global-session restart internals):
 *   - "aborts hung in-flight turn and resets processing" (global abort)
 *   - "rebuilds warm subprocess on restartSession (startup called again)" (warm rebuild)
 *   - "does not throw when warm rebuild fails; falls back to cold path" (warm rebuild)
 *   - "preserves queued messages when restartSession is called" (global messageQueue)
 * The replacement (stale per-session LiveSession close, healthy left alone) is covered by
 * platform/watchdog-chatmanager-health.test.ts (WD-TC3).
 *
 * KEPT: "keeps running=true after restartSession" — still-valid invariant (restartSession
 * must not tear down the manager).
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

function makeColdQueryMock() {
  return (async function* () {
    yield { type: "result", result: "cold response" };
  })();
}

// ---- Tests ----

describe("ChatManager restartSession", () => {
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

  // KEPT: restartSession must not tear down the manager (still-valid invariant).
  describe("running state preserved", () => {
    it("keeps running=true after restartSession", async () => {
      mockQuery.mockReturnValue(makeColdQueryMock());

      const cm = new ChatManager();
      await cm.start();

      expect(cm.isHealthy()).toBe(true);

      await cm.restartSession();

      // running should still be true
      expect(cm.isHealthy()).toBe(true);
    });
  });
});
