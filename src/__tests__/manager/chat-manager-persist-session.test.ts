/**
 * Unit tests for ChatManager SDK option contract.
 *
 * 活法二 rework: ChatManager now uses a per-session LiveSession map with
 * persistSession:TRUE + resume-from-DB (restoring the dev-guide design; the
 * earlier persistSession:false was the #221 regression). The two persistSession
 * assertions below are REGRESSION SHIELDS asserting persistSession:true.
 *
 * NOTE: ExecutionManager + llm-eval still pass persistSession:false (correct, #221) —
 * those are covered by their own tests and are NOT affected by this rework.
 *
 * The former "resume is NOT present" expectation no longer holds for ChatManager
 * (resume IS now passed when a stored sdkSessionId exists). The no-resume-when-absent
 * path is covered by chat-manager-live-routing.test.ts TC4 (resume only when DB has an id).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockStartup, mockQuery, mockGetRole, mockBuildChatSystemPrompt, mockCreateAdamTools, mockBuildSessionHooks, mockBuildCanUseTool } = vi.hoisted(() => ({
  mockStartup: vi.fn(),
  mockQuery: vi.fn(),
  mockGetRole: vi.fn(() => ({
    id: "role-chat-manager",
    name: "ChatManager",
    cagPrompt: "",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "",
    status: "active" as const,
    preferences: {},
    createdAt: Date.now(),
  })),
  mockBuildChatSystemPrompt: vi.fn(() => "MOCKED_SYSTEM_PROMPT"),
  mockCreateAdamTools: vi.fn(() => ({ getTools: vi.fn(() => []), callTool: vi.fn() })),
  mockBuildSessionHooks: vi.fn(() => ({})),
  mockBuildCanUseTool: vi.fn(() => () => ({ behavior: "allow" })),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
  startup: mockStartup,
}));

vi.mock("../../store/roles.js", () => ({ getRole: mockGetRole }));
vi.mock("../../manager/chat-system-prompt.js", () => ({ buildChatSystemPrompt: mockBuildChatSystemPrompt }));
vi.mock("../../manager/adam-tools.js", () => ({ createAdamTools: mockCreateAdamTools }));
vi.mock("../../manager/hooks.js", () => ({
  buildSessionHooks: mockBuildSessionHooks,
  buildCanUseTool: mockBuildCanUseTool,
}));
vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }),
}));
vi.mock("../../store/server-state.js", () => ({
  getServerState: vi.fn().mockReturnValue({}),
}));
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { on: vi.fn(), emit: vi.fn(), off: vi.fn() },
}));
vi.mock("../../store/goals.js", () => ({ getGoal: vi.fn(), updateGoal: vi.fn() }));
vi.mock("../../store/tasks.js", () => ({
  getTask: vi.fn(), updateTask: vi.fn(), listTasksByParent: vi.fn(() => []),
  incrementRetryCount: vi.fn(), createDelayedRetry: vi.fn(),
  getDueDelayedRetries: vi.fn(() => []), deleteDelayedRetry: vi.fn(),
  deleteDelayedRetryByTaskId: vi.fn(), getTaskTraceId: vi.fn(),
}));
vi.mock("../../store/messages.js", () => ({ createMessage: vi.fn() }));
vi.mock("../../chat/context-builder.js", () => ({ buildSessionContext: vi.fn(async (_s: string, m: string) => m) }));
vi.mock("../../chat/session-manager.js", () => ({ getSession: vi.fn(), incrementMessageCount: vi.fn() }));
vi.mock("../../config/runtime.js", () => ({
  buildSdkEnv: vi.fn(() => ({})),
  getRuntimeConfig: vi.fn(() => ({
    defaults: { maxBudgetUsd: 5 },
    anthropic: { smallFastModel: "claude-haiku-4-5-20251001" },
  })),
}));

describe("ChatManager SDK option contract (persistSession regression shield)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: warm startup fails so cold query() runs immediately
    mockStartup.mockRejectedValue(new Error("warm disabled for test"));
    // Cold query async iterator that emits a result event then ends
    mockQuery.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "result", result: "ok" };
      },
    });
  });

  afterEach(() => vi.resetModules());

  it("ChatManager passes persistSession:true (resume enabled)", async () => {
    const { ChatManager } = await import("../../manager/chat-manager.js");
    const cm = new ChatManager();
    await cm.start();
    await cm.handleMessage("hello");

    expect(mockQuery).toHaveBeenCalled();
    const args = mockQuery.mock.calls[0]?.[0] as { options?: { persistSession?: boolean } };
    expect(args.options?.persistSession).toBe(true);

    cm.stop();
  });

  it("does NOT pass resume in options (no SDK session continuity)", async () => {
    const { ChatManager } = await import("../../manager/chat-manager.js");
    const cm = new ChatManager();
    await cm.start();
    await cm.handleMessage("hello");

    const args = mockQuery.mock.calls[0]?.[0] as { options?: Record<string, unknown> };
    expect("resume" in (args.options ?? {})).toBe(false);

    cm.stop();
  });

  // 活法二: start() no longer spawns a warm startup() subprocess — warm bootstrap is
  // deferred to the first getOrCreateLiveSession(). This shield asserts the SDK query
  // options carry persistSession:true AND that `resume` is absent when the DB has no
  // stored sdkSessionId (getSession mocked to return undefined above). The resume-present
  // case is covered by chat-manager-live-routing.test.ts TC4.
  it("ChatManager passes persistSession:true and no resume when DB has no stored sdkSessionId", async () => {
    const { ChatManager } = await import("../../manager/chat-manager.js");
    const cm = new ChatManager();
    await cm.start();
    await cm.handleMessage("hello");

    expect(mockQuery).toHaveBeenCalled();
    const args = mockQuery.mock.calls[0]?.[0] as { options?: Record<string, unknown> };
    expect((args.options as { persistSession?: boolean })?.persistSession).toBe(true);
    expect("resume" in (args.options ?? {})).toBe(false);

    cm.stop();
  });

  it("constructor accepts no arguments", async () => {
    // Compile-time + runtime check: new ChatManager() must work without sessionId param.
    // ESM project: use dynamic import, not require().
    const { ChatManager } = await import("../../manager/chat-manager.js");
    expect(() => new ChatManager()).not.toThrow();
  });

  // Fix B (2026-06-01): ChatManager must resolve its OWN Role's model (via effort-tier-resolver)
  // and pass it to query(). Previously buildSharedOptions ignored model entirely, so the Chat
  // Manager Role's model/effortTier config was dead and ChatManager always ran on ANTHROPIC_MODEL.
  it("passes the Chat Manager Role's resolved model (effortTier:high → defaultOpusModel) to query()", async () => {
    const runtime = await import("../../config/runtime.js");
    vi.mocked(runtime.getRuntimeConfig).mockReturnValue({
      defaults: { maxBudgetUsd: 5 },
      anthropic: {
        smallFastModel: "deepseek-v4-flash",
        defaultOpusModel: "doubao-seed-2.0-pro",
        defaultSonnetModel: "deepseek-v4-flash",
      },
    } as unknown as ReturnType<typeof runtime.getRuntimeConfig>);
    mockGetRole.mockReturnValue({
      id: "role-chat-manager",
      name: "ChatManager",
      cagPrompt: "",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "",
      status: "active" as const,
      preferences: {},
      createdAt: Date.now(),
      effortTier: "high",
    } as unknown as ReturnType<typeof mockGetRole>);

    const { ChatManager } = await import("../../manager/chat-manager.js");
    const cm = new ChatManager();
    await cm.start();
    await cm.handleMessage("hello");

    const args = mockQuery.mock.calls[0]?.[0] as { options?: { model?: string; fallbackModel?: string } };
    expect(args.options?.model).toBe("doubao-seed-2.0-pro");          // high → defaultOpusModel
    expect(args.options?.fallbackModel).toBe("deepseek-v4-flash");    // high fallback → defaultSonnetModel

    cm.stop();
  });

  // Regression shield: when the Chat Manager Role has NO model and NO effortTier, no `model`
  // key is added → SDK falls through to ANTHROPIC_MODEL (the current/default behavior).
  it("omits model when the Chat Manager Role has neither model nor effortTier", async () => {
    // Set our own no-tier role (mock implementations leak across tests; clearAllMocks only
    // clears call history — see feedback_vitest_mock_isolation).
    mockGetRole.mockReturnValue({
      id: "role-chat-manager",
      name: "ChatManager",
      cagPrompt: "",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "",
      status: "active" as const,
      preferences: {},
      createdAt: Date.now(),
    } as unknown as ReturnType<typeof mockGetRole>);

    const { ChatManager } = await import("../../manager/chat-manager.js");
    const cm = new ChatManager();
    await cm.start();
    await cm.handleMessage("hello");

    const args = mockQuery.mock.calls[0]?.[0] as { options?: Record<string, unknown> };
    expect("model" in (args.options ?? {})).toBe(false);

    cm.stop();
  });
});
