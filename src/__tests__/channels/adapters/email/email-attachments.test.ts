import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEmailAttachments } from "../../../../channels/adapters/email/email-attachments.js";

describe("email attachments", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns no attachments when mediaUrl is absent", () => {
    expect(buildEmailAttachments({ content: "hello" })).toEqual([]);
  });

  it("turns an absolute local path into an attachment", () => {
    const dir = mkdtempSync(join(tmpdir(), "adam-email-"));
    tempDirs.push(dir);
    const file = join(dir, "artifact.txt");
    writeFileSync(file, "artifact");

    expect(buildEmailAttachments({ content: "hello", mediaUrl: file, mediaType: "file" })).toEqual([{
      filename: "artifact.txt",
      path: file,
      contentType: "application/octet-stream",
    }]);
  });

  it("turns multiple local attachment entries into attachments", () => {
    const dir = mkdtempSync(join(tmpdir(), "adam-email-"));
    tempDirs.push(dir);
    const fileA = join(dir, "a.txt");
    const fileB = join(dir, "b.mp3");
    writeFileSync(fileA, "a");
    writeFileSync(fileB, "b");

    expect(buildEmailAttachments({
      content: "hello",
      attachments: [
        { path: fileA, filename: "renamed.txt", contentType: "text/plain" },
        { path: fileB, mediaType: "audio" },
      ],
    })).toEqual([
      { filename: "renamed.txt", path: fileA, contentType: "text/plain" },
      { filename: "b.mp3", path: fileB, contentType: "application/octet-stream" },
    ]);
  });

  it("rejects missing and non-local files", () => {
    expect(() => buildEmailAttachments({ content: "hello", mediaUrl: "https://example.com/file.txt" })).toThrow("absolute local");
    expect(() => buildEmailAttachments({ content: "hello", attachments: [{ path: "https://example.com/file.txt" }] })).toThrow("absolute local");
    expect(() => buildEmailAttachments({ content: "hello", mediaUrl: "/tmp/adam-missing-file.txt" })).toThrow("not found");
  });

  // Task 13 — application/octet-stream fallback: mediaType is too coarse to derive a real MIME.
  // Fall back to octet-stream and let the email client infer from filename extension.
  describe("contentTypeForMediaType fallback", () => {
    it("returns application/octet-stream when only mediaType=image is set", () => {
      const dir = mkdtempSync(join(tmpdir(), "adam-email-"));
      tempDirs.push(dir);
      const file = join(dir, "photo.png");
      writeFileSync(file, "fake png bytes");
      const result = buildEmailAttachments({
        content: "",
        attachments: [{ path: file, mediaType: "image" }],
      });
      expect(result[0].contentType).toBe("application/octet-stream");
    });

    it("returns application/octet-stream when only mediaType=audio is set", () => {
      const dir = mkdtempSync(join(tmpdir(), "adam-email-"));
      tempDirs.push(dir);
      const file = join(dir, "song.mp3");
      writeFileSync(file, "fake mp3 bytes");
      const result = buildEmailAttachments({
        content: "",
        attachments: [{ path: file, mediaType: "audio" }],
      });
      expect(result[0].contentType).toBe("application/octet-stream");
    });

    it("returns application/octet-stream when only mediaType=video is set", () => {
      const dir = mkdtempSync(join(tmpdir(), "adam-email-"));
      tempDirs.push(dir);
      const file = join(dir, "clip.mp4");
      writeFileSync(file, "fake mp4 bytes");
      const result = buildEmailAttachments({
        content: "",
        attachments: [{ path: file, mediaType: "video" }],
      });
      expect(result[0].contentType).toBe("application/octet-stream");
    });

    it("returns application/octet-stream when only mediaType=file is set", () => {
      const dir = mkdtempSync(join(tmpdir(), "adam-email-"));
      tempDirs.push(dir);
      const file = join(dir, "archive.zip");
      writeFileSync(file, "fake zip bytes");
      const result = buildEmailAttachments({
        content: "",
        attachments: [{ path: file, mediaType: "file" }],
      });
      expect(result[0].contentType).toBe("application/octet-stream");
    });
  });
});
