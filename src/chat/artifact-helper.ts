import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getLogger } from "../lib/logger.js";
import { getRuntimeConfig } from "../config/runtime.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { ChatAttachment } from "../shared/types.js";

const log = getLogger("manager");
/** Default threshold; runtime config overrides. Kept exported for test backward compat. */
export const ARTIFACT_THRESHOLD = 4000;

function getArtifactThreshold(): number {
  try {
    const v = getRuntimeConfig().chat?.artifactThresholdChars;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  } catch {
    // Runtime config not initialized (focused tests) — fall through to default.
  }
  return DEFAULT_CONFIG.chat?.artifactThresholdChars ?? ARTIFACT_THRESHOLD;
}

function getLocalArtifactProfile(): string {
  try {
    const v = getRuntimeConfig().storage?.localProfile;
    if (typeof v === "string" && /^[a-zA-Z0-9_-]+$/.test(v)) return v;
  } catch {
    // ditto
  }
  return DEFAULT_CONFIG.storage?.localProfile ?? "default";
}

/**
 * If text exceeds the configured artifact threshold, write it as a report.md
 * artifact and return a ChatAttachment for envelope inclusion. Threshold and
 * locator profile both come from runtime config.
 */
export function createReportArtifact(text: string, taskId: string, workspacePath: string): ChatAttachment | null {
  const threshold = getArtifactThreshold();
  if (text.length <= threshold) return null;

  const artifactId = randomUUID();
  const filename = "report.md";
  const dir = path.join(workspacePath, "artifacts", taskId);
  const blobPath = path.join(dir, filename);

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(blobPath, text, "utf-8");
  } catch (err) {
    log.error({ error: err, taskId }, "Failed to create report artifact");
    return null;
  }

  const profile = getLocalArtifactProfile();
  return {
    artifactId,
    locator: `local://${profile}/${blobPath}`,
    filename,
    mimeType: "text/markdown",
    size: Buffer.byteLength(text, "utf-8"),
    purpose: "report",
    retentionHint: "persistent",
  };
}
