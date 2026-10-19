import { describe, test, expect, afterEach, beforeEach } from "vitest";
import { createReportArtifact, ARTIFACT_THRESHOLD } from "../../chat/artifact-helper.js";
import { chatAttachmentToOutbound } from "../../chat/attachment-converter.js";
import type { ChatAttachment } from "../../shared/types.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdirSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { initRuntimeConfig } from "../../config/runtime.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { ServerConfig } from "../../shared/types.js";

describe("createReportArtifact", () => {
  const workspacePath = tmpdir();

  test("text <= 4000 chars -> returns null (no artifact)", () => {
    const text = "a".repeat(4000);
    expect(createReportArtifact(text, "task-1", workspacePath)).toBeNull();
  });

  test("text > 4000 chars -> returns ChatAttachment with correct fields", () => {
    const text = "a".repeat(4001);
    const result = createReportArtifact(text, "task-2", workspacePath);
    expect(result).not.toBeNull();
    expect(result!.artifactId).toBeDefined();
    expect(result!.locator).toMatch(/^local:\/\/default\//);
    expect(result!.filename).toBe("report.md");
    expect(result!.mimeType).toBe("text/markdown");
    expect(result!.size).toBe(4001);
    expect(result!.purpose).toBe("report");
    expect(result!.retentionHint).toBe("persistent");
  });

  test("threshold exactly 4000 -> returns null (boundary)", () => {
    const text = "x".repeat(4000);
    expect(createReportArtifact(text, "task-3", workspacePath)).toBeNull();
  });

  test("threshold 4001 -> returns ChatAttachment (boundary)", () => {
    const text = "y".repeat(4001);
    const result = createReportArtifact(text, "task-4", workspacePath);
    expect(result).not.toBeNull();
    expect(result!.filename).toBe("report.md");
  });

  test("file write failure (disk-full/permission) -> returns null, logs error", () => {
    const text = "z".repeat(4001);
    // Use a path that cannot be written to (root-level directory)
    const result = createReportArtifact(text, "task-5", "/nonexistent-readonly-dir");
    expect(result).toBeNull();
  });

  test("returns correct locator URI format (local://default/...)", () => {
    const text = "content".repeat(1000);
    const result = createReportArtifact(text, "task-6", workspacePath);
    expect(result!.locator).toMatch(/^local:\/\/default\/.*\/report\.md$/);
    // cleanup
    const filePath = result!.locator.replace("local://default/", "");
    try { unlinkSync(filePath); } catch {}
    try { rmdirSync(path.dirname(filePath)); } catch {}
  });
});

describe("createReportArtifact — config-driven threshold and profile (Task 3)", () => {
  const workspacePath = tmpdir();

  test("uses configured artifactThresholdChars when set", () => {
    // Override threshold to 100 via initRuntimeConfig (not mutation)
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig;
    cfg.chat = cfg.chat ?? { sessionTimeoutMinutes: 30, maxSessionTurns: 20, autoTitle: true, archiveExtractMemory: true, contextBudgetTokens: 20000, artifactThresholdChars: 100 };
    cfg.chat.artifactThresholdChars = 100;
    initRuntimeConfig(cfg);

    // text length 150 should now trigger artifact creation (threshold is 100)
    const text = "a".repeat(150);
    const result = createReportArtifact(text, "task-config-1", workspacePath);
    expect(result).not.toBeNull();
    expect(result!.filename).toBe("report.md");
  });

  test("uses configured storage.localProfile in locator", () => {
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig;
    cfg.storage = { localProfile: "archive" };
    initRuntimeConfig(cfg);

    const text = "a".repeat(5000);
    const result = createReportArtifact(text, "task-config-3", workspacePath);
    expect(result!.locator).toMatch(/^local:\/\/archive\//);
    // cleanup
    const filePath = result!.locator.replace("local://archive/", "");
    try { unlinkSync(filePath); } catch {}
    try { rmdirSync(path.dirname(filePath)); } catch {}
  });

  test("rejects profile with path separator (security) — falls back to 'default'", () => {
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig;
    cfg.storage = { localProfile: "../etc" };
    initRuntimeConfig(cfg);

    const text = "a".repeat(5000);
    const result = createReportArtifact(text, "task-config-4", workspacePath);
    // The regex /^[a-zA-Z0-9_-]+$/ rejects "../etc", so it falls back to DEFAULT_CONFIG value "default"
    expect(result!.locator).toMatch(/^local:\/\/default\//);
    // cleanup
    const filePath = result!.locator.replace("local://default/", "");
    try { unlinkSync(filePath); } catch {}
    try { rmdirSync(path.dirname(filePath)); } catch {}
  });
});

describe("chatAttachmentToOutbound", () => {
  const tmp = tmpdir();
  let testFilePath: string;

  beforeEach(() => {
    testFilePath = path.join(tmp, `test-attachment-${Date.now()}.bin`);
    writeFileSync(testFilePath, "test content", "utf-8");
  });

  afterEach(() => {
    try { unlinkSync(testFilePath); } catch {}
  });

  const makeAttachment = (overrides: Partial<ChatAttachment> = {}): ChatAttachment => ({
    artifactId: "a1b2c3",
    locator: `local://default/${testFilePath}`,
    filename: "test.bin",
    mimeType: "application/octet-stream",
    size: 12,
    ...overrides,
  });

  test("local://default/ locator -> path extracted correctly", () => {
    const att = makeAttachment({ locator: `local://default/${testFilePath}` });
    const result = chatAttachmentToOutbound(att);
    expect(result).not.toBeNull();
    expect(result!.path).toBe(testFilePath);
  });

  test("local:// locator (no profile) -> path extracted", () => {
    const att = makeAttachment({ locator: `local://${testFilePath}` });
    const result = chatAttachmentToOutbound(att);
    expect(result).not.toBeNull();
    expect(result!.path).toBe(testFilePath);
  });

  test("non-local scheme -> returns null", () => {
    const att = makeAttachment({ locator: "webdav://example.com/file.pdf" });
    expect(chatAttachmentToOutbound(att)).toBeNull();
  });

  test("file does not exist at path -> returns null", () => {
    const att = makeAttachment({ locator: "local://default//nonexistent/path/file.bin" });
    expect(chatAttachmentToOutbound(att)).toBeNull();
  });

  test("image/png mime -> mediaType=image, contentType=image/png", () => {
    const att = makeAttachment({ mimeType: "image/png" });
    const result = chatAttachmentToOutbound(att);
    expect(result!.mediaType).toBe("image");
    expect(result!.contentType).toBe("image/png");
  });

  test("audio/mp3 mime -> mediaType=audio", () => {
    const att = makeAttachment({ mimeType: "audio/mpeg" });
    const result = chatAttachmentToOutbound(att);
    expect(result!.mediaType).toBe("audio");
  });

  test("video/mp4 mime -> mediaType=video", () => {
    const att = makeAttachment({ mimeType: "video/mp4" });
    const result = chatAttachmentToOutbound(att);
    expect(result!.mediaType).toBe("video");
  });

  test("application/pdf mime -> mediaType=file", () => {
    const att = makeAttachment({ mimeType: "application/pdf" });
    const result = chatAttachmentToOutbound(att);
    expect(result!.mediaType).toBe("file");
  });

  test("returns filename and path in OutboundAttachment", () => {
    const att = makeAttachment({ filename: "my-report.pdf", mimeType: "application/pdf" });
    const result = chatAttachmentToOutbound(att);
    expect(result!.filename).toBe("my-report.pdf");
    expect(result!.path).toBe(testFilePath);
  });
});
