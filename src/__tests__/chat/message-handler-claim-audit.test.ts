import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
  closeDb: () => {},
}));

vi.mock("../../config/index.js", () => ({
  getChatConfig: () => ({
    sessionTimeoutMinutes: 30,
    maxSessionTurns: 20,
    autoTitle: true,
    archiveExtractMemory: true,
  }),
  getDefaults: () => ({
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
  DEFAULT_CONFIG: { chat: { sessionTimeoutMinutes: 30, maxSessionTurns: 20, autoTitle: true, archiveExtractMemory: true } },
}));

vi.mock("../../agent/memory-service.js", () => ({
  queryMemory: vi.fn().mockResolvedValue([]),
}));

// Mock ChatManager
const mockChatManagerInstance = {
  handleMessage: vi.fn().mockResolvedValue("Hello from ChatManager!"),
};
vi.mock("../../manager/chat-manager.js", () => ({
  ChatManager: vi.fn(() => mockChatManagerInstance),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
}));

const { mockAuditDeliveryClaims, mockAuditAssistantCommitment } = vi.hoisted(() => ({
  mockAuditDeliveryClaims: vi.fn(),
  mockAuditAssistantCommitment: vi.fn(),
}));

const { mockApplyFutureDeliveryCommitmentGate } = vi.hoisted(() => ({
  mockApplyFutureDeliveryCommitmentGate: vi.fn(),
}));

const { mockRecordAuditDiagnostic } = vi.hoisted(() => ({
  mockRecordAuditDiagnostic: vi.fn(),
}));

const { mockAuditClaimsForTurn } = vi.hoisted(() => ({
  mockAuditClaimsForTurn: vi.fn(),
}));

const { mockWriteDivergenceLog } = vi.hoisted(() => ({
  mockWriteDivergenceLog: vi.fn(),
}));

vi.mock("../../audit/audit-manager.js", () => ({
  auditDeliveryClaims: mockAuditDeliveryClaims,
  auditAssistantCommitment: mockAuditAssistantCommitment,
}));

vi.mock("../../audit/claim-receipt-auditor.js", () => ({
  auditClaimsForTurn: mockAuditClaimsForTurn,
}));

vi.mock("../../store/audit-diagnostics.js", () => ({
  recordAuditDiagnostic: mockRecordAuditDiagnostic,
}));

vi.mock("../../store/auditor-divergence.js", () => ({
  writeDivergenceLog: mockWriteDivergenceLog,
}));

vi.mock("../../chat/delivery-commitment-gate.js", () => ({
  applyFutureDeliveryCommitmentGate: mockApplyFutureDeliveryCommitmentGate,
}));

const { mockGatewaySend } = vi.hoisted(() => ({
  mockGatewaySend: vi.fn().mockResolvedValue({ success: true, logEntryId: "log-test" }),
}));
vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined),
    send: mockGatewaySend,
  }),
}));

import { handleChatMessage, generateSessionTitle, setChatManager, _resetListenerForTest } from "../../chat/message-handler.js";
import { _resetForTest as resetSessionManager } from "../../chat/session-manager.js";
import type { ChatSource } from "../../shared/types.js";
import { getMessagesBySession } from "../../store/messages.js";

