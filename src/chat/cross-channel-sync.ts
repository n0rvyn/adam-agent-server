import type { ChatSource } from "../shared/types.js";
import { findEnvelopesByPromptId } from "../store/messages.js";
import { getOutboundGateway } from "../delivery/outbound-gateway.js";
import { getChannelManager } from "../server/routes/channels.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("message-handler");

export interface SyncResolvedPromptArgs {
  promptId: string;
  verdict: string;          // raw text of user reply (e.g., "批准" / "拒绝" / "不允许")
  originatorLabel: string;  // human-readable source: "Web" / "TUI" / channel name
  skipSource: ChatSource;   // source where the user resolved the prompt — skip its corresponding row
}

/**
 * After a pending_prompts row is resolved by a user reply, propagate the
 * decision to every channel target that received the original approval_prompt.
 *
 * For each chat_messages row sharing the prompt_id:
 *  - source.type === "channel" with platform_message_id set:
 *      - adapter capability canEdit === true → channelManager.editMessage(...)
 *      - canEdit === false → gateway.send({kind: 'system_note', ...}) to that channel/chat
 *  - source.type === "session" / web / tui: skip (user can see resolution via Web UI WS push;
 *    Phase 7 / Phase 8 will render approval_prompt resolved state from chat_messages.prompt_id)
 *  - row matches `skipSource` (e.g., user resolved on Web → skip the Web row): skip update
 */
export async function syncResolvedPrompt(args: SyncResolvedPromptArgs): Promise<void> {
  const { promptId, verdict, originatorLabel, skipSource } = args;
  const rows = findEnvelopesByPromptId(promptId);
  if (rows.length === 0) {
    log.debug({ promptId }, "syncResolvedPrompt: no envelope rows found for prompt");
    return;
  }

  const verdictLabel = classifyVerdict(verdict); // "批准" | "拒绝" | <verdict>
  const verdictMark = verdictLabel === "拒绝" ? "✗" : "✓";
  const time = new Date();
  const hh = String(time.getHours()).padStart(2, "0");
  const mm = String(time.getMinutes()).padStart(2, "0");
  const editedContent = `[已${verdictLabel} - by 自己 in ${originatorLabel} @ ${hh}:${mm} ${verdictMark}]`;
  const broadcastContent = `#${promptId} 已在 ${originatorLabel} 端${verdictLabel} ${verdictMark}`;

  const channelManager = getChannelManager();
  if (!channelManager) {
    log.warn({ promptId }, "syncResolvedPrompt: no channel manager registered; skipping cross-channel sync");
    return;
  }
  for (const row of rows) {
    if (row.source.type !== "channel" || !row.source.channelId || !row.source.chatId) continue;
    if (
      skipSource.type === "channel" &&
      skipSource.channelId === row.source.channelId &&
      skipSource.chatId === row.source.chatId
    ) {
      continue; // D-P5-08: skip originator's own channel
    }
    const caps = channelManager.getCapabilities(row.source.channelId);
    if (!caps) {
      log.warn({ channelId: row.source.channelId, promptId }, "syncResolvedPrompt: no capabilities for channel; skip");
      continue;
    }
    if (caps.canEdit && row.platformMessageId) {
      try {
        await channelManager.editMessage(row.source.channelId, row.source.chatId, row.platformMessageId, editedContent);
      } catch (err) {
        log.error({ err, promptId, channelId: row.source.channelId }, "syncResolvedPrompt: editMessage failed; falling back to broadcast");
        await broadcastSystemNote(row.source.channelId, row.source.chatId, broadcastContent);
      }
    } else {
      await broadcastSystemNote(row.source.channelId, row.source.chatId, broadcastContent);
    }
  }
}

async function broadcastSystemNote(channelId: string, chatId: string, content: string): Promise<void> {
  try {
    const gateway = getOutboundGateway();
    await gateway.send({ channelId, chatId, content, messageType: "system_note" });
  } catch (err) {
    log.error({ err, channelId }, "syncResolvedPrompt: broadcast system_note failed");
  }
}

function classifyVerdict(text: string): string {
  const lower = text.trim().toLowerCase();
  if (/批准|同意|允许|^yes\b|^y\b|^好[，,。\s]?$|可以/.test(lower)) return "批准";
  if (/拒绝|不允许|不同意|否决|^no\b|^n\b|不行/.test(lower)) return "拒绝";
  return text.trim().slice(0, 6);
}
