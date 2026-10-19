/**
 * Shared artifact-mapping helpers for outbound delivery.
 *
 * Extracted from src/scheduler/template-executor.ts so they can be used by
 * OutboundGateway.redeliverExecutionTo without coupling the gateway to the executor.
 *
 * Provides:
 *   getDeliverableFileArtifacts  — filter file-kind artifacts with blobPath
 *   mediaTypeForArtifact         — mime -> "image" | "audio" | "video" | "file"
 *   filenameForArtifact          — 6-tier filename derivation (a-f)
 *   buildAttachmentsFromArtifacts — map Artifact[] to OutboundAttachment[]
 */

import { basename, extname } from "node:path";
import { readFileSync } from "node:fs";
import { listArtifactsByExecution, type Artifact } from "../store/artifacts.js";
export type { Artifact } from "../store/artifacts.js";
import { getExtensionFromMime } from "../channels/adapters/wechat/media/mime.js";
import type { OutboundAttachment } from "../shared/types.js";

/**
 * Return all file-kind artifacts for an execution that have a blobPath.
 * JSON artifacts and file artifacts without a blob are excluded.
 */
export function getDeliverableFileArtifacts(executionId: string): Artifact[] {
  return listArtifactsByExecution(executionId).filter(
    (artifact) => artifact.kind === "file" && !!artifact.blobPath,
  );
}

/**
 * Strip characters illegal in filenames across macOS/Linux/Windows, plus whitespace.
 * Hyphens are preserved — they separate `{date}-{title}`. Exported for the delivery composer.
 */
export function sanitizeFilenameSegment(s: string): string {
  return s
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "")
    .replace(/^\.+/, "")
    .trim();
}

/**
 * Extract a title from a markdown/text file artifact's first H1 (`# …`).
 * Returns the trimmed heading text, or undefined when the file has no H1 or can't be read.
 * Used by the delivery composer when a title ref points at a file rather than a json field.
 */
export function extractH1Title(artifact: Artifact): string | undefined {
  if (artifact.kind !== "file" || !artifact.blobPath) return undefined;
  let text: string;
  try {
    text = readFileSync(artifact.blobPath, "utf-8");
  } catch {
    return undefined;
  }
  const m = text.match(/^#\s+(.+?)\s*$/m);
  const title = m?.[1]?.trim();
  return title && title.length > 0 ? title : undefined;
}

/**
 * Classify an artifact's MIME type into the four OutboundAttachment mediaType variants.
 */
export function mediaTypeForArtifact(
  artifact: Artifact,
): "image" | "audio" | "video" | "file" {
  const mime = artifact.mime ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

/**
 * Derive a safe, human-readable filename for an artifact.
 *
 * Priority (tier a wins first):
 *   (a) originalFilename with extension
 *   (b) key already carrying an extension
 *   (c) derive extension from MIME (non-".bin" only)
 *   (d) originalFilename without extension
 *   (e) plain key (no extension)
 *   (f) blobPath basename (last resort)
 */
export function filenameForArtifact(artifact: Artifact): string {
  const safeKey = basename(artifact.key ?? "").replace(/[\\/]/g, "-");

  // (a) Original filename with extension wins
  if (artifact.originalFilename) {
    const origSafe = basename(artifact.originalFilename).replace(/[\\/]/g, "-");
    if (extname(origSafe)) return origSafe;
  }

  // (b) Key already carries an extension — honor Role's choice
  if (extname(safeKey)) return safeKey;

  // (c) Derive extension from MIME, but only if the lookup yields a non-default
  if (artifact.mime) {
    const mimeExt = getExtensionFromMime(artifact.mime);
    if (mimeExt && mimeExt !== ".bin" && safeKey) {
      return `${safeKey}${mimeExt}`;
    }
  }

  // (d) Original filename without extension — still better than guessing
  if (artifact.originalFilename) {
    return basename(artifact.originalFilename).replace(/[\\/]/g, "-");
  }

  // (e) Plain key — no extension is better than a wrong one
  if (safeKey) return safeKey;

  // (f) Fallback to blob's basename (will be `<uuid>.bin`)
  return artifact.blobPath ? basename(artifact.blobPath) : artifact.id;
}

/**
 * Map an array of Artifacts to the OutboundAttachment shape
 * expected by OutboundGateway.send.
 */
export function buildAttachmentsFromArtifacts(
  artifacts: Artifact[],
): OutboundAttachment[] {
  return artifacts.map((artifact) => buildAttachmentFromArtifact(artifact));
}

/**
 * Build a single OutboundAttachment from an artifact, with optional overrides used by the
 * delivery composer: a display `type` (mediaType) and a final `filename`.
 */
export function buildAttachmentFromArtifact(
  artifact: Artifact,
  overrides?: { mediaType?: OutboundAttachment["mediaType"]; filename?: string },
): OutboundAttachment {
  return {
    path: artifact.blobPath!,
    mediaType: overrides?.mediaType ?? mediaTypeForArtifact(artifact),
    filename: overrides?.filename ?? filenameForArtifact(artifact),
    contentType: artifact.mime,
    mimeType: artifact.mime,
    artifactId: artifact.id,
    locator: artifact.locator,
    sizeBytes: artifact.sizeBytes,
    purpose: artifact.purpose,
    contentHash: artifact.contentHash,
  };
}
