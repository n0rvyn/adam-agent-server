import { describe, it, expect } from "vitest";
import { formatForChannel, stripMarkdown } from "../../delivery/format.js";

describe("delivery/format", () => {
  describe("stripMarkdown", () => {
    it("removes bold markers", () => {
      expect(stripMarkdown("**bold text**")).toBe("bold text");
    });

    it("removes headers", () => {
      expect(stripMarkdown("## Header\ncontent")).toBe("Header\ncontent");
    });

    it("removes inline code", () => {
      expect(stripMarkdown("use `npm install`")).toBe("use npm install");
    });

    it("keeps link text, removes URL", () => {
      expect(stripMarkdown("[click here](https://example.com)")).toBe("click here");
    });
  });

  describe("formatForChannel", () => {
    it("strips markdown for wechat", () => {
      const result = formatForChannel("**Today's weather:** sunny", "wechat");
      expect(result).toBe("Today's weather: sunny");
      expect(result).not.toContain("**");
    });

    it("keeps markdown for telegram", () => {
      const result = formatForChannel("**Today's weather:** sunny", "telegram");
      expect(result).toContain("**");
    });

    it("wraps in JSON for webhook", () => {
      const result = formatForChannel("sunny", "webhook", "task-123");
      const parsed = JSON.parse(result);
      expect(parsed.result).toBe("sunny");
      expect(parsed.taskId).toBe("task-123");
      expect(parsed.timestamp).toBeDefined();
    });

    it("defaults to plain text for unknown platform", () => {
      const result = formatForChannel("**bold**", "unknown-platform");
      expect(result).toBe("bold");
    });
  });
});
