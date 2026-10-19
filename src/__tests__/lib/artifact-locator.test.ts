import { describe, it, expect } from "vitest";
import {
  parseLocator,
  serializeLocator,
  localLocatorFromPath,
  isLocatorSupported,
  resolveBackend,
  UnsupportedBackendError,
} from "../../lib/artifact-locator.js";

describe("artifact-locator", () => {
  describe("parseLocator", () => {
    it("parses local:///abs/path", () => {
      const p = parseLocator("local:///Users/example/.adam/file.pdf");
      expect(p).toEqual({ scheme: "local", profile: "", ref: "/Users/example/.adam/file.pdf" });
    });

    it("parses gdrive://default/fileId", () => {
      const p = parseLocator("gdrive://default/1AbCd");
      expect(p).toEqual({ scheme: "gdrive", profile: "default", ref: "1AbCd" });
    });

    it("parses webdav://work/Reports/Q2.md", () => {
      const p = parseLocator("webdav://work/Reports/Q2.md");
      expect(p).toEqual({ scheme: "webdav", profile: "work", ref: "Reports/Q2.md" });
    });

    it("parses mcp_kb://lumina/note/abc-123", () => {
      const p = parseLocator("mcp_kb://lumina/note/abc-123");
      expect(p).toEqual({ scheme: "mcp_kb", profile: "lumina", ref: "note/abc-123" });
    });

    it("rejects unknown scheme", () => {
      expect(parseLocator("ftp://x/y")).toBeUndefined();
    });

    it("rejects malformed local (missing third slash)", () => {
      expect(parseLocator("local://abs/path")).toBeUndefined();
    });

    it("rejects empty profile for non-local", () => {
      expect(parseLocator("gdrive:///path")).toBeUndefined();
    });

    it("rejects bad chars in profile", () => {
      expect(parseLocator("gdrive://my profile/x")).toBeUndefined();
    });
  });

  describe("serializeLocator", () => {
    it("round-trips local", () => {
      const uri = "local:///Users/n/file.md";
      const parsed = parseLocator(uri)!;
      expect(serializeLocator(parsed)).toBe(uri);
    });

    it("round-trips gdrive", () => {
      const uri = "gdrive://default/abc";
      const parsed = parseLocator(uri)!;
      expect(serializeLocator(parsed)).toBe(uri);
    });
  });

  describe("localLocatorFromPath", () => {
    it("builds local:// from absolute path", () => {
      expect(localLocatorFromPath("/abs/path")).toBe("local:///abs/path");
    });

    it("rejects relative path", () => {
      expect(() => localLocatorFromPath("relative/path")).toThrow();
    });
  });

  describe("isLocatorSupported", () => {
    it("returns true only for local", () => {
      expect(isLocatorSupported(parseLocator("local:///x")!)).toBe(true);
      expect(isLocatorSupported(parseLocator("gdrive://default/x")!)).toBe(false);
      expect(isLocatorSupported(parseLocator("webdav://work/x")!)).toBe(false);
      expect(isLocatorSupported(parseLocator("s3://default/b/k")!)).toBe(false);
      expect(isLocatorSupported(parseLocator("mcp_kb://l/r")!)).toBe(false);
      expect(isLocatorSupported(parseLocator("icloud://default/x")!)).toBe(false);
      expect(isLocatorSupported(parseLocator("notion://default/page/x")!)).toBe(false);
      expect(isLocatorSupported(parseLocator("obsidian://vault/x")!)).toBe(false);
    });
  });

  describe("resolveBackend", () => {
    it("ux-016-non-local-schemes-throw-unsupported: throws UnsupportedBackendError for non-local schemes", () => {
      const nonLocal = ["webdav://work/x", "gdrive://default/x", "s3://default/b/k", "mcp_kb://l/r", "icloud://default/x", "notion://default/page/x", "obsidian://vault/x"];
      for (const uri of nonLocal) {
        expect(() => resolveBackend(uri)).toThrow(UnsupportedBackendError);
      }
    });

    it("throws on invalid URI", () => {
      expect(() => resolveBackend("not-a-uri")).toThrow();
    });
  });
});
