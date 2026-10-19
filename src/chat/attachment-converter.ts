import { existsSync } from "node:fs";
import type { ChatAttachment, OutboundAttachment } from "../shared/types.js";

/**
 * Convert a ChatAttachment (envelope/storage layer) to OutboundAttachment (gateway transport layer).
 * Resolves the `local://` locator URI to a local filesystem path.
 * Returns null if the file does not exist at the resolved path.
 */
export function chatAttachmentToOutbound(att: ChatAttachment): OutboundAttachment | null {
  // Resolve local:// locator to filesystem path
  let filePath: string;
  if (att.locator.startsWith("local://default/")) {
    filePath = att.locator.slice("local://default/".length);
  } else if (att.locator.startsWith("local://")) {
    filePath = att.locator.slice("local://".length);
  } else {
    // Non-local backends not implemented this round
    return null;
  }

  if (!existsSync(filePath)) return null;

  // Map mimeType to both contentType (generic) and mediaType (WeChat/Telegram category)
  const mediaType = mimeToMediaType(att.mimeType);

  return {
    path: filePath,
    filename: att.filename,
    contentType: att.mimeType,
    mediaType,
    artifactId: att.artifactId,
    locator: att.locator,
    mimeType: att.mimeType,
    sizeBytes: att.size,
    purpose: att.purpose,
    contentHash: att.contentHash,
  };
}

function mimeToMediaType(mime: string): OutboundAttachment["mediaType"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}
