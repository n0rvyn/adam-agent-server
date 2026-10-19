/**
 * Centralized danger-class detection for artifact deletion.
 *
 * Used by REST DELETE /artifacts/:id (Phase 3), Web UI DangerConfirmDialog (Phase 4),
 * and TUI inline confirm (Phase 5). DO NOT redefine these prefixes elsewhere —
 * grep before adding new audio/video/pdf checks.
 */

export const DANGER_MIME_PREFIXES = ["audio/", "video/", "application/pdf"] as const;

export type DangerClass = "audio" | "video" | "pdf";

export function getDangerClass(mime: string | undefined): DangerClass | null {
  if (!mime) return null;
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  return null;
}

export function isDangerClass(mime: string | undefined): boolean {
  return getDangerClass(mime) !== null;
}
