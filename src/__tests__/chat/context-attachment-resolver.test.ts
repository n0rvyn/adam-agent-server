import { describe, it, expect } from "vitest";
import { isTextClassMime, parseLocalPath, resolveAttachmentExcerpt, ATTACHMENT_EXCERPT_CHARS } from "../../chat/context-attachment-resolver.js";
import type { ChatAttachment } from "../../shared/types.js";

describe("chat/context-attachment-resolver", () => {
  describe("isTextClassMime", () => {
    it.each([
      ["text/plain", true],
      ["text/markdown", true],
      ["text/html", true],
      ["application/json", true],
      ["application/yaml", true],
      ["application/markdown", true],
      ["application/octet-stream", false],
      ["image/png", false],
      ["application/pdf", false],
      [undefined, false],
    ])("classifies %s → %s", (mime, expected) => {
      expect(isTextClassMime(mime)).toBe(expected);
    });
  });

  describe("parseLocalPath", () => {
    it("parses local:/// scheme", () => {
      expect(parseLocalPath("local:///Users/x/.adam/blob.md")).toBe("/Users/x/.adam/blob.md");
    });
    it("parses local://default/ scheme", () => {
      expect(parseLocalPath("local://default/Users/x/.adam/blob.md")).toBe("/Users/x/.adam/blob.md");
    });
    it("returns null for non-local schemes", () => {
      expect(parseLocalPath("gdrive://default/abc")).toBeNull();
      expect(parseLocalPath("s3://default/bucket/key")).toBeNull();
    });
  });

  describe("resolveAttachmentExcerpt", () => {
    const baseAttachment: ChatAttachment = {
      artifactId: "a1",
      locator: "local:///tmp/x.md",
      filename: "x.md",
      mimeType: "text/markdown",
      size: 100,
    };

    it("returns preview.excerpt when present, truncated to 500", async () => {
      const long = "a".repeat(800);
      const result = await resolveAttachmentExcerpt({ ...baseAttachment, preview: { excerpt: long } });
      expect(result).toHaveLength(ATTACHMENT_EXCERPT_CHARS);
    });

    it("returns short preview as-is", async () => {
      const result = await resolveAttachmentExcerpt({ ...baseAttachment, preview: { excerpt: "short" } });
      expect(result).toBe("short");
    });

    it("reads from local:// when no preview and text-class MIME", async () => {
      const fakeRead = async (_p: string, _o: { encoding: BufferEncoding; bytes?: number }) => "## Findings\nrace condition";
      const result = await resolveAttachmentExcerpt(baseAttachment, fakeRead);
      expect(result).toBe("## Findings\nrace condition");
    });

    it("returns undefined for binary-class MIME without preview", async () => {
      const result = await resolveAttachmentExcerpt({ ...baseAttachment, mimeType: "image/png" });
      expect(result).toBeUndefined();
    });

    it("returns undefined for non-local scheme without preview", async () => {
      const result = await resolveAttachmentExcerpt({ ...baseAttachment, locator: "gdrive://default/abc" });
      expect(result).toBeUndefined();
    });

    it("returns undefined when read fails", async () => {
      const failingRead = async () => { throw new Error("ENOENT"); };
      const result = await resolveAttachmentExcerpt(baseAttachment, failingRead);
      expect(result).toBeUndefined();
    });
  });
});
