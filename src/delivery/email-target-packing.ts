/**
 * Per-target email attachment packing helpers.
 * Extracted from OutboundGateway to keep outbound-gateway.ts under 700 lines.
 */

import type { Artifact } from "../store/artifacts.js";
import type { OutboundAttachment } from "../shared/types.js";
import { packAttachmentsToCap, BASE64_INFLATION } from "../lib/attachment-packer.js";
import { appendDroppedAttachmentsFooter } from "../lib/email-attachment-footer.js";
import { getRecipientCap } from "../store/channels.js";

export class OutboundFirstAttachmentExceedsCap extends Error {
  constructor(
    public readonly artifactKey: string,
    public readonly sizeBytes: number,
    public readonly effectiveSizeBytes: number,
    public readonly capBytes: number,
    public readonly recipientDomain: string,
  ) {
    super(
      `OutboundFirstAttachmentExceedsCap: artifactKey=${artifactKey} sizeBytes=${sizeBytes} effectiveSizeBytes=${effectiveSizeBytes} capBytes=${capBytes} recipientDomain=${recipientDomain}`,
    );
    this.name = "OutboundFirstAttachmentExceedsCap";
  }
}

/**
 * Extract recipient domain from an email chatId.
 * Returns lowercase domain, or empty string if chatId has no `@`.
 */
export function extractDomain(chatId: string | undefined): string {
  if (!chatId) return "";
  const at = chatId.lastIndexOf("@");
  if (at < 0 || at === chatId.length - 1) return "";
  return chatId.slice(at + 1).toLowerCase().trim();
}

/**
 * Resolve an artifact's user-facing key from its id.
 * O(N) linear scan — N is per-execution artifact count (typically 5-20), not a hot path.
 */
export function artifactKeyById(id: string, artifacts: Artifact[]): string {
  return artifacts.find((a) => a.id === id)?.key ?? id;
}

/**
 * Resolve the rendered filename for an artifact by matching the OutboundAttachment
 * that was built from it. buildAttachmentsFromArtifacts stamps each attachment
 * with its source artifactId; this reverse-lookup finds the rendered filename.
 */
export function artifactFilenameById(id: string, attachments: OutboundAttachment[]): string {
  return attachments.find((att) => att.artifactId === id)?.filename ?? id;
}

export interface EmailPackResult {
  /** The filtered attachment list to send (packed subset). */
  perTargetAttachments: OutboundAttachment[];
  /** The body content with footer appended when items were dropped. */
  perTargetContent: string;
}

export type EmailPackOutcome =
  | { ok: true; result: EmailPackResult }
  | { ok: false; error: string };

/**
 * Pack attachments for a single email target.
 * Returns either a successful pack result or a structured overflow error string.
 * Non-email targets must not call this function.
 */
export function packForEmailTarget(
  channelId: string,
  chatId: string | undefined,
  artifacts: Artifact[],
  attachments: OutboundAttachment[],
  content: string,
): EmailPackOutcome {
  const recipientDomain = extractDomain(chatId);
  const cap = getRecipientCap(channelId, recipientDomain);
  const packInputs = artifacts.map((a) => ({
    id: a.id,
    sizeBytes: a.sizeBytes ?? 0,
    priority: a.priority ?? undefined,
    mime: a.mime ?? undefined,
  }));
  const packed = packAttachmentsToCap(packInputs, cap);

  if ("firstItemOverflow" in packed) {
    const item = packed.firstItemOverflow;
    const artifactKey = artifactKeyById(item.id, artifacts);
    const err = new OutboundFirstAttachmentExceedsCap(artifactKey, item.sizeBytes, Math.floor(item.sizeBytes * BASE64_INFLATION), cap, recipientDomain);
    return { ok: false, error: err.message };
  }

  const includedIds = new Set(packed.included.map((i) => i.id));
  const perTargetAttachments = attachments.filter((a) => a.artifactId && includedIds.has(a.artifactId));

  let perTargetContent = content;
  if (packed.dropped.length > 0) {
    const droppedForFooter = packed.dropped.map((d) => ({
      filename: artifactFilenameById(d.id, attachments),
      sizeBytes: d.sizeBytes,
    }));
    perTargetContent = appendDroppedAttachmentsFooter(content, droppedForFooter, cap, recipientDomain);
  }

  return { ok: true, result: { perTargetAttachments, perTargetContent } };
}