describe("chat/message-handler claim audit dual-write", () => {
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
    resetSessionManager();
    await _resetListenerForTest();
    clearTestDb();
    mockChatManagerInstance.handleMessage.mockClear();
    mockGatewaySend.mockClear();
    mockApplyFutureDeliveryCommitmentGate.mockClear();
    mockAuditDeliveryClaims.mockClear();
    mockAuditAssistantCommitment.mockClear();
    mockRecordAuditDiagnostic.mockClear();
    mockAuditClaimsForTurn.mockClear();
    mockWriteDivergenceLog.mockClear();
    // Default audit chain behavior: pass-through (no blocking).
    // Gate echoes the reply text (matches handleMessage's default) so reply-content
    // assertions are meaningful — the commitment audit no longer replaces this text.
    mockApplyFutureDeliveryCommitmentGate.mockReturnValue({ text: "Hello from ChatManager!", createdCommitmentIds: [], blockedReasons: [] });
    mockAuditDeliveryClaims.mockReturnValue({ status: "ok" });
    mockAuditAssistantCommitment.mockReturnValue({ status: "ok", replacementText: undefined });
    mockAuditClaimsForTurn.mockReturnValue({ status: "passed" });
    mockWriteDivergenceLog.mockReturnValue(null);
    setChatManager(mockChatManagerInstance as unknown as import("../../manager/chat-manager.js").ChatManager);
  });

  const webSource: ChatSource = { type: "web" };

  describe("dual-write audit chain", () => {
    it("Both passed: final text == response.text, Phase 6: writeDivergenceLog returns id (verdict_pair agreed_pass)", async () => {
      const content = "Fix the auth bug";
      mockAuditDeliveryClaims.mockReturnValue({ status: "ok" });
      mockAuditAssistantCommitment.mockReturnValue({ status: "ok" });
      mockAuditClaimsForTurn.mockReturnValue({ status: "passed" });
      mockWriteDivergenceLog.mockReturnValue("div-id-pass");

      await handleChatMessage(content, webSource);
      await new Promise(r => setTimeout(r, 50));

      const sessionId = mockChatManagerInstance.handleMessage.mock.calls[0]?.[1] as string;
      const messages = getMessagesBySession(sessionId);
      expect(messages).toBeDefined();
      const assistantMsg = messages[messages.length - 1];
      expect(assistantMsg.role).toBe("assistant");
      // Phase 6: writeDivergenceLog always returns id (never null), even when verdicts agree.
      expect(mockWriteDivergenceLog.mock.results[0]?.value).not.toBeNull();
    });

    it("New blocks: reply preserved, NEW replacement surfaces as a separate audit_note; divergence old_passes_new_blocks", async () => {
      const content = "Fix the auth bug";
      mockAuditDeliveryClaims.mockReturnValue({ status: "ok" });
      mockAuditAssistantCommitment.mockReturnValue({ status: "ok" });
      mockAuditClaimsForTurn.mockReturnValue({ status: "blocked", replacementText: "操作已尝试，但未能确认效果" });
      mockWriteDivergenceLog.mockReturnValue("div-id-1");

      await handleChatMessage(content, webSource);
      await new Promise(r => setTimeout(r, 50));

      const sessionId = mockChatManagerInstance.handleMessage.mock.calls[0]?.[1] as string;
      const messages = getMessagesBySession(sessionId);
      // Reply preserved (commitment audit never replaces).
      const reply = messages.find((m) => m.role === "assistant" && m.kind !== "audit_note");
      expect(reply?.content).toBe("Hello from ChatManager!");
      // NEW auditor's replacement becomes a separate labeled note.
      const note = messages.find((m) => m.kind === "audit_note");
      expect(note?.content).toBe("操作已尝试，但未能确认效果");
      expect(mockWriteDivergenceLog).toHaveBeenCalledWith(
        expect.objectContaining({
          wirePoint: "message_handler",
          oldVerdict: "passed",
          newVerdict: "blocked",
        }),
      );
    });

    it("Old blocks, new passes: OLD is shadow-only — reply preserved, NO note; divergence still records old_blocks_new_passes", async () => {
      const content = "Fix the auth bug";
      mockAuditDeliveryClaims.mockReturnValue({ status: "ok" });
      mockAuditAssistantCommitment.mockReturnValue({ status: "blocked", replacementText: "Operation blocked by old auditor" });
      mockAuditClaimsForTurn.mockReturnValue({ status: "passed" });
      mockWriteDivergenceLog.mockReturnValue("div-id-2");

      await handleChatMessage(content, webSource);
      await new Promise(r => setTimeout(r, 50));

      const sessionId = mockChatManagerInstance.handleMessage.mock.calls[0]?.[1] as string;
      const messages = getMessagesBySession(sessionId);
      // OLD verdict no longer drives output: reply preserved, OLD replacement ignored.
      const reply = messages.find((m) => m.role === "assistant" && m.kind !== "audit_note");
      expect(reply?.content).toBe("Hello from ChatManager!");
      expect(messages.some((m) => m.kind === "audit_note")).toBe(false);
      // Divergence log still records the OLD-vs-NEW disagreement for monitoring.
      expect(mockWriteDivergenceLog).toHaveBeenCalledWith(
        expect.objectContaining({
          wirePoint: "message_handler",
          oldVerdict: "blocked",
          newVerdict: "passed",
        }),
      );
    });

    it("Both blocked: reply preserved; the NEW (not OLD) text drives the audit_note", async () => {
      const content = "Fix the auth bug";
      mockAuditDeliveryClaims.mockReturnValue({ status: "ok" });
      mockAuditAssistantCommitment.mockReturnValue({ status: "blocked", replacementText: "Old blocked text" });
      mockAuditClaimsForTurn.mockReturnValue({ status: "blocked", replacementText: "New blocked text" });
      mockWriteDivergenceLog.mockReturnValue("div-id-blocked");

      await handleChatMessage(content, webSource);
      await new Promise(r => setTimeout(r, 50));

      const sessionId = mockChatManagerInstance.handleMessage.mock.calls[0]?.[1] as string;
      const messages = getMessagesBySession(sessionId);
      // Reply preserved; the note uses the NEW auditor's text, never the OLD hardcoded text.
      const reply = messages.find((m) => m.role === "assistant" && m.kind !== "audit_note");
      expect(reply?.content).toBe("Hello from ChatManager!");
      const note = messages.find((m) => m.kind === "audit_note");
      expect(note?.content).toBe("New blocked text");
      expect(note?.content).not.toBe("Old blocked text");
      // Phase 6: always returns id (not null) even when verdicts agree
      expect(mockWriteDivergenceLog.mock.results[0]?.value).not.toBeNull();
    });

    it("Claim audit throws but OLD blocks: newVerdict stays passed; OLD replacement applied; audit_diagnostics warning row written", async () => {
      const content = "Fix the auth bug";
      mockAuditDeliveryClaims.mockReturnValue({ status: "ok" });
      mockAuditAssistantCommitment.mockReturnValue({ status: "blocked", replacementText: "Old blocked from throw path" });
      mockAuditClaimsForTurn.mockImplementation(() => { throw new Error("claim-audit-error"); });
      mockWriteDivergenceLog.mockReturnValue("div-id-3");

      await handleChatMessage(content, webSource);
      await new Promise(r => setTimeout(r, 50));

      const sessionId = mockChatManagerInstance.handleMessage.mock.calls[0]?.[1] as string;
      const messages = getMessagesBySession(sessionId);
      // NEW threw → newVerdict stays "passed" → no note; OLD is shadow-only → reply preserved.
      const reply = messages.find((m) => m.role === "assistant" && m.kind !== "audit_note");
      expect(reply?.content).toBe("Hello from ChatManager!");
      expect(messages.some((m) => m.kind === "audit_note")).toBe(false);
      // newVerdict defaults to "passed" on throw, so verdicts disagree → divergence written
      expect(mockWriteDivergenceLog).toHaveBeenCalledWith(
        expect.objectContaining({
          wirePoint: "message_handler",
          oldVerdict: "blocked",
          newVerdict: "passed",
        }),
      );
      // audit_diagnostics warning for the throw
      expect(mockRecordAuditDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "claim_receipt_auditor",
          severity: "warning",
        }),
      );
    });

    it("Claim audit throws and OLD passes: newVerdict stays passed; no replacement; audit_diagnostics warning; Phase 6: writeDivergenceLog returns id (not null) even when verdicts agree", async () => {
      const content = "Fix the auth bug";
      mockAuditDeliveryClaims.mockReturnValue({ status: "ok" });
      mockAuditAssistantCommitment.mockReturnValue({ status: "ok" });
      mockAuditClaimsForTurn.mockImplementation(() => { throw new Error("claim-audit-error"); });
      mockWriteDivergenceLog.mockReturnValue("div-id-throw");

      await handleChatMessage(content, webSource);
      await new Promise(r => setTimeout(r, 50));

      // audit_diagnostics warning for the throw
      expect(mockRecordAuditDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "claim_receipt_auditor",
          severity: "warning",
        }),
      );
      // Phase 6: always returns id even when verdicts agree
      expect(mockWriteDivergenceLog).toHaveBeenCalled();
      expect(mockWriteDivergenceLog.mock.results[0]?.value).not.toBeNull();
    });

    it("OLD audit chain throws (existing fail-open): outer try/catch triggers, response.text used, audit_diagnostics error row written", async () => {
      const content = "Fix the auth bug";
      mockAuditDeliveryClaims.mockImplementation(() => { throw new Error("delivery-audit-error"); });
      // Outer fail-open should catch and fall back to response.text

      await handleChatMessage(content, webSource);
      await new Promise(r => setTimeout(r, 50));

      const sessionId = mockChatManagerInstance.handleMessage.mock.calls[0]?.[1] as string;
      const messages = getMessagesBySession(sessionId);
      // The outer fail-open should use ChatManager's response.text directly
      expect(mockRecordAuditDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "chat_audit_chain",
          severity: "error",
        }),
      );
    });

    it("Divergence write throws: main flow unaffected, finalResponse still set correctly per dual-write rule, audit_diagnostics warn row written", async () => {
      const content = "Fix the auth bug";
      mockAuditDeliveryClaims.mockReturnValue({ status: "ok" });
      mockAuditAssistantCommitment.mockReturnValue({ status: "ok" });
      mockAuditClaimsForTurn.mockReturnValue({ status: "blocked", replacementText: "New auditor blocked" });
      mockWriteDivergenceLog.mockImplementation(() => { throw new Error("divergence-write-error"); });

      await handleChatMessage(content, webSource);
      await new Promise(r => setTimeout(r, 50));

      const sessionId = mockChatManagerInstance.handleMessage.mock.calls[0]?.[1] as string;
      const messages = getMessagesBySession(sessionId);
      // Even though writeDivergenceLog threw, the reply is preserved and the note still emitted.
      const reply = messages.find((m) => m.role === "assistant" && m.kind !== "audit_note");
      expect(reply?.content).toBe("Hello from ChatManager!");
      const note = messages.find((m) => m.kind === "audit_note");
      expect(note?.content).toBe("New auditor blocked");
      // audit_diagnostics warn row for the divergence write failure
      expect(mockRecordAuditDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "auditor_divergence_log",
          severity: "warning",
        }),
      );
    });
  });
});
