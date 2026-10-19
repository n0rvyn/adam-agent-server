/**
 * Client-side UX helper: determines if a mime type warrants a DangerConfirmDialog.
 * Server-side 412 is the true gate; this function only drives the pre-confirm UX.
 * Prefixes mirror src/lib/artifact-danger-class.ts — both must stay equivalent.
 */

export type DangerClass = "audio" | "video" | "pdf" | null;

export function getDangerClass(mime: string | undefined): DangerClass {
  if (!mime) return null;
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf" || mime.startsWith("application/pdf")) return "pdf";
  return null;
}
