/**
 * L2 pre-flight gate (Path β) — blocks quantitative delivery-completion claims
 * that were not preceded by a query_delivery_history / query_execution_status call.
 *
 * Task 9 of Phase C: chatmanager-truth plan.
 */
import { detectDeliveryQuantitativeClaim } from "./completion-language-detector.js";
import { hasAnyToolCallInTurn } from "../store/chat-tool-calls.js";

export const QUERY_TOOL_NAMES = ["query_delivery_history", "query_execution_status"] as const;

/**
 * Bracketed re-plan reminder injected into ChatManager when the gate triggers.
 * Passed through callChatManagerForChat — NOT written to chat_messages as a user row.
 * DP-Plan-1 Option A.
 */
export const GATE_RETRY_PROMPT =
  "[System pre-flight gate] 你的上一条回答触发了 pre-flight gate — 包含 delivery 完成性断言但本 turn 未调用 query_delivery_history 或 query_execution_status。请先调用相应的查询工具获取真实投递记录，再基于查询结果重新作答。";

/**
 * Fixed fallback text emitted when the gate retry also fails twice.
 * Phase 6 introspection (assistant_claim_audits + auditor_divergence_log) still runs
 * even when the gate blocks the response.
 */
export const GATE_FALLBACK_TEXT =
  "我现在无法验证投递状态，无法回答这个问题。请稍后再问，或直接查看后台 delivery log。";

export interface GateCheckArgs {
  traceId: string;
  text: string;
  sessionId: string;
}

export interface GateCheckResult {
  shouldRetry: boolean;
  reason?: string;
}

/**
 * Check whether the L2 pre-flight gate should block and retry the assistant text.
 *
 * Algorithm:
 * 1. Return shouldRetry=false when traceId is empty (no enforcement scope).
 * 2. Call detectDeliveryQuantitativeClaim — return shouldRetry=false if no claim detected.
 * 3. Call hasAnyToolCallInTurn — return shouldRetry=false if query_* was already called this turn.
 * 4. Otherwise return shouldRetry=true with reason.
 *
 * Fail-open: any exception (detector throw, DB error) returns shouldRetry=false
 * and records an audit_diagnostics row. Consistent with DP-Plan-2 Option A and the
 * existing chat_audit_chain fail-open pattern at message-handler.ts:335-349.
 */
export function checkPreflightGate(args: GateCheckArgs): GateCheckResult {
  if (!args.traceId) {
    return { shouldRetry: false };
  }

  let claimResult: ReturnType<typeof detectDeliveryQuantitativeClaim>;
  try {
    claimResult = detectDeliveryQuantitativeClaim(args.text);
  } catch (detectorErr) {
    void recordAuditDiagnosticSafely({
      source: "preflight_gate",
      severity: "warning",
      sourceId: args.sessionId,
      message: `detectDeliveryQuantitativeClaim threw: ${detectorErr instanceof Error ? detectorErr.message : String(detectorErr)}`,
    });
    return { shouldRetry: false };
  }

  if (!claimResult.detected) {
    return { shouldRetry: false };
  }

  let alreadyQueried: boolean;
  try {
    alreadyQueried = hasAnyToolCallInTurn(args.traceId, [...QUERY_TOOL_NAMES]);
  } catch {
    // DB error — fail-open per DP-Plan-2 A
    return { shouldRetry: false };
  }

  if (alreadyQueried) {
    return { shouldRetry: false };
  }

  const pattern = claimResult.matches[0]?.pattern ?? "unknown";
  const evidence = claimResult.matches[0]?.evidenceSpan ?? "";
  const reason = `quantitative-claim:${pattern} evidence:'${evidence.slice(0, 80)}'`;

  return { shouldRetry: true, reason };
}

async function recordAuditDiagnosticSafely(diagnostic: {
  source: string;
  severity: string;
  sourceId: string;
  message: string;
}): Promise<void> {
  try {
    const { recordAuditDiagnostic } = await import("../store/audit-diagnostics.js");
    recordAuditDiagnostic(diagnostic as Parameters<typeof recordAuditDiagnostic>[0]);
  } catch {
    // swallow — fail-open is the gate's guarantee
  }
}
