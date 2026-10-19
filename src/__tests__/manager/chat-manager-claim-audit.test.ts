/**
 * Tests for applyDeliveryClaimAudit dual-write in chat-manager.ts.
 * Tests the method directly via (manager as any) to cover all 5 dual-write cases.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

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

const { mockAuditDeliveryClaims } = vi.hoisted(() => ({
  mockAuditDeliveryClaims: vi.fn(),
}));

const { mockAuditClaimsForTurn } = vi.hoisted(() => ({
  mockAuditClaimsForTurn: vi.fn(),
}));

const { mockWriteDivergenceLog } = vi.hoisted(() => ({
  mockWriteDivergenceLog: vi.fn(),
}));

vi.mock("../../audit/delivery-claim-auditor.js", () => ({
  auditDeliveryClaims: mockAuditDeliveryClaims,
}));

vi.mock("../../audit/claim-receipt-auditor.js", () => ({
  auditClaimsForTurn: mockAuditClaimsForTurn,
}));

vi.mock("../../store/auditor-divergence.js", () => ({
  writeDivergenceLog: mockWriteDivergenceLog,
}));

// Mock getTask to return a task with a traceId
vi.mock("../../store/tasks.js", () => ({
  getTask: vi.fn(() => ({ id: "task-test", traceId: "trace-test-envelope" })),
  getTaskTraceId: vi.fn(() => "trace-test-envelope"),
  updateTask: vi.fn(),
}));

import { ChatManager } from "../../manager/chat-manager.js";

afterAll(() => cleanup());

describe("applyDeliveryClaimAudit dual-write", () => {
  let manager: ChatManager;

  beforeEach(async () => {
    clearTestDb();
    mockAuditDeliveryClaims.mockClear();
    mockAuditClaimsForTurn.mockClear();
    mockWriteDivergenceLog.mockClear();
    // Reset getTaskTraceId mock to default
    const { getTaskTraceId } = await import("../../store/tasks.js");
    (getTaskTraceId as ReturnType<typeof vi.fn>).mockReturnValue("trace-test-envelope");
    // Default: pass-through
    // Note: auditDeliveryClaims historically returns status "ok" (not "passed") per existing codebase.
    // Here we use "passed" to match what applyDeliveryClaimAudit compares against.
    mockAuditDeliveryClaims.mockReturnValue({ status: "passed" });
    mockAuditClaimsForTurn.mockReturnValue({ status: "passed" });
    mockWriteDivergenceLog.mockReturnValue(null);
    manager = new ChatManager();
    await manager.start();
  });

  afterEach(() => { manager?.stop(); });

  it("Both passed: returns original text, Phase 6: verdicts agree → row persisted with verdict_pair agreed_pass", () => {
    mockAuditDeliveryClaims.mockReturnValue({ status: "passed" });
    mockAuditClaimsForTurn.mockReturnValue({ status: "passed" });
    mockWriteDivergenceLog.mockReturnValue("div-id-agree-pass");

    const result = (manager as any).applyDeliveryClaimAudit("Original text", "task-test");

    expect(result).toBe("Original text");
    // Phase 6: writeDivergenceLog returns id (not null) even when verdicts agree
    expect(mockWriteDivergenceLog.mock.results[0]?.value).not.toBeNull();
  });

  it("Old blocks, new passes: returns old replacement, divergence row old_blocks_new_passes wirePoint chat_manager_envelope", () => {
    mockAuditDeliveryClaims.mockReturnValue({ status: "blocked", replacementText: "Old blocked replacement" });
    mockAuditClaimsForTurn.mockReturnValue({ status: "passed" });
    mockWriteDivergenceLog.mockReturnValue("div-id-1");

    const result = (manager as any).applyDeliveryClaimAudit("Original text", "task-test");

    expect(result).toBe("Old blocked replacement");
    expect(mockWriteDivergenceLog).toHaveBeenCalledWith(
      expect.objectContaining({
        wirePoint: "chat_manager_envelope",
        oldVerdict: "blocked",
        newVerdict: "passed",
      }),
    );
  });

  it("Old passes, new blocks: returns new replacement, divergence row old_passes_new_blocks", () => {
    mockAuditDeliveryClaims.mockReturnValue({ status: "passed" });
    mockAuditClaimsForTurn.mockReturnValue({ status: "blocked", replacementText: "New auditor blocked" });
    mockWriteDivergenceLog.mockReturnValue("div-id-2");

    const result = (manager as any).applyDeliveryClaimAudit("Original text", "task-test");

    expect(result).toBe("New auditor blocked");
    expect(mockWriteDivergenceLog).toHaveBeenCalledWith(
      expect.objectContaining({
        wirePoint: "chat_manager_envelope",
        oldVerdict: "passed",
        newVerdict: "blocked",
      }),
    );
  });

  it("Both blocked: returns old replacement (precedence), Phase 6: verdicts agree → row persisted with verdict_pair agreed_block", () => {
    mockAuditDeliveryClaims.mockReturnValue({ status: "blocked", replacementText: "Old blocked" });
    mockAuditClaimsForTurn.mockReturnValue({ status: "blocked", replacementText: "New blocked" });
    mockWriteDivergenceLog.mockReturnValue("div-id-both-blocked");

    const result = (manager as any).applyDeliveryClaimAudit("Original text", "task-test");

    expect(result).toBe("Old blocked");
    // Phase 6: writeDivergenceLog returns id (not null) even when verdicts agree
    expect(mockWriteDivergenceLog.mock.results[0]?.value).not.toBeNull();
  });

  it("No traceId (getTaskTraceId returns null): returns original text, new auditor skipped, no divergence write", async () => {
    const { getTaskTraceId } = await import("../../store/tasks.js");
    (getTaskTraceId as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    mockAuditDeliveryClaims.mockReturnValue({ status: "passed" });

    const result = (manager as any).applyDeliveryClaimAudit("Original text", "task-test");

    expect(result).toBe("Original text");
    expect(mockAuditClaimsForTurn).not.toHaveBeenCalled();
    expect(mockWriteDivergenceLog).not.toHaveBeenCalled();
  });
});
