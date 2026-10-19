/**
 * Channel plan approval handler.
 * Routes plan approval requests to originating channels and parses replies.
 * Follows wechat-bridge permission.ts pattern (DP-004).
 */

import { getLogger } from "../lib/logger.js";
import { getChannel } from "../store/channels.js";
import { getOutboundGateway } from "../delivery/outbound-gateway.js";
import { getAuthKey } from "../server/auth-key.js";
import type { ExecutionPlan } from "../shared/types.js";

const log = getLogger("channels");

export interface PendingChannelApproval {
  planId: string;
  taskId: string;
  channelId: string;
  chatId: string;
  requestId: string; // same as planId (DP-001 Option A)
  timestamp: number;
  timeoutMs: number;
}

const pendingChannelApprovals = new Map<string, PendingChannelApproval>();
const TIMEOUT_DEFAULT_MS = 300_000; // 300s

// Platform supports interactive approval (keyboard or structured reply)
const INTERACTIVE_PLATFORMS = new Set(["telegram"]);

/**
 * Parse a channel reply into an approval decision.
 * Follows wechat-bridge permission.ts pattern (DP-004).
 * Accepts: "yes|y|是|允许 <requestId>", "no|n|否|拒绝 <requestId>"
 */
export function parseApprovalReply(
  text: string,
): { requestId: string; decision: "allow" | "deny" } | null {
  const trimmed = text.trim().toLowerCase();
  const match = trimmed.match(/^(yes|y|是|允许|no|n|否|拒绝)\s+(\S+)$/);
  if (!match) return null;

  const [, verdict, requestId] = match;
  const allow = ["yes", "y", "是", "允许"].includes(verdict);
  return { requestId, decision: allow ? "allow" : "deny" };
}

function supportsInteractiveApproval(channelId: string): boolean {
  const channel = getChannel(channelId);
  return channel ? INTERACTIVE_PLATFORMS.has(channel.platform) : false;
}

const RISK_EMOJI: Record<string, string> = { low: "\u{1f7e2}", medium: "\u{1f7e1}", high: "\u{1f534}" };
const RISK_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高" };

/**
 * Format an ExecutionPlan into human-readable text for channel messages.
 */
