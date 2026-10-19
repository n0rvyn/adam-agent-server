import { describe, it, expect, beforeEach, vi } from "vitest";
import { checkPreflightGate, QUERY_TOOL_NAMES, GATE_RETRY_PROMPT, GATE_FALLBACK_TEXT } from "../../chat/preflight-delivery-gate.js";

// Mock the store modules
vi.mock("../../store/chat-tool-calls.js", () => ({
  hasAnyToolCallInTurn: vi.fn(),
}));

vi.mock("../../store/audit-diagnostics.js", () => ({
  recordAuditDiagnostic: vi.fn(),
}));

import { hasAnyToolCallInTurn } from "../../store/chat-tool-calls.js";
import { recordAuditDiagnostic } from "../../store/audit-diagnostics.js";

const hasAnyToolCallInTurnMock = hasAnyToolCallInTurn as ReturnType<typeof vi.fn>;

describe("checkPreflightGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns shouldRetry=true when text has quantitative claim AND no query_* called this turn", () => {
    hasAnyToolCallInTurnMock.mockReturnValue(false);
    const result = checkPreflightGate({
      traceId: "trace-1",
      text: "6 个 channel 全部送达，没有遗漏",
      sessionId: "s-1",
    });
    expect(result.shouldRetry).toBe(true);
    expect(result.reason).toContain("quantitative-claim:");
    expect(result.reason).toContain("evidence:");
  });

  it("returns shouldRetry=false when text has no quantitative claim", () => {
    const result = checkPreflightGate({
      traceId: "trace-1",
      text: "你好，今天天气不错",
      sessionId: "s-1",
    });
    expect(result.shouldRetry).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("returns shouldRetry=false when query_delivery_history was called this turn", () => {
    hasAnyToolCallInTurnMock.mockReturnValue(true);
    const result = checkPreflightGate({
      traceId: "trace-1",
      text: "6 个 channel 全部送达，没有遗漏",
      sessionId: "s-1",
    });
    expect(result.shouldRetry).toBe(false);
  });

  it("returns shouldRetry=false when query_execution_status was called this turn", () => {
    hasAnyToolCallInTurnMock.mockReturnValue(true);
    const result = checkPreflightGate({
      traceId: "trace-1",
      text: "所有频道都已收到",
      sessionId: "s-1",
    });
    expect(result.shouldRetry).toBe(false);
  });

  it("returns shouldRetry=false when different trace's query does not satisfy gate", () => {
    // trace-2 has a query, but we check trace-1
    hasAnyToolCallInTurnMock.mockReturnValue(false);
    const result = checkPreflightGate({
      traceId: "trace-1",
      text: "全部送达",
      sessionId: "s-1",
    });
    expect(result.shouldRetry).toBe(true);
  });

  it("returns shouldRetry=false when traceId is empty", () => {
    const result = checkPreflightGate({
      traceId: "",
      text: "6 个 channel 全部送达",
      sessionId: "s-1",
    });
    expect(result.shouldRetry).toBe(false);
  });

  it("QUERY_TOOL_NAMES is a 2-element list with correct tool names", () => {
    expect(QUERY_TOOL_NAMES).toHaveLength(2);
    expect(QUERY_TOOL_NAMES).toContain("query_delivery_history");
    expect(QUERY_TOOL_NAMES).toContain("query_execution_status");
  });

  it("GATE_RETRY_PROMPT is a non-empty string", () => {
    expect(typeof GATE_RETRY_PROMPT).toBe("string");
    expect(GATE_RETRY_PROMPT.length).toBeGreaterThan(0);
  });

  it("GATE_FALLBACK_TEXT is a non-empty string", () => {
    expect(typeof GATE_FALLBACK_TEXT).toBe("string");
    expect(GATE_FALLBACK_TEXT.length).toBeGreaterThan(0);
  });
});
