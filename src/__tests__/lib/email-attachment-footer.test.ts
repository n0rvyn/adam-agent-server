/**
 * Tests for email-attachment-footer renderer.
 * Cases A-E as specified in Task 7-tests of the email-priority-packing plan.
 * Tests MUST FAIL before Task 7-impl because the module does not exist yet.
 */
import { describe, expect, it } from "vitest";
import { appendDroppedAttachmentsFooter } from "../../lib/email-attachment-footer.js";

describe("appendDroppedAttachmentsFooter", () => {
  it("Case A: empty dropped array → body unchanged", () => {
    const body = "This is the email body.";
    const result = appendDroppedAttachmentsFooter(body, [], 20971520, "qq.com");
    expect(result).toBe(body);
  });

  it("Case B: 1 dropped item → footer with separator and 1 line", () => {
    const body = "Email body content.";
    const result = appendDroppedAttachmentsFooter(
      body,
      [{ filename: "report.pdf", sizeBytes: 2097152 }],
      20971520,
      "qq.com",
    );
    expect(result).toContain("---");
    expect(result).toContain("qq.com");
    expect(result).toContain("20.0");
    expect(result).toContain("report.pdf");
    expect(result).toContain("2.00 MB");
  });

  it("Case C: 3 dropped items with mixed sizes → footer with 3 lines, sizes formatted correctly", () => {
    const body = "Main content.";
    const dropped = [
      { filename: "small.txt", sizeBytes: 512 },        // < 1KB → bytes
      { filename: "medium.png", sizeBytes: 51200 },     // < 1MB → KB
      { filename: "large.mp4", sizeBytes: 5242880 },    // >= 1MB → MB
    ];
    const result = appendDroppedAttachmentsFooter(body, dropped, 20971520, "163.com");
    expect(result).toContain("small.txt");
    expect(result).toContain("512 bytes");
    expect(result).toContain("medium.png");
    expect(result).toContain("50.0 KB");
    expect(result).toContain("large.mp4");
    expect(result).toContain("5.00 MB");
    // All 3 lines present
    const lines = result.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(3);
  });

  it("Case D: body already ends with \\n---\\n → footer joins without double separator", () => {
    const body = "Content.\n\n---\n";
    const result = appendDroppedAttachmentsFooter(
      body,
      [{ filename: "extra.zip", sizeBytes: 1048576 }],
      20971520,
      "icloud.com",
    );
    // Should NOT have "---\n---" or "---\n\n---"
    expect(result).not.toMatch(/---\s*\n\s*---/);
    expect(result).toContain("extra.zip");
  });

  it("Case E: cap=20971520 bytes → footer header reads '20.0MB上限'", () => {
    const body = "Podcast email.";
    const result = appendDroppedAttachmentsFooter(
      body,
      [{ filename: "dropped.png", sizeBytes: 2048 }],
      20971520,
      "qq.com",
    );
    expect(result).toContain("20.0MB");
    expect(result).toContain("上限");
  });
});
