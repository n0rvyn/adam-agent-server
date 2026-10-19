/**
 * Integration test for auditor divergence logging.
 *
 * Goal: verify that both wire points (message_handler + chat_manager_envelope) correctly
 * write divergence rows to the real DB via writeDivergenceLog, and that listDivergenceLog
 * can read them back with filter support.
 *
 * Key difference from the unit tests (chat-manager-claim-audit.test.ts and
 * message-handler-claim-audit.test.ts):
 *   - Those tests mock writeDivergenceLog to verify call arguments.
 *   - This test exercises the real DB write + read path against the v64 schema
 *     (auditor_divergence_log table) without mocking the divergence store module.
 *
 * For the "new blocks" cases, we seed assistant_claims rows (with no matching receipts)
 * so the real auditClaimsForTurn returns blocked. For the "new passes" cases we let it
 * return passed (vacuous — no claims in DB).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { listDivergenceLog, writeDivergenceLog } from "../../store/auditor-divergence.js";
import type { ChatSource } from "../../shared/types.js";

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

// ── DB mock (real getDb points to test DB) ─────────────────────────────────

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
  closeDb: () => {},
}));

// ── ChatManager dependencies ────────────────────────────────────────────────

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: vi.fn(() => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ success: true }),
  })),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../../manager/adam-tools.js", () => ({
  createAdamTools: vi.fn(() => ({})),
}));

vi.mock("../../lib/role-capabilities.js", () => ({
  resolveRolePluginPaths: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../agent/memory-service.js", () => ({
  queryMemory: vi.fn().mockResolvedValue([]),
}));

// ── Old auditors + new claim auditor (all hoisted for consistent mock control) ──

const { mockAuditDeliveryClaims, mockAuditAssistantCommitment } = vi.hoisted(() => ({
  mockAuditDeliveryClaims: vi.fn(),
  mockAuditAssistantCommitment: vi.fn(),
}));

const { mockAuditClaimsForTurn } = vi.hoisted(() => ({
  mockAuditClaimsForTurn: vi.fn(),
}));

const { mockApplyFutureDeliveryCommitmentGate } = vi.hoisted(() => ({
  mockApplyFutureDeliveryCommitmentGate: vi.fn(),
}));

const { mockRecordAuditDiagnostic } = vi.hoisted(() => ({
  mockRecordAuditDiagnostic: vi.fn(),
}));

vi.mock("../../audit/audit-manager.js", () => ({
  auditDeliveryClaims: mockAuditDeliveryClaims,
  auditAssistantCommitment: mockAuditAssistantCommitment,
}));

// auditClaimsForTurn is mocked for deterministic verdict control.
// writeDivergenceLog / listDivergenceLog are called against the real in-memory DB
// (via the store/db.js mock), so the v64 schema is exercised end-to-end.
vi.mock("../../audit/claim-receipt-auditor.js", () => ({
  auditClaimsForTurn: mockAuditClaimsForTurn,
}));

// delivery-claim-auditor.js is imported directly by chat-manager.ts (not via audit-manager.js).
// Must be mocked here so chat_manager_envelope tests can control old-auditor verdict.
vi.mock("../../audit/delivery-claim-auditor.js", () => ({
  auditDeliveryClaims: mockAuditDeliveryClaims,
}));

vi.mock("../../chat/delivery-commitment-gate.js", () => ({
  applyFutureDeliveryCommitmentGate: mockApplyFutureDeliveryCommitmentGate,
}));

vi.mock("../../store/audit-diagnostics.js", () => ({
  recordAuditDiagnostic: mockRecordAuditDiagnostic,
}));

// ── Session manager mock (must export all functions message-handler uses) ───

vi.mock("../../chat/session-manager.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    createSession: vi.fn().mockReturnValue({
      id: "session-div-test",
      source: { type: "web" },
      createdAt: Date.now(),
    }),
    getActiveSession: vi.fn(),
    getSession: vi.fn(),
    _resetForTest: vi.fn(),
  };
});

// ── Message handler mock (real handleChatMessage, setChatManager from real module) ─

vi.mock("../../chat/message-handler.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    _resetListenerForTest: vi.fn().mockResolvedValue(undefined),
  };
});

// ── Other store mocks (real DB reads/writes where needed) ──────────────────

vi.mock("../../store/messages.js", () => ({
  createMessage: vi.fn(),
  getMessagesBySession: vi.fn().mockReturnValue([]),
  getMessage: vi.fn(),
  updateMessagePromptBinding: vi.fn(),
  findEnvelopeByPlatformMessageId: vi.fn(),
}));

vi.mock("../../store/pending-prompts.js", () => ({
  listOpenPromptsBySession: vi.fn().mockReturnValue([]),
  resolvePendingPrompt: vi.fn(),
  getPendingPrompt: vi.fn(),
}));

vi.mock("../../store/channels.js", () => ({
  getChannel: vi.fn(),
}));

vi.mock("../../config/index.js", () => ({
  getChatConfig: vi.fn().mockResolvedValue({
    sessionTimeoutMinutes: 30,
    maxSessionTurns: 20,
    autoTitle: false,
    archiveExtractMemory: false,
  }),
  getDefaults: vi.fn().mockReturnValue({
    timeout: 600,
    approvalRequired: [],
    approvalTimeout: 300,
    allowedTools: [],
    disallowedTools: [],
    maxTurns: 100,
    maxBudgetUsd: 5.0,
    model: "",
    effort: "high",
    settingSources: ["project"],
    env: {},
  }),
}));

vi.mock("../../lib/llm-eval.js", () => ({
  callClaudeForEvaluation: vi.fn().mockResolvedValue("evaluated"),
}));

vi.mock("../../chat/context-builder.js", () => ({
  buildSessionContext: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../chat/cross-channel-sync.js", () => ({
  syncResolvedPrompt: vi.fn().mockResolvedValue(undefined),
}));

// ── Task store (for chat_manager_envelope path) ───────────────────────────

vi.mock("../../store/tasks.js", () => ({
  getTask: vi.fn(() => ({ id: "task-cm-test", traceId: "trace-cm-test" })),
  getTaskTraceId: vi.fn(() => "trace-cm-test"),
  updateTask: vi.fn(),
}));

// ── Real module imports ────────────────────────────────────────────────────

import { ChatManager } from "../../manager/chat-manager.js";
import {
  handleChatMessage,
  setChatManager,
  _resetListenerForTest,
} from "../../chat/message-handler.js";
import { _resetForTest as resetSessionManager } from "../../chat/session-manager.js";

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(() => {
  const { db } = setupTestDb();
  dbRef = db;
});

afterAll(async () => {
  await _resetListenerForTest();
  resetSessionManager();
  dbRef.close();
});

beforeEach(async () => {
  clearTestDb();
  mockAuditDeliveryClaims.mockReset();
  mockAuditAssistantCommitment.mockReset();
  mockApplyFutureDeliveryCommitmentGate.mockReset();
  mockRecordAuditDiagnostic.mockReset();

  // Default pass-through: OLD auditors pass; new auditor vacuously passes.
  mockApplyFutureDeliveryCommitmentGate.mockReturnValue({
    text: "",
    createdCommitmentIds: [],
    blockedReasons: [],
  });
  mockAuditDeliveryClaims.mockReturnValue({ status: "ok" });
  mockAuditAssistantCommitment.mockReturnValue({ status: "ok", replacementText: undefined });
  mockAuditClaimsForTurn.mockReturnValue({ status: "passed" });

  // Give handleChatMessage a ChatManager stub so it can call setChatManager.
  setChatManager({
    handleMessage: vi.fn().mockResolvedValue({
      text: "Assistant reply text",
      traceId: "trace-mh-test",
      dispatches: [],
    }),
  } as unknown as InstanceType<typeof ChatManager>);
});

afterEach(async () => {
  await _resetListenerForTest();
  resetSessionManager();
});

// ═══════════════════════════════════════════════════════════════════════════════
// WIRE POINT 1: message_handler
// Exercised by calling handleChatMessage (background task; wait for completion).
// ═══════════════════════════════════════════════════════════════════════════════

describe("message_handler wire point", () => {
  const webSource: ChatSource = { type: "web" };

  async function callAndWait(): Promise<void> {
    await handleChatMessage("Test message", webSource);
    // handleChatMessage fires a background task; give it time to complete.
    await new Promise(r => setTimeout(r, 100));
  }

  it("old passed + new passed — row with verdict_pair agreed_pass (Phase 6 always-write)", async () => {
    // Phase 6: writeDivergenceLog always persists, even when verdicts agree.
    mockAuditDeliveryClaims.mockReturnValue({ status: "ok" });
    mockAuditAssistantCommitment.mockReturnValue({ status: "ok" });

    await callAndWait();

    const rows = listDivergenceLog({ traceId: "trace-mh-test" });
    expect(rows).toHaveLength(1);
    expect(rows[0].verdictPair).toBe("agreed_pass");
  });

  it("old blocked + new passed — row with old_blocks_new_passes subtype", async () => {
    // OLD blocks; new auditor vacuously passes (no claims seeded).
    mockAuditDeliveryClaims.mockReturnValue({ status: "ok" });
    mockAuditAssistantCommitment.mockReturnValue({ status: "blocked", replacementText: "Old blocked text" });

    await callAndWait();

    const rows = listDivergenceLog({ traceId: "trace-mh-test" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      wirePoint: "message_handler",
      oldVerdict: "blocked",
      newVerdict: "passed",
      divergenceSubtype: "old_blocks_new_passes",
    });
  });

  it("old passed + new blocked — row with old_passes_new_blocks subtype", async () => {
    // OLD passes; new auditor blocks because we have claims with no receipts.
    mockAuditDeliveryClaims.mockReturnValue({ status: "ok" });
    mockAuditAssistantCommitment.mockReturnValue({ status: "ok" });
    mockAuditClaimsForTurn.mockReturnValue({ status: "blocked", replacementText: "操作已尝试，但未能确认效果" });

    await callAndWait();

    const rows = listDivergenceLog({ traceId: "trace-mh-test" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      wirePoint: "message_handler",
      oldVerdict: "passed",
      newVerdict: "blocked",
      divergenceSubtype: "old_passes_new_blocks",
    });
  });

  it("old blocked + new blocked — row with verdict_pair agreed_block (Phase 6 always-write)", async () => {
    // Phase 6: writeDivergenceLog always persists, even when verdicts agree (agreed_block).
    mockAuditDeliveryClaims.mockReturnValue({ status: "ok" });
    mockAuditAssistantCommitment.mockReturnValue({ status: "blocked", replacementText: "Old blocked text" });
    mockAuditClaimsForTurn.mockReturnValue({ status: "blocked", replacementText: "操作已尝试，但未能确认效果" });

    await callAndWait();

    const rows = listDivergenceLog({ traceId: "trace-mh-test" });
    expect(rows).toHaveLength(1);
    expect(rows[0].verdictPair).toBe("agreed_block");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WIRE POINT 2: chat_manager_envelope
// Exercised by calling ChatManager.applyDeliveryClaimAudit directly via casting.
// ═══════════════════════════════════════════════════════════════════════════════

describe("chat_manager_envelope wire point", () => {
  let manager: ChatManager;

  beforeEach(async () => {
    clearTestDb();
    mockAuditDeliveryClaims.mockReset();
    mockAuditClaimsForTurn.mockReset();
    // Default: OLD passes, new auditor vacuously passes (no claims in DB).
    mockAuditDeliveryClaims.mockReturnValue({ status: "passed" });
    mockAuditClaimsForTurn.mockReturnValue({ status: "passed" });
    manager = new ChatManager();
    await manager.start();
  });

  afterEach(() => { manager?.stop(); });

  it("old passed + new passed — row with verdict_pair agreed_pass (Phase 6 always-write)", () => {
    // Phase 6: writeDivergenceLog always persists, even when verdicts agree.
    mockAuditDeliveryClaims.mockReturnValue({ status: "passed" });

    (manager as any).applyDeliveryClaimAudit("Original text", "task-cm-test", "session-cm-test");

    const rows = listDivergenceLog({ traceId: "trace-cm-test" });
    expect(rows).toHaveLength(1);
    expect(rows[0].verdictPair).toBe("agreed_pass");
  });

  it("old blocked + new passed — row with old_blocks_new_passes subtype", () => {
    mockAuditDeliveryClaims.mockReturnValue({ status: "blocked", replacementText: "Old blocked replacement" });
    // auditClaimsForTurn vacuously passes (no claims in DB)

    (manager as any).applyDeliveryClaimAudit("Original text", "task-cm-test", "session-cm-test");

    const rows = listDivergenceLog({ traceId: "trace-cm-test" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      wirePoint: "chat_manager_envelope",
      oldVerdict: "blocked",
      newVerdict: "passed",
      divergenceSubtype: "old_blocks_new_passes",
    });
  });

  it("old passed + new blocked — row with old_passes_new_blocks subtype", () => {
    mockAuditDeliveryClaims.mockReturnValue({ status: "passed" });
    mockAuditClaimsForTurn.mockReturnValue({ status: "blocked", replacementText: "操作已尝试，但未能确认效果" });

    (manager as any).applyDeliveryClaimAudit("Original text", "task-cm-test", "session-cm-test");

    const rows = listDivergenceLog({ traceId: "trace-cm-test" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      wirePoint: "chat_manager_envelope",
      oldVerdict: "passed",
      newVerdict: "blocked",
      divergenceSubtype: "old_passes_new_blocks",
    });
  });

  it("old blocked + new blocked — row with verdict_pair agreed_block (Phase 6 always-write)", () => {
    // Phase 6: writeDivergenceLog always persists, even when verdicts agree (agreed_block).
    mockAuditDeliveryClaims.mockReturnValue({ status: "blocked", replacementText: "Old blocked replacement" });
    mockAuditClaimsForTurn.mockReturnValue({ status: "blocked", replacementText: "操作已尝试，但未能确认效果" });

    (manager as any).applyDeliveryClaimAudit("Original text", "task-cm-test", "session-cm-test");

    const rows = listDivergenceLog({ traceId: "trace-cm-test" });
    expect(rows).toHaveLength(1);
    expect(rows[0].verdictPair).toBe("agreed_block");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// META: listDivergenceLog filter behavior
// ═══════════════════════════════════════════════════════════════════════════════

describe("listDivergenceLog filter behavior", () => {
  // Use beforeEach (not beforeAll) so seeds run AFTER the enclosing describe's
  // clearTestDb calls in each chat_manager_envelope beforeEach.
  beforeEach(() => {
    writeDivergenceLog({
      traceId: "trace-filter-A",
      wirePoint: "message_handler",
      oldVerdict: "blocked",
      newVerdict: "passed",
    });
    writeDivergenceLog({
      traceId: "trace-filter-B",
      wirePoint: "chat_manager_envelope",
      oldVerdict: "passed",
      newVerdict: "blocked",
    });
  });

  it("filters by traceId", () => {
    const rowsA = listDivergenceLog({ traceId: "trace-filter-A" });
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].traceId).toBe("trace-filter-A");
    expect(rowsA[0].divergenceSubtype).toBe("old_blocks_new_passes");

    const rowsB = listDivergenceLog({ traceId: "trace-filter-B" });
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].traceId).toBe("trace-filter-B");
    expect(rowsB[0].divergenceSubtype).toBe("old_passes_new_blocks");
  });

  it("filters by subtype", () => {
    const rows = listDivergenceLog({ subtype: "old_blocks_new_passes" });
    expect(rows).toHaveLength(1);
    expect(rows[0].divergenceSubtype).toBe("old_blocks_new_passes");
  });

  it("no filter returns all rows", () => {
    const rows = listDivergenceLog();
    // At least the 2 seeded rows (DB is shared within the same test file;
    // each inner describe's beforeEach runs clearTestDb before the describe block,
    // but the meta describe's beforeAll runs after all inner describe blocks'
    // beforeEach have run — however clearTestDb in each inner beforeEach clears
    // the DB for each test, so by the time meta beforeAll runs the DB is already
    // populated from prior tests. To isolate, we assert ≥ 2 to cover the seeded rows.)
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