export function formatPlanForChannel(plan: ExecutionPlan): string {
  const lines: string[] = ["\u{1f512} 需要审批", ""];

  for (const step of plan.steps) {
    // Sandbox bypass: special description
    if (step.description.startsWith("Execute task without OS sandbox")) {
      lines.push("\u26a0\ufe0f 无沙箱执行 — 文件系统隔离未启用");
    } else {
      // Normal privilege escalation: description format is "ToolName: {JSON input}"
      const colonIdx = step.description.indexOf(": ");
      const toolName = colonIdx > 0 ? step.description.slice(0, colonIdx) : "Operation";
      lines.push(`操作: ${toolName}`);

      if (toolName === "Bash" && colonIdx > 0) {
        try {
          const input = JSON.parse(step.description.slice(colonIdx + 2));
          if (input.command) {
            const cmd = String(input.command).trim();
            lines.push(`命令: ${cmd.length > 120 ? cmd.slice(0, 117) + "..." : cmd}`);
          }
        } catch {
          const desc = step.description.slice(colonIdx + 2, colonIdx + 122);
          lines.push(`详情: ${desc}${step.description.length > colonIdx + 122 ? "..." : ""}`);
        }
      } else if (colonIdx > 0) {
        const desc = step.description.slice(colonIdx + 2, colonIdx + 122);
        lines.push(`详情: ${desc}${step.description.length > colonIdx + 122 ? "..." : ""}`);
      }
    }

    const emoji = RISK_EMOJI[step.riskLevel] ?? "\u{1f7e1}";
    const label = RISK_LABEL[step.riskLevel] ?? step.riskLevel;
    lines.push(`风险: ${emoji} ${label}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * Format and send an interactive plan approval request to a channel.
 */
export async function sendApprovalToChannel(
  channelId: string,
  chatId: string,
  planId: string,
  taskId: string,
  planSummary: string,
  timeoutMs = TIMEOUT_DEFAULT_MS,
): Promise<void> {
  const requestId = planId; // DP-001 Option A — full UUID, kept for API calls
  const shortId = requestId.slice(0, 8); // Human-typable prefix for channel display

  pendingChannelApprovals.set(shortId, {
    planId,
    taskId,
    channelId,
    chatId,
    requestId, // full UUID — needed for approve-plan API
    timestamp: Date.now(),
    timeoutMs,
  });

  const gateway = getOutboundGateway();
  const interactive = supportsInteractiveApproval(channelId);

  if (interactive) {
    const content = `${planSummary}\n\n`;
    await gateway.send({
      channelId,
      chatId,
      content,
      messageType: "approval",
      replyMarkup: {
        inlineKeyboard: [
          [
            { text: "\u2705 Allow", callbackData: `yes ${shortId}` },
            { text: "\u274c Deny", callbackData: `no ${shortId}` },
          ],
        ],
      },
    });
  } else {
    const content = [
      planSummary,
      "",
      `Reply 'yes ${shortId}' or 'no ${shortId}'`,
    ].join("\n");
    await gateway.send({ channelId, chatId, content, messageType: "approval" });
  }

  // Timeout sweep
  setTimeout(() => {
    const pending = pendingChannelApprovals.get(shortId);
    if (pending && Date.now() - pending.timestamp >= pending.timeoutMs) {
      pendingChannelApprovals.delete(shortId);
      log.warn({ requestId, shortId, taskId }, "Approval timed out, auto-denying");

      gateway.send({
        channelId: pending.channelId,
        chatId: pending.chatId,
        content: `\u23f0 Approval ${shortId} timed out (5 min). Plan denied.`,
        messageType: "approval",
      }).catch((err) => log.error({ requestId, error: err }, "Failed to notify timeout"));

      // Auto-deny via API. Pre-existing bug fix (DP-001): inject x-api-key header
      // because server's onRequest auth hook (app.ts:81-105) always enforces auth
      // and /tasks/... is NOT whitelisted. Without this header, the request returns
      // 401 and the auto-deny silently fails.
      const port = process.env.ADAM_PORT ?? "7100";
      fetch(`http://localhost:${port}/tasks/${pending.taskId}/approve-plan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": getAuthKey(),
        },
        body: JSON.stringify({ planId: pending.planId, decision: "deny" }),
      }).catch((err) => log.error({ requestId, error: err }, "Failed to auto-deny"));
    }
  }, timeoutMs + 1000);

  log.info({ channelId, chatId, planId, shortId, interactive }, "Interactive approval sent to channel");
}

/**
 * Check if an inbound message is an approval reply. If so, forward to the approve-plan API.
 * Returns true if the message was consumed (caller should skip task creation).
 */
export async function handleInboundForApproval(
  channelId: string,
  chatId: string,
  content: string,
  callbackData?: string,
): Promise<boolean> {
  const raw = callbackData ?? content;
  const parsed = parseApprovalReply(raw);
  if (!parsed) return false;

  const { requestId: shortId, decision } = parsed;
  const pending = pendingChannelApprovals.get(shortId);
  if (!pending) return false;

  if (pending.channelId !== channelId || pending.chatId !== chatId) {
    log.debug({ shortId, expectedChannel: pending.channelId, gotChannel: channelId }, "Approval reply from different channel");
    return false;
  }

  pendingChannelApprovals.delete(shortId);
  log.info({ shortId, requestId: pending.requestId, decision }, "Channel approval reply received");

  try {
    const port = process.env.ADAM_PORT ?? "7100";
    const response = await fetch(`http://localhost:${port}/tasks/${pending.taskId}/approve-plan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": getAuthKey(),
      },
      body: JSON.stringify({ planId: pending.planId, decision }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      log.error({ shortId, status: response.status }, "Failed to forward approval to API");
    }
  } catch (err) {
    log.error({ shortId, error: err }, "Error forwarding approval to API");
  }

  return true;
}

export function getPendingApprovalRequestIds(): string[] {
  return [...pendingChannelApprovals.keys()];
}
