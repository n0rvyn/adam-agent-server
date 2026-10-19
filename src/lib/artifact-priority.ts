import type { Artifact } from "../store/artifacts.js";

export const PRIORITY_AUDIO_VIDEO = 10;
export const PRIORITY_TEXT = 50;
export const PRIORITY_IMAGE = 100;
export const PRIORITY_OTHER = 200;

export function effectivePriority(a: Pick<Artifact, "priority" | "mime">): number {
  if (a.priority !== undefined && a.priority !== null) return a.priority;
  const m = a.mime ?? "";
  if (m.startsWith("audio/") || m.startsWith("video/")) return PRIORITY_AUDIO_VIDEO;
  if (m === "text/markdown" || m === "text/plain") return PRIORITY_TEXT;
  if (m.startsWith("image/")) return PRIORITY_IMAGE;
  return PRIORITY_OTHER;
}
