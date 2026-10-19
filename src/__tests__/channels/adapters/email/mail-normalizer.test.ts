import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseInboundEmail } from "../../../../channels/adapters/email/mail-normalizer.js";

const fixturesDir = join(process.cwd(), "src/channels/adapters/email/fixtures");

describe("parseInboundEmail", () => {
  it("returns the plain text body", async () => {
    const email = await parseInboundEmail(readFixture("text-email.eml"));

    expect(email.from).toBe("test.user@example.com");
    expect(email.to).toEqual(["adam@example.com"]);
    expect(email.subject).toBe("Plain subject");
    expect(email.text).toContain("This is a plain text email.");
    expect(email.attachmentCount).toBe(0);
  });

  it("converts HTML-only email to text", async () => {
    const email = await parseInboundEmail(readFixture("html-only-email.eml"));

    expect(email.text).toContain("Status");
    expect(email.text).toContain("Hello Adam");
    expect(email.text).toContain("First item");
  });

  it("ignores attachment bytes and reports attachment count", async () => {
    const email = await parseInboundEmail(readFixture("attachment-email.eml"));

    expect(email.text).toBe("See attached artifact.");
    expect(email.attachmentCount).toBe(1);
  });

  it("uses subject as text when body is empty", async () => {
    const email = await parseInboundEmail([
      "Message-ID: <empty-1@example.com>",
      "From: empty@example.com",
      "To: adam@example.com",
      "Subject: Subject fallback",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "",
    ].join("\r\n"));

    expect(email.text).toBe("Subject fallback");
  });

  it("rejects multi-sender malformed input", async () => {
    await expect(parseInboundEmail([
      "From: a@example.com, b@example.com",
      "To: adam@example.com",
      "Subject: Bad",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "hello",
    ].join("\r\n"))).rejects.toThrow("exactly one");
  });
});

function readFixture(name: string): Buffer {
  return readFileSync(join(fixturesDir, name));
}
