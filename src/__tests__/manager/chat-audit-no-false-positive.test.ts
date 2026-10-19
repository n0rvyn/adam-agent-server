/**
 * Task 1-tests: Commitment-audit false-positive test
 *
 * Pins two behaviors:
 * 1. A turn that triggered a real template_execution mutation — with the receipt written
 *    under the turn's own traceId (what Task 1-impl achieves via the traced wrapper) —
 *    must produce audit status="passed".
 *    Pre-fix: the receipt lands under the frozen ctor-trace (because withTrace from
 *    LiveSession construction time is what ALS returns inside the handler); calling
 *    auditClaimsForTurn(turnTrace) finds NO receipt → "blocked" (false positive). FAIL.
 *    Post-fix: receipt lands under turnTrace → "passed". PASS.
 * 2. A turn that genuinely ran no tool must still produce status="blocked" (true-hallucination
 *    detection must remain intact). This case passes both before and after the fix.
 *
 * Expected result BEFORE Task 1-impl:
 *   - Case 1: FAIL — no receipt under turnTrace (it's under ctor-trace); text triggers
 *     completion-language detector; auditor returns "blocked" but test expects "passed".
 *   - Case 2: PASS — "播客已发送" triggers completion language; no receipt → "blocked".
 *
 * Expected result AFTER Task 1-impl: both PASS.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
afterAll(() => cleanup());

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock SDK so buildTools works in tests
const { mockTool, mockCreateSdkMcpServer } = vi.hoisted(() => {
  const mockTool = vi.fn().mockImplementation(
    (name: string, _desc: string, _schema: unknown, handler: unknown) => ({ name, handler }),
  );
  const mockCreateSdkMcpServer = vi.fn().mockImplementation((cfg: { tools: unknown }) => ({
    tools: cfg.tools,
  }));
  return { mockTool, mockCreateSdkMcpServer };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({ defaults: {} }),
  updateMutableConfig: vi.fn(),
}));
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
}));
vi.mock("../../lib/task-dispatch.js", () => ({
  createTaskWithAdmission: vi.fn(),
}));
vi.mock("../../manager/skill-registry.js", () => ({
  SkillRegistry: { query: vi.fn().mockReturnValue([]), match: vi.fn().mockReturnValue([]) },
}));
vi.mock("../../store/role-workspace.js", async () => {
  const actual = await vi.importActual<typeof import("../../store/role-workspace.js")>("../../store/role-workspace.js");
  return { ...actual, getRoleWorkspacePath: vi.fn(() => "/tmp/test-role-ws") };
});
vi.mock("../../lib/artifact-storage.js", () => ({
  publishBlob: vi.fn().mockReturnValue({ blobPath: "/tmp/blob", sizeBytes: 1 }),
  unlinkSourceFileStrict: vi.fn(),
  unlinkBlob: vi.fn(),
  fetchBlob: vi.fn(),
  validatePathInWorkspace: vi.fn(),
}));
vi.mock("../../store/audit-diagnostics.js", () => ({
  recordAuditDiagnostic: vi.fn().mockResolvedValue(undefined),
}));

import { createAdamTools } from "../../manager/adam-tools.js";
import { auditClaimsForTurn } from "../../audit/claim-receipt-auditor.js";
import { withTrace } from "../../lib/trace-context.js";
import { v4 as uuidv4 } from "uuid";

beforeEach(() => {
  clearTestDb();
  mockTool.mockClear();
  mockCreateSdkMcpServer.mockClear();
});

describe("commitment-audit: false-positive on real execution", () => {
  it("status=passed when receipt is written under the turn trace via the traced-tool-wrapper", async () => {
    // The turnTraceHolder simulates what Task 1-impl wires into buildTools.
    // Pre-fix: this holder is IGNORED (getTurnTraceId not in AdamToolsRuntimeContext),
    //   so the tool handler runs under the frozen ctor-trace ALS context.
    // Post-fix: the tool wrapper calls withTrace(turnTraceHolder.id) around the handler,
    //   so writeMutationReceipt sees the correct turnTrace.
    const turnTraceHolder: { id: string | undefined } = { id: undefined };
    const ctorTrace = `ctor-${uuidv4()}`;
    const turnTrace = `${uuidv4()}`;

    // Build adam-tools inside ctor-trace context (mimics prod LiveSession construction)
    let adamToolsInstance!: ReturnType<typeof createAdamTools>;
    withTrace(ctorTrace, "chat", () => {
      adamToolsInstance = createAdamTools({
        getTurnTraceId: () => turnTraceHolder.id,
      } as Parameters<typeof createAdamTools>[0]);
    });

    // Extract create_delivery_rule handler (writes a mutation receipt)
    const toolHandlers = new Map<string, (args: unknown) => Promise<unknown>>();
    for (const call of mockTool.mock.calls) {
      const [name, , , handler] = call as [string, string, unknown, (args: unknown) => Promise<unknown>];
      toolHandlers.set(name, handler);
    }

    const createDeliveryRuleHandler = toolHandlers.get("create_delivery_rule");
    if (!createDeliveryRuleHandler) {
      throw new Error("create_delivery_rule handler not found in buildTools output");
    }

    // Simulate a turn: set turnTraceHolder.id = turnTrace, then invoke the handler.
    // Pre-fix: getTurnTraceId is unknown to buildTools, handler runs in ALS ctor-trace context.
    //   → writeMutationReceipt sees getCurrentTraceId() = ctorTrace → receipt under ctorTrace.
    // Post-fix: the traced wrapper does withTrace(turnTrace) before calling handler.
    //   → receipt under turnTrace.
    turnTraceHolder.id = turnTrace;
    await createDeliveryRuleHandler({
      eventType: "task_complete",
      matchCriteria: {},
      target: { type: "session", sessionId: "s-test" },
    });

    // Audit with the turn trace + text containing "已发送" (completion language)
    const result = auditClaimsForTurn({
      traceId: turnTrace,
      sessionId: "s-audit-test",
      text: `规则已创建并已发送确认。`,
    });

    // Post-fix: receipt is under turnTrace → found → claim verified → "passed"
    // Pre-fix: receipt is under ctorTrace → not found for turnTrace → completion-language stub → "blocked"
    expect(result.status).toBe("passed");
  });

  it("status=blocked when NO receipt exists under the turn trace (true hallucination still caught)", () => {
    const turnTrace = `${uuidv4()}`;

    // Deliberately write NO receipt — model claimed it sent something but didn't
    // Use completion language that triggers the detector (e.g. "已发送")
    const result = auditClaimsForTurn({
      traceId: turnTrace,
      sessionId: "s-audit-test",
      text: `播客已发送给您。`,
    });

    // The audit detects "已发送" as a completion claim (verb=send) with no matching receipt
    // → status="blocked" — true hallucinations are still flagged
    expect(result.status).toBe("blocked");
  });
});
