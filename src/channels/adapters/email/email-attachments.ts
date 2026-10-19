import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { OutboundAttachment, OutboundMessage } from "../../../shared/types.js";

export interface EmailAttachment {
  filename: string;
  path: string;
  contentType?: string;
}

export function buildEmailAttachments(message: OutboundMessage): EmailAttachment[] {
  const attachments: OutboundAttachment[] = [];
  if (message.mediaUrl) {
    attachments.push({ path: message.mediaUrl, mediaType: message.mediaType });
  }
  if (message.attachments) {
    attachments.push(...message.attachments);
  }
  return attachments.map(buildOneEmailAttachment);
}

function buildOneEmailAttachment(attachment: OutboundAttachment): EmailAttachment {
  const filePath = attachment.path.startsWith("file://")
    ? new URL(attachment.path).pathname
    : attachment.path;
  if (!isAbsolute(filePath) || filePath.includes("://")) {
    throw new Error("Email attachment path must be an absolute local file path");
  }
  if (!existsSync(filePath)) {
    throw new Error(`Email attachment file not found: ${filePath}`);
  }

  return {
    filename: attachment.filename ?? basename(filePath),
    path: filePath,
    ...(attachment.contentType
      ? { contentType: attachment.contentType }
      : attachment.mediaType
        ? { contentType: contentTypeForMediaType(attachment.mediaType) }
        : {}),
  };
}

function contentTypeForMediaType(_mediaType: NonNullable<OutboundMessage["mediaType"]>): string {
  // mediaType is too coarse to derive a real MIME (image vs image/png); fall back to
  // octet-stream and let the recipient client infer from filename extension.
  return "application/octet-stream";
}
