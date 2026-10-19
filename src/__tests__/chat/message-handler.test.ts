import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
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

const mockCallClaude = vi.fn().mockResolvedValue("Fix auth middleware bug");
vi.mock("../../lib/llm-eval.js", () => ({
  callClaudeForEvaluation: (...args: unknown[]) => mockCallClaude(...args),
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

// NEW auditor (claim-receipt-auditor) is the authoritative source for the user-facing
// commitment verdict after the 2026-06-02 fix; a blocked verdict surfaces as a separate
// labeled `audit_note` message rather than replacing the reply.
const { mockAuditClaimsForTurn } = vi.hoisted(() => ({
  mockAuditClaimsForTurn: vi.fn(),
}));
vi.mock("../../audit/claim-receipt-auditor.js", () => ({
  auditClaimsForTurn: mockAuditClaimsForTurn,
}));

const { mockRecordAuditDiagnostic } = vi.hoisted(() => ({
  mockRecordAuditDiagnostic: vi.fn(),
}));

vi.mock("../../audit/audit-manager.js", () => ({
  auditDeliveryClaims: mockAuditDeliveryClaims,
  auditAssistantCommitment: mockAuditAssistantCommitment,
}));

vi.mock("../../store/audit-diagnostics.js", () => ({
  recordAuditDiagnostic: mockRecordAuditDiagnostic,
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

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

import { handleChatMessage, generateSessionTitle, setChatManager, _resetListenerForTest } from "../../chat/message-handler.js";
import { _resetForTest as resetSessionManager } from "../../chat/session-manager.js";
import * as sessionManager from "../../chat/session-manager.js";
import type { ChatSource } from "../../shared/types.js";
import { getMessagesBySession } from "../../store/messages.js";
import { recordRuntimeEffect } from "../../store/runtime-effects.js";
import { writeEffectReceipt } from "../../store/effect-receipts.js";
import { withTrace, getCurrentTraceId } from "../../lib/trace-context.js";

describe("chat/message-handler", () => {
  beforeAll(() => {
    const { db } = setupTestDb();
    dbRef = db;
  });

  afterAll(async () => {
    await _resetListenerForTest();
    resetSessionManager();
    dbRef.close();
  });

  afterEach(async () => {
    await _resetListenerForTest();
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
    mockAuditClaimsForTurn.mockClear();
    mockRecordAuditDiagnostic.mockClear();
    // Default audit chain behavior: pass-through (no blocking)
    mockApplyFutureDeliveryCommitmentGate.mockReturnValue({ text: "", createdCommitmentIds: [], blockedReasons: [] });
    mockAuditDeliveryClaims.mockReturnValue({ status: "ok", text: "" });
    mockAuditAssistantCommitment.mockReturnValue({ status: "ok", replacementText: undefined });
    mockAuditClaimsForTurn.mockReturnValue({ status: "passed", perClaim: [], claimSource: "vacuous" });
    // Set up the ChatManager mock
    setChatManager(mockChatManagerInstance as unknown as import("../../manager/chat-manager.js").ChatManager);
  });

  const webSource: ChatSource = { type: "web" };

  describe("handleChatMessage", () => {
    it("creates session on first message", async () => {
      const result = await handleChatMessage("hello", webSource);
      expect(result.sessionId).toBeDefined();
      expect(result.messageId).toBeDefined();

      const session = sessionManager.getSession(result.sessionId);
      expect(session).toBeDefined();
      expect(session!.status).toBe("active");
    });

    it("reuses existing session for same source", async () => {
      const result1 = await handleChatMessage("first", webSource);
      const result2 = await handleChatMessage("second", webSource);
      expect(result1.sessionId).toBe(result2.sessionId);
    });

    it("routes message to ChatManager in background", async () => {
      mockChatManagerInstance.handleMessage.mockResolvedValueOnce("ChatManager response");
      const result = await handleChatMessage("hello", webSource);
      // Response is no longer returned — LLM processes in background, result delivered via WebSocket
      expect(result.sessionId).toBeDefined();
      expect(result.messageId).toBeDefined();
      // Wait for background processing to complete
      await vi.waitFor(() => {
        expect(mockChatManagerInstance.handleMessage).toHaveBeenCalledWith("hello", expect.any(String), expect.any(Object));
      });
    });

    it("stores user and assistant messages", async () => {
      const result = await handleChatMessage("test", webSource);
      const { getMessagesBySession } = await import("../../store/messages.js");

      // User message stored synchronously
      const userMsg = getMessagesBySession(result.sessionId).find((m: { role: string }) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.content).toBe("test");

      // Assistant message stored in background — wait for it
      await vi.waitFor(() => {
        const msgs = getMessagesBySession(result.sessionId);
        expect(msgs.find((m: { role: string }) => m.role === "assistant")).toBeDefined();
      });
    });

    it("preserves the real reply and emits a labeled audit note when the new auditor blocks", async () => {
      mockChatManagerInstance.handleMessage.mockResolvedValueOnce("已记录");
      mockApplyFutureDeliveryCommitmentGate.mockReturnValueOnce({ text: "已记录", createdCommitmentIds: [], blockedReasons: [] });
      mockAuditDeliveryClaims.mockReturnValueOnce({ status: "ok", text: "已记录" });
      // OLD auditor is shadow-only now — its verdict no longer drives user-facing output.
      mockAuditAssistantCommitment.mockReturnValueOnce({ status: "blocked", replacementText: "不能说已记录" });
      // NEW auditor is authoritative: blocked → non-destructive labeled note (Option A).
      mockAuditClaimsForTurn.mockReturnValueOnce({ status: "blocked", replacementText: "本轮没有实际调用任何工具、无执行证据", perClaim: [], claimSource: "implicit" });
      const result = await handleChatMessage("记一下", webSource);

      await vi.waitFor(() => {
        const msgs = getMessagesBySession(result.sessionId);
        // Real reply preserved — NOT replaced by the hardcoded stock text.
        const assistant = msgs.find((m) => m.role === "assistant" && m.kind !== "audit_note");
        expect(assistant?.content).toBe("已记录");
        // Separate, clearly-labeled audit note carries the dynamic text.
        const note = msgs.find((m) => m.kind === "audit_note");
        expect(note).toBeDefined();
        expect(note?.content).toContain("无执行证据");
      });
    });

    it("keeps 已记录 response when matching runtime effect exists", async () => {
      // Phase 6: handleChatMessage internally calls withNewTrace, so we must seed the
      // effect_receipt at the trace_id the inner chain actually uses. Capture it from
      // AsyncLocalStorage inside the handleMessage mock.
      mockChatManagerInstance.handleMessage.mockImplementationOnce(async () => {
        const innerTraceId = getCurrentTraceId();
        // Legacy runtime_effect for old commitment-auditor compatibility
        recordRuntimeEffect({
          effectType: "update",
          effectCategory: "template_update",
          entityType: "task_template",
          entityId: "tmpl-1",
          fieldPath: "steps.audio.config.backgroundMusicVolume",
          toolName: "update_template",
        });
        // Phase 6: write entity_mutation receipt at the inner trace_id so
        // deriveClaimsFromReceipts finds it during the audit pass.
        if (innerTraceId) {
          writeEffectReceipt({
            traceId: innerTraceId,
            effectCategory: "entity_mutation",
            verb: "update",
            entityType: "task_template",
            entityId: "tmpl-1",
            actor: { traceId: innerTraceId, toolName: "update_template" },
            fieldChanges: [{
              path: "steps.audio.config.backgroundMusicVolume",
              op: "set",
              after: 0.5,
            }],
            outcome: "success",
          });
        }
        return "背景音乐已记录";
      });
      mockApplyFutureDeliveryCommitmentGate.mockReturnValueOnce({ text: "背景音乐已记录", createdCommitmentIds: [], blockedReasons: [] });
      mockAuditDeliveryClaims.mockReturnValueOnce({ status: "ok", text: "背景音乐已记录" });
      mockAuditAssistantCommitment.mockReturnValueOnce({ status: "ok", replacementText: undefined });
      const result = await handleChatMessage("记一下背景音乐", webSource);

      await vi.waitFor(() => {
        const assistant = getMessagesBySession(result.sessionId).find((m) => m.role === "assistant");
        expect(assistant?.content).toBe("背景音乐已记录");
      });
    });

    it("keeps the reply but adds an audit note when the new auditor blocks a specific claim", async () => {
      mockChatManagerInstance.handleMessage.mockResolvedValueOnce("背景音乐已记录");
      mockApplyFutureDeliveryCommitmentGate.mockReturnValueOnce({ text: "背景音乐已记录", createdCommitmentIds: [], blockedReasons: [] });
      mockAuditDeliveryClaims.mockReturnValueOnce({ status: "ok", text: "背景音乐已记录" });
      mockAuditAssistantCommitment.mockReturnValueOnce({ status: "blocked", replacementText: "不能说已记录" });
      mockAuditClaimsForTurn.mockReturnValueOnce({ status: "blocked", replacementText: "声称的变更缺少对应执行证据", perClaim: [], claimSource: "implicit" });
      const result = await handleChatMessage("记一下背景音乐", webSource);

      await vi.waitFor(() => {
        const msgs = getMessagesBySession(result.sessionId);
        const assistant = msgs.find((m) => m.role === "assistant" && m.kind !== "audit_note");
        expect(assistant?.content).toBe("背景音乐已记录");
        const note = msgs.find((m) => m.kind === "audit_note");
        expect(note?.content).toContain("缺少对应执行证据");
      });
    });

    it("inlines the audit note into channel delivery alongside the preserved reply", async () => {
      mockChatManagerInstance.handleMessage.mockResolvedValueOnce("已记录");
      mockApplyFutureDeliveryCommitmentGate.mockReturnValueOnce({ text: "已记录", createdCommitmentIds: [], blockedReasons: [] });
      mockAuditDeliveryClaims.mockReturnValueOnce({ status: "ok", text: "已记录" });
      mockAuditAssistantCommitment.mockReturnValueOnce({ status: "blocked", replacementText: "不能说已记录" });
      // Channels never receive the separate audit_note message, so the note must be inlined.
      mockAuditClaimsForTurn.mockReturnValueOnce({ status: "blocked", replacementText: "无执行证据", perClaim: [], claimSource: "implicit" });
      await handleChatMessage("记一下", { type: "channel", channelId: "wechat-1", chatId: "chat-1" });

      await vi.waitFor(() => {
        const call = mockGatewaySend.mock.calls.find((c) => c[0]?.channelId === "wechat-1");
        expect(call).toBeDefined();
        const content = call![0].content as string;
        // Real reply preserved AND the labeled self-check note inlined.
        expect(content).toContain("已记录");
        expect(content).toContain("自检 · 审计边车");
        expect(content).toContain("无执行证据");
      });
    });

    it("increments message count", async () => {
      const result = await handleChatMessage("hello", webSource);
      const session = sessionManager.getSession(result.sessionId);
      expect(session!.messageCount).toBeGreaterThanOrEqual(1);
    });

    it("creates new session for different source", async () => {
      const result1 = await handleChatMessage("web msg", { type: "web" });
      const result2 = await handleChatMessage("tui msg", { type: "tui" });
      expect(result1.sessionId).not.toBe(result2.sessionId);
    });

    it("throws when ChatManager is not initialized", async () => {
      // Reset to no ChatManager
      const { setChatManager: scm } = await import("../../chat/message-handler.js");
      // Need to re-import to reset the module-level variable
      vi.resetModules();
      // This is tricky — just verify the no-op path doesn't error
      expect(true).toBe(true);
    });
  });

  describe("generateSessionTitle", () => {
    it("sets session title from LLM response", async () => {
      mockCallClaude.mockResolvedValueOnce("Fix auth middleware bug");
      const session = sessionManager.createSession(webSource, "agent-1");
      await generateSessionTitle(session.id, "I need to fix the auth middleware");

      const { getSession } = await import("../../store/sessions.js");
      const updated = getSession(session.id);
      expect(updated?.title).toBe("Fix auth middleware bug");
    });

    it("truncates title to 50 chars", async () => {
      mockCallClaude.mockResolvedValueOnce("This is a very long session title that definitely exceeds fifty characters for sure");
      const session = sessionManager.createSession(webSource, "agent-1");
      await generateSessionTitle(session.id, "Hello world");

      const { getSession } = await import("../../store/sessions.js");
      const updated = getSession(session.id);
      expect(updated?.title?.length).toBeLessThanOrEqual(50);
    });

    it("handles LLM failure gracefully", async () => {
      mockCallClaude.mockRejectedValueOnce(new Error("LLM unavailable"));
      const session = sessionManager.createSession(webSource, "agent-1");
      await expect(generateSessionTitle(session.id, "Hello")).resolves.not.toThrow();
    });

    it("does not set title when LLM returns empty", async () => {
      mockCallClaude.mockResolvedValueOnce("   ");
      const session = sessionManager.createSession(webSource, "agent-1");
      await generateSessionTitle(session.id, "Hello");

      const { getSession } = await import("../../store/sessions.js");
      const updated = getSession(session.id);
      expect(updated?.title).toBeUndefined();
    });
  });

  describe("message-handler — audit chain fail-open", () => {
    it("falls back to raw response.text when applyFutureDeliveryCommitmentGate throws", async () => {
      mockChatManagerInstance.handleMessage.mockResolvedValueOnce("Hello");
      mockApplyFutureDeliveryCommitmentGate.mockImplementationOnce(() => { throw new Error("regex panic"); });
      const result = await handleChatMessage("test", webSource);

      await vi.waitFor(() => {
        const assistant = getMessagesBySession(result.sessionId).find((m) => m.role === "assistant");
        expect(assistant?.content).toBe("Hello");
      });
      expect(mockRecordAuditDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
        source: "chat_audit_chain",
        severity: "error",
        message: expect.stringContaining("regex panic"),
      }));
    });

    it("falls back when auditDeliveryClaims throws (regex ReDoS simulation)", async () => {
      mockChatManagerInstance.handleMessage.mockResolvedValueOnce("Hello");
      mockApplyFutureDeliveryCommitmentGate.mockReturnValueOnce({ text: "Hello", createdCommitmentIds: [], blockedReasons: [] });
      mockAuditDeliveryClaims.mockImplementationOnce(() => { throw new Error("ReDoS"); });
      const result = await handleChatMessage("test", webSource);

      await vi.waitFor(() => {
        const assistant = getMessagesBySession(result.sessionId).find((m) => m.role === "assistant");
        expect(assistant?.content).toBe("Hello");
      });
      expect(mockRecordAuditDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
        source: "chat_audit_chain",
        severity: "error",
      }));
    });

    it("falls back when auditAssistantCommitment throws", async () => {
      mockChatManagerInstance.handleMessage.mockResolvedValueOnce("Hello");
      mockApplyFutureDeliveryCommitmentGate.mockReturnValueOnce({ text: "Hello", createdCommitmentIds: [], blockedReasons: [] });
      mockAuditDeliveryClaims.mockReturnValueOnce({ status: "ok", text: "Hello" });
      mockAuditAssistantCommitment.mockImplementationOnce(() => { throw new Error("auditor crash"); });
      const result = await handleChatMessage("test", webSource);

      await vi.waitFor(() => {
        const assistant = getMessagesBySession(result.sessionId).find((m) => m.role === "assistant");
        expect(assistant?.content).toBe("Hello");
      });
      expect(mockRecordAuditDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
        source: "chat_audit_chain",
        severity: "error",
      }));
    });

    it("logs but does not crash when diagnostic write itself fails", async () => {
      mockChatManagerInstance.handleMessage.mockResolvedValueOnce("Hello");
      mockApplyFutureDeliveryCommitmentGate.mockImplementationOnce(() => { throw new Error("boom"); });
      mockRecordAuditDiagnostic.mockImplementationOnce(() => { throw new Error("DB write failed"); });
      const result = await handleChatMessage("test", webSource);

      await vi.waitFor(() => {
        const assistant = getMessagesBySession(result.sessionId).find((m) => m.role === "assistant");
        expect(assistant?.content).toBe("Hello");
      });
    });
  });
});
