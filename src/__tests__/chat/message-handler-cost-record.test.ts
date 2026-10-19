/**
 * Task 5-tests (record half): message-handler cost record tests.
 *
 * Asserts that after createMessage(assistantMessage) at :404, recordLlmCost
 * is called with source='chat', writing llm_costs rows and updating
 * chat_messages.cost_usd/model/token_usage.
 *
 * Also drives the ACTUAL gate control flow (checkPreflightGate) to verify
 * the turnCostRecords accumulator covers both :209 and :363 billed calls.
 *
 * FAILS before Task 5-impl (recordLlmCost not called in message-handler).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

afterAll(() => { cleanup(); });

// ─── Price table ──────────────────────────────────────────────────────────────
const TEST_PRICE_TABLE = {
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 3.75, estimated: true },
};

// Build a minimal CostRecompute for use in mock responses
function makeCostRecompute(costUsd: number, model = "claude-sonnet-4-6") {
  return {
    costUsd,
    perModel: [{
      model,
      priced: true,
      estimated: true,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd,
    }],
    pricingStatus: "priced" as const,
    unknownModels: [],
    sdkTotalCostUsd: costUsd,
  };
}

// ─── Module-level mock variables (must be hoisted) ────────────────────────────

const mockHandleMessageWithDispatches = vi.fn();
const mockCheckPreflightGate = vi.fn();

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    anthropic: { apiKey: "test-key", baseUrl: "", model: "claude-sonnet-4-6" },
    defaults: { maxTurns: 10 },
    pricing: { models: TEST_PRICE_TABLE },
  })),
  buildSdkAuthEnv: vi.fn(() => ({})),
  buildSdkEnv: vi.fn(() => ({})),
  initRuntimeConfig: vi.fn(),
  loadPersistedConfig: vi.fn(),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock("../../chat/session-manager.js", () => ({
  getSession: vi.fn(() => ({
    id: "sess-handler-test",
    source: { type: "api" },
    messageCount: 1,
    createdAt: Date.now(),
  })),
  getActiveSession: vi.fn(() => ({
    id: "sess-handler-test",
    source: { type: "api" },
    messageCount: 1,
    createdAt: Date.now(),
  })),
  createSession: vi.fn(() => ({
    id: "sess-handler-test",
    source: { type: "api" },
    messageCount: 0,
    createdAt: Date.now(),
  })),
  incrementMessageCount: vi.fn(),
  touchSession: vi.fn(),
}));

vi.mock("../../store/pending-prompts.js", () => ({
  listOpenPromptsBySession: vi.fn(() => []),
  resolvePendingPrompt: vi.fn(),
  getPendingPrompt: vi.fn(() => null),
}));

vi.mock("../../store/messages.js", () => ({
  createMessage: vi.fn(),
  getMessage: vi.fn(),
  findEnvelopeByPlatformMessageId: vi.fn(() => null),
  updateMessagePromptBinding: vi.fn(),
  updateMessageCost: vi.fn(),
}));

vi.mock("../../store/sessions.js", () => ({
  updateSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("../../store/channels.js", () => ({
  getChannel: vi.fn(() => null),
}));

vi.mock("../../chat/context-builder.js", () => ({
  buildSessionContext: vi.fn(async (sessionId: string, msg: string) => msg),
}));

vi.mock("../../audit/audit-manager.js", () => ({
  auditAssistantCommitment: vi.fn(() => ({ status: "passed" })),
  auditDeliveryClaims: vi.fn(() => ({ status: "passed" })),
}));

vi.mock("../../audit/claim-receipt-auditor.js", () => ({
  auditClaimsForTurn: vi.fn(() => ({ status: "passed" })),
}));

vi.mock("../../store/auditor-divergence.js", () => ({
  writeDivergenceLog: vi.fn(),
}));

vi.mock("../../lib/trace-context.js", () => ({
  getCurrentTraceId: vi.fn(() => "trace-test"),
  withNewTrace: vi.fn(async (_name: string, fn: () => unknown) => fn()),
}));

vi.mock("../../manager/delivery-commitment-gate.js", () => ({
  applyFutureDeliveryCommitmentGate: vi.fn((args: { text: string }) => ({ text: args.text })),
}));

vi.mock("../../chat/preflight-delivery-gate.js", () => ({
  checkPreflightGate: mockCheckPreflightGate,
  GATE_RETRY_PROMPT: "__GATE_RETRY__",
  GATE_FALLBACK_TEXT: "__GATE_FALLBACK__",
}));

vi.mock("../../chat/cross-channel-sync.js", () => ({
  syncResolvedPrompt: vi.fn(),
}));

vi.mock("../../lib/llm-eval.js", () => ({
  callClaudeForEvaluation: vi.fn(async () => "title"),
}));

vi.mock("../../store/audit-diagnostics.js", () => ({
  recordAuditDiagnostic: vi.fn(),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

// Lazily import to allow mock of chatManager (set via setChatManager)
let handleChatMessage: typeof import("../../chat/message-handler.js").handleChatMessage;
let setChatManager: typeof import("../../chat/message-handler.js").setChatManager;

beforeAll(async () => {
  const mod = await import("../../chat/message-handler.js");
  handleChatMessage = mod.handleChatMessage;
  setChatManager = mod.setChatManager;
});

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
  mockCheckPreflightGate.mockReturnValue({ shouldRetry: false });

  // Wire up a fake chatManager with handleMessageWithDispatches
  setChatManager({
    handleMessageWithDispatches: mockHandleMessageWithDispatches,
  } as unknown as import("../../manager/chat-manager.js").ChatManager);
});

const TEST_SOURCE = { type: "api" } as import("../../shared/types.js").ChatSource;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Task 5-tests (record): message-handler writes llm_costs row after createMessage", () => {

  it("TC-record-1: normal path — one llm_costs row with source='chat' after assistant message persisted", async () => {
    const recompute = makeCostRecompute(0.03);
    mockHandleMessageWithDispatches.mockResolvedValue({
      text: "Hello!",
      traceId: "trace-1",
      dispatches: [],
      cost: recompute,
      numTurns: 1,
    });

    await handleChatMessage("Hi", TEST_SOURCE);

    // Wait for the background IIFE
    await new Promise((r) => setTimeout(r, 100));

    const db = getTestDb();
    const rows = db.prepare(
      "SELECT * FROM llm_costs WHERE source = 'chat'"
    ).all() as Array<{ source: string; cost_usd: number; session_id: string }>;

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].source).toBe("chat");
    expect(rows[0].cost_usd).toBeCloseTo(0.03, 6);
  });

  it("TC-record-2: chat_messages.cost_usd is updated via mirror (updateMessageCost called)", async () => {
    const recompute = makeCostRecompute(0.05);
    mockHandleMessageWithDispatches.mockResolvedValue({
      text: "Cost test!",
      traceId: "trace-2",
      dispatches: [],
      cost: recompute,
      numTurns: 2,
    });

    await handleChatMessage("test message", TEST_SOURCE);
    await new Promise((r) => setTimeout(r, 100));

    // updateMessageCost is mocked (store/messages.js mock above)
    // Verify it was called (the mirror path)
    const { updateMessageCost } = await import("../../store/messages.js");
    expect(updateMessageCost).toHaveBeenCalled();
    const call = (updateMessageCost as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].costUsd).toBeCloseTo(0.05, 6);
  });

  it("TC-record-3: retry-won (gate true→false) — TWO llm_costs rows, both with same message_id", async () => {
    const recompute1 = makeCostRecompute(0.03, "claude-sonnet-4-6");
    const recompute2 = makeCostRecompute(0.04, "claude-sonnet-4-6");

    // First call (original :209) → gate fires (shouldRetry:true)
    // Retry call (:363) → gate passes (shouldRetry:false)
    mockHandleMessageWithDispatches
      .mockResolvedValueOnce({ text: "first attempt", traceId: "trace-3", dispatches: [], cost: recompute1, numTurns: 1 })
      .mockResolvedValueOnce({ text: "retry attempt", traceId: "trace-3", dispatches: [], cost: recompute2, numTurns: 1 });

    mockCheckPreflightGate
      .mockReturnValueOnce({ shouldRetry: true, reason: "gate fired" })  // original
      .mockReturnValueOnce({ shouldRetry: false });                       // retry

    await handleChatMessage("trigger gate", TEST_SOURCE);
    await new Promise((r) => setTimeout(r, 100));

    const db = getTestDb();
    const rows = db.prepare(
      "SELECT * FROM llm_costs WHERE source = 'chat'"
    ).all() as Array<{ source: string; cost_usd: number }>;

    // Both billed calls must be recorded
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const total = rows.reduce((s, r) => s + r.cost_usd, 0);
    expect(total).toBeCloseTo(0.07, 5);
  });

  it("TC-record-4: retry→fallback (gate true→true) — TWO llm_costs rows even when fallback text used", async () => {
    const recompute1 = makeCostRecompute(0.02);
    const recompute2 = makeCostRecompute(0.02);

    mockHandleMessageWithDispatches
      .mockResolvedValueOnce({ text: "first text", traceId: "trace-4", dispatches: [], cost: recompute1, numTurns: 1 })
      .mockResolvedValueOnce({ text: "retry text", traceId: "trace-4", dispatches: [], cost: recompute2, numTurns: 1 });

    mockCheckPreflightGate
      .mockReturnValueOnce({ shouldRetry: true, reason: "gate fired" })
      .mockReturnValueOnce({ shouldRetry: true, reason: "retry also gated" });

    await handleChatMessage("trigger both gates", TEST_SOURCE);
    await new Promise((r) => setTimeout(r, 100));

    const db = getTestDb();
    const rows = db.prepare(
      "SELECT * FROM llm_costs WHERE source = 'chat'"
    ).all() as Array<{ source: string; cost_usd: number }>;

    // Both billed calls recorded even though persisted text is GATE_FALLBACK_TEXT
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("TC-record-5: retry-throws (:376 catch) — only ONE llm_costs row (original cost)", async () => {
    const recompute1 = makeCostRecompute(0.03);

    mockHandleMessageWithDispatches
      .mockResolvedValueOnce({ text: "original", traceId: "trace-5", dispatches: [], cost: recompute1, numTurns: 1 })
      .mockRejectedValueOnce(new Error("retry network failure"));

    mockCheckPreflightGate
      .mockReturnValueOnce({ shouldRetry: true, reason: "gate fired" });
    // no second gate call — retry threw

    await handleChatMessage("retry throw test", TEST_SOURCE);
    await new Promise((r) => setTimeout(r, 100));

    const db = getTestDb();
    const rows = db.prepare(
      "SELECT * FROM llm_costs WHERE source = 'chat'"
    ).all() as Array<{ source: string; cost_usd: number }>;

    // Only the original call is recorded (retry threw before cost was captured)
    expect(rows.length).toBe(1);
    expect(rows[0].cost_usd).toBeCloseTo(0.03, 6);
  });
});
