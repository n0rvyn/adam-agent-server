import { basename } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { v4 as uuidv4 } from "uuid";
import { publishBlobByKind, isPathInAdamRuntime, unlinkBlob } from "../lib/artifact-storage.js";
import { createArtifact, type Artifact } from "../store/artifacts.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("manager");

export interface RegisterChatSentArgs {
  mediaUrl: string; // absolute local path
  chatSessionId: string | undefined;
  roleId: string;
  mime?: string;
}

export async function registerChatSentArtifact(args: RegisterChatSentArgs): Promise<void> {
  if (!args.chatSessionId) {
    log.warn({ mediaUrl: args.mediaUrl }, "skip chat artifact: chatSessionId required");
    return;
  }
  if (!existsSync(args.mediaUrl)) {
    log.warn({ mediaUrl: args.mediaUrl }, "skip chat artifact: file not found (ENOENT)");
    return;
  }
  if (!isPathInAdamRuntime(args.mediaUrl)) {
    log.warn({ mediaUrl: args.mediaUrl }, "skip chat artifact: mediaUrl outside adam runtime");
    return;
  }

  const artifactId = uuidv4();
  let blobPath: string | undefined;
  try {
    const published = publishBlobByKind({
      kind: "chat",
      artifactId,
      sourcePath: args.mediaUrl,
    });
    blobPath = published.blobPath;

    // content_hash for downstream dedup (Phase 1 idx_artifacts_content_hash relies on this)
    const hash = createHash("sha256").update(readFileSync(blobPath)).digest("hex");

    const artifact: Artifact = {
      id: artifactId,
      sourceKind: "chat_sent",
      chatSessionId: args.chatSessionId,
      roleId: args.roleId,
      kind: "file",
      blobPath,
      mime: args.mime,
      originalFilename: basename(args.mediaUrl),
      sizeBytes: published.sizeBytes,
      contentHash: hash,
      createdAt: Date.now(),
    };
    createArtifact(artifact);
  } catch (err) {
    log.warn({ err, mediaUrl: args.mediaUrl, artifactId }, "chat artifact registration failed; rolling back blob");
    if (blobPath) {
      try { unlinkBlob(blobPath); } catch { /* best effort */ }
    }
  }
}
