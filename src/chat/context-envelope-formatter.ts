import type { ChatMessage, ChatAttachment, ChatEnvelopeKind, DeliveryTarget, PromptResolvedVia } from "../shared/types.js";

/** Short message reference: `#M` + last 6 chars of message id, stripping a leading hyphen if present. */
export function shortMessageRef(messageId: string): string {
  const last6 = messageId.slice(-6);
  return `#M${last6.startsWith("-") ? last6.slice(1) : last6}`;
}

/** HH:MM in local time. */
export function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Human-readable byte size: `4.2KB`, `1.3MB`, `512B`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Build mirror suffix line content (without leading indent). */
export function formatMirrorSuffix(
  mirroredToTargets: DeliveryTarget[],
  time: string,
): string {
  if (mirroredToTargets.length === 0) return "";
  const list = mirroredToTargets
    .map(t => t.channelId ? `${t.channelId}${t.chatId ? `:${t.chatId}` : ""}` : t.webhookUrl ?? "?")
    .join(", ");
  return `(also delivered to: ${list} @ ${time})`;
}

/** Format a single attachment line, optionally followed by an excerpt line. */
export function formatAttachmentBlock(
  attachment: ChatAttachment,
  excerpt: string | undefined,
): string {
  const purpose = attachment.purpose ?? "data";
  const meta = `[file: ${attachment.filename} (purpose=${purpose}, ${formatSize(attachment.size)}, mime=${attachment.mimeType})]`;
  if (excerpt === undefined) return `    ${meta}`;
  // Show excerpt as JSON-escaped one-liner up to 500 chars (resolver already capped).
  const inline = JSON.stringify(excerpt);
  return `    ${meta}\n      excerpt: ${inline}`;
}

/** Map envelope kind to bracket label. */
export function kindLabel(kind: ChatEnvelopeKind | undefined, role: "user" | "assistant"): string {
  if (kind === "user_message" || (!kind && role === "user")) return "user";
  if (kind === "assistant_text" || (!kind && role === "assistant")) return "adam";
  if (kind === "status_report") return "status";
  if (kind === "result_delivery") return "result";
  if (kind === "approval_prompt") return "approval";
  if (kind === "system_note") return "system";
  return "msg";
}

/**
 * Format the metadata bracket of an envelope.
 * Examples:
 *   [adam #M789012]
 *   [approval #M456789 prompt=A2K7 shape=yes_no]
 *   [user #M5 reply→#M4 prompt=A2K7 via=token]
 */
export function formatEnvelopeBracket(
  msg: ChatMessage,
  resolvedVia?: PromptResolvedVia,
): string {
  const label = kindLabel(msg.kind, msg.role);
  const parts: string[] = [label, shortMessageRef(msg.id)];

  // approval_prompt envelopes carry shape + prompt_id
  if (msg.kind === "approval_prompt") {
    if (msg.promptId) parts.push(`prompt=${msg.promptId}`);
    if (msg.approvalShape) parts.push(`shape=${msg.approvalShape}`);
  }

  // user_message envelopes that resolved a prompt carry binding metadata
  // (set by message-handler resolution steps 1-4 in Phase 5)
  const isUser = msg.kind === "user_message" || (!msg.kind && msg.role === "user");
  if (isUser) {
    if (msg.parentMessageId) parts.push(`reply→${shortMessageRef(msg.parentMessageId)}`);
    if (msg.promptId) parts.push(`prompt=${msg.promptId}`);
    if (resolvedVia) parts.push(`via=${resolvedVia}`);
  }

  return `[${parts.join(" ")}]`;
}
