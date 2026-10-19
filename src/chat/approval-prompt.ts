// PHASE-5-TEST-USE: see plan §D-P5-02 for rationale.

import { v4 as uuidv4 } from "uuid";
import type { ApprovalShape, ChatSource } from "../shared/types.js";
import { createMessage, updatePlatformMessageId } from "../store/messages.js";
import { createPendingPrompt, generatePromptId } from "../store/pending-prompts.js";
import { getOutboundGateway } from "../delivery/outbound-gateway.js";
import { getChannel } from "../store/channels.js";
import * as sessionManager from "./session-manager.js";
import { serverBus } from "../server/events/server-bus.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("message-handler");

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export type ApprovalPromptTarget =
  | { type: "session"; sessionId: string }
  | { type: "channel"; channelId: string; chatId: string };

export interface CreateApprovalPromptArgs {
  sessionId: string;
  taskId?: string;
  roleId?: string;
  content: string;
  shape: ApprovalShape;
  parentMessageId?: string;
  parentPlatformMessageId?: string;
  threadRoot?: string;
  targets: ApprovalPromptTarget[];
}

export interface CreateApprovalPromptResult {
  promptId: string;
  messageIds: string[];
}

/**
 * Phase 5 outbound helper: creates an approval_prompt envelope and the linked
 * pending_prompts row. For each channel target, writes a separate chat_messages
 * row sharing the same prompt_id and persists the channel-side msg_id via
 * updatePlatformMessageId after the gateway send returns.
 *
 * NOTE: Phase 5 does not call this helper from production code paths. Future
 * phases (or the legacy plan-approval rewrite) will wire it. Phase 5 tests use
 * it to set up native_quote / cross-channel resolution scenarios end-to-end.
 */
export async function createApprovalPrompt(
  args: CreateApprovalPromptArgs,
): Promise<CreateApprovalPromptResult> {
  const { sessionId, taskId, roleId, content, shape, parentMessageId, parentPlatformMessageId, threadRoot, targets } = args;
  const now = Date.now();
  const promptId = generatePromptId(sessionId);
  const messageIds: string[] = [];

  // 1. Insert one chat_messages row per target (D-P5-01)
  const rowMeta: Array<{ id: string; target: ApprovalPromptTarget }> = [];
  for (const target of targets) {
    const messageId = uuidv4();
    const session = sessionManager.getSession(sessionId);
    const sourceForRow: ChatSource =
      target.type === "channel"
        ? { type: "channel", channelId: target.channelId, chatId: target.chatId }
        : (session?.source ?? { type: "web" });
    createMessage({
      id: messageId,
      sessionId,
      role: "assistant",
      content,
      source: sourceForRow,
      taskId,
      kind: "approval_prompt",
      parentMessageId,
      threadRoot,
      promptId,
      approvalShape: shape,
      roleId,
      createdAt: now,
    });
    messageIds.push(messageId);
    rowMeta.push({ id: messageId, target });
  }

  // 2. Insert pending_prompts row. message_id points to first row created
  // (convention: cross-channel sync queries by prompt_id, not message_id).
  createPendingPrompt({
    id: promptId,
    sessionId,
    taskId,
    messageId: messageIds[0],
    shape,
    askedAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
  });

  // 3. For each channel target, send via gateway and persist platform_message_id
  for (const { id, target } of rowMeta) {
    if (target.type !== "channel") {
      // session target: chat_messages row already created; emit chat_message event so subscribers see it
      serverBus.emit({
        type: "chat_message",
        sessionId,
        message: {
          id,
          sessionId,
          role: "assistant",
          content,
          source: sessionManager.getSession(sessionId)?.source ?? { type: "web" },
          taskId,
          kind: "approval_prompt",
          parentMessageId,
          threadRoot,
          promptId,
          approvalShape: shape,
          roleId,
          createdAt: now,
        },
      });
      continue;
    }
    try {
      const gateway = getOutboundGateway();
      let outboundContent = content;
      if (target.type === "channel") {
        const channelRow = getChannel(target.channelId);
        if (channelRow?.platform === "wechat") {
          outboundContent = `${content}\n(回 #${promptId} 表态)`;
        }
      }
      const result = await gateway.send({
        taskId,
        channelId: target.channelId,
        chatId: target.chatId,
        content: outboundContent,
        messageType: "approval_prompt",
        replyToMessageId: parentPlatformMessageId,
      });
      if (result.success && result.messageId && !result.messageId.startsWith("queued-")) {
        updatePlatformMessageId(id, result.messageId);
      }
    } catch (err) {
      log.error({ err, channelId: target.channelId, promptId }, "createApprovalPrompt: gateway.send failed");
    }
  }

  return { promptId, messageIds };
}
