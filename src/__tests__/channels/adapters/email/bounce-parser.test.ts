/**
 * Tests for email-bounce-parser.
 * Cases A-I as specified in Task 6-tests of the email-priority-packing plan.
 * Tests MUST FAIL before Task 6-impl because the module does not exist yet.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ParsedInboundEmail } from "../../../../channels/adapters/email/email-gateway.js";
import {
  parseSizeLimitFromBounce,
} from "../../../../channels/adapters/email/bounce-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");

function makeEmail(overrides: Partial<ParsedInboundEmail>): ParsedInboundEmail {
  return {
    from: overrides.from ?? "MAILER-DAEMON@example.com",
    to: overrides.to ?? ["adam@example.org"],
    subject: overrides.subject ?? "Mail Delivery Failure",
    text: overrides.text ?? "",
    rawHeaders: overrides.rawHeaders ?? {},
    attachmentCount: overrides.attachmentCount ?? 0,
    ...overrides,
  };
}

function loadFixture(filename: string): ParsedInboundEmail {
  const text = readFileSync(join(fixturesDir, filename), "utf8");
  return makeEmail({ text, from: "MAILER-DAEMON@smtp.example.com" });
}

describe("parseSizeLimitFromBounce", () => {
  it("Case A: bounce-552-qq.eml → extracts qq.com domain and 20971520 bytes cap", () => {
    const email = loadFixture("bounce-552-qq.eml");
    const result = parseSizeLimitFromBounce(email);
    expect(result).not.toBeNull();
    expect(result?.recipientDomain).toBe("qq.com");
    expect(result?.capBytes).toBe(20971520);
  });

  it("Case B: bounce-552-163.eml → extracts 163.com domain and 52428800 bytes cap", () => {
    const email = loadFixture("bounce-552-163.eml");
    const result = parseSizeLimitFromBounce(email);
    expect(result).not.toBeNull();
    expect(result?.recipientDomain).toBe("163.com");
    expect(result?.capBytes).toBe(52428800);
  });

  it("Case C: bounce-multipart-report.eml → parses Final-Recipient icloud.com + Diagnostic-Code 552 cap", () => {
    const email = loadFixture("bounce-multipart-report.eml");
    const result = parseSizeLimitFromBounce(email);
    expect(result).not.toBeNull();
    expect(result?.recipientDomain).toBe("icloud.com");
    expect(result?.capBytes).toBe(20971520);
  });

  it("Case D: bounce-non-size-other-failure.eml (550 user unknown) → null", () => {
    const email = loadFixture("bounce-non-size-other-failure.eml");
    const result = parseSizeLimitFromBounce(email);
    expect(result).toBeNull();
  });

  it("Case E: bounce-auto-reply.eml (Out of Office) → null", () => {
    const email = loadFixture("bounce-auto-reply.eml");
    const result = parseSizeLimitFromBounce(email);
    expect(result).toBeNull();
  });

  it("Case F: empty email body → null", () => {
    const email = makeEmail({ text: "" });
    const result = parseSizeLimitFromBounce(email);
    expect(result).toBeNull();
  });

  it("Case G: cap value 100 (below MIN_REASONABLE_CAP_BYTES) → null", () => {
    // The digit run '100' is 3 digits — SIZE_BYTES_REGEX requires 6-11 digits,
    // so 100 is not even captured. Use a large-ish but below-1MB value.
    const email = makeEmail({
      text: [
        "552 5.3.4 Message size 524287 exceeds limit",
        "Final-Recipient: rfc822; foo@qq.com",
      ].join("\n"),
    });
    const result = parseSizeLimitFromBounce(email);
    // 524287 is 6 digits but below MIN_REASONABLE_CAP_BYTES (1_048_576)
    expect(result).toBeNull();
  });

  it("Case H (line-scoping): noise digit run in Message-ID line does NOT steal the cap; real cap on 552 line is returned", () => {
    // The Message-ID contains a 13-digit run '1234567890123' which would be caught
    // by SIZE_BYTES_REGEX if we scanned the whole body. The parser must only scan
    // lines that ALSO carry the SMTP 55x code.
    const email = makeEmail({
      text: [
        "In-Reply-To: <1234567890123@adam.example.org>",
        "Received: from smtp.qq.com by mx.example.com",
        "552 5.3.4 Message size 20971520 exceeds limit",
        "Final-Recipient: rfc822; foo@qq.com",
      ].join("\n"),
    });
    const result = parseSizeLimitFromBounce(email);
    expect(result).not.toBeNull();
    expect(result?.recipientDomain).toBe("qq.com");
    expect(result?.capBytes).toBe(20971520);
  });

  it("Case I (domain injection): malformed Final-Recipient domain fails RECIPIENT_DOMAIN_REGEX → null", () => {
    // The attacker injects characters outside [a-z0-9.-] into the domain part.
    // The parser must return null because the extracted domain fails RECIPIENT_DOMAIN_REGEX.
    const email = makeEmail({
      text: [
        '552 5.3.4 Message size 20971520 exceeds limit',
        'Final-Recipient: rfc822; user@qq.com"; DROP TABLE channels --',
      ].join("\n"),
    });
    const result = parseSizeLimitFromBounce(email);
    expect(result).toBeNull();
  });
});
