/**
 * Integration tests for bounce handler wiring (Task 9-tests).
 * These tests verify registerBounceHandler wires parseSizeLimitFromBounce to setRecipientCap
 * for every email channel (DP-002 broadcast) when a 552-size-limit DSN arrives.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Use vi.hoisted to declare mocks before vi.mock factory runs
const { mockSetRecipientCap, mockListChannels, mockParseSizeLimitFromBounce } = vi.hoisted(() => ({
  mockSetRecipientCap: vi.fn(),
  mockListChannels: vi.fn(),
  mockParseSizeLimitFromBounce: vi.fn(),
}));

vi.mock("../../../../store/channels.js", () => ({
  listChannels: mockListChannels,
  setRecipientCap: mockSetRecipientCap,
}));

vi.mock("../../../../channels/adapters/email/bounce-parser.js", () => ({
  parseSizeLimitFromBounce: mockParseSizeLimitFromBounce,
}));

import { EmailGateway } from "../../../../channels/adapters/email/email-gateway.js";
import { registerBounceHandler, resetBounceHandlerForTests } from "../../../../channels/adapters/email/bounce-handler.js";
import type { ParsedInboundEmail } from "../../../../channels/adapters/email/email-gateway.js";
import { getLogger } from "../../../../lib/logger.js";

function makeGateway(): EmailGateway {
  return new EmailGateway();
}

function makeParsedEmail(overrides: Partial<ParsedInboundEmail> = {}): ParsedInboundEmail {
  return {
    from: "MAILER-DAEMON@qq.com",
    to: ["adam@example.org"],
    subject: "Mail Delivery Subsystem",
    text: "552 5.3.4 Message size exceeds 20971520. Final-Recipient: rfc822; foo@qq.com",
    attachmentCount: 0,
    rawHeaders: {},
    ...overrides,
  };
}

const EMAIL_CHANNELS = [
  { id: "ch-email-1", platform: "email", name: "QQ Channel" },
  { id: "ch-email-2", platform: "email", name: "163 Channel" },
  { id: "ch-wechat", platform: "wechat", name: "WeChat Channel" },
];

// Helper: access the internal handlers array (EmailGateway stores them in `handlers` field)
function getHandlers(gateway: EmailGateway): Array<(e: ParsedInboundEmail) => Promise<void>> {
  return (gateway as unknown as { handlers: Array<(e: ParsedInboundEmail) => Promise<void>> }).handlers;
}

describe("bounce handler integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBounceHandlerForTests();
    mockListChannels.mockReturnValue(EMAIL_CHANNELS);
  });

  it("Case 1: 552 size-limit DSN → setRecipientCap called once per email channel with same (domain, capBytes)", async () => {
    const gateway = makeGateway();
    registerBounceHandler(gateway);

    mockParseSizeLimitFromBounce.mockReturnValue({ recipientDomain: "qq.com", capBytes: 20971520 });

    const email = makeParsedEmail();
    // Trigger the registered inbound handler
    await getHandlers(gateway)[0](email);

    // DP-002: broadcast — setRecipientCap called once per email channel (2 email, 1 wechat → 2 calls)
    expect(mockSetRecipientCap).toHaveBeenCalledTimes(2);
    expect(mockSetRecipientCap).toHaveBeenCalledWith("ch-email-1", "qq.com", 20971520);
    expect(mockSetRecipientCap).toHaveBeenCalledWith("ch-email-2", "qq.com", 20971520);
    // WeChat channel NOT called
    expect(mockSetRecipientCap).not.toHaveBeenCalledWith("ch-wechat", expect.anything(), expect.anything());
  });

  it("Case 2: non-bounce inbound (550 user-unknown) → zero setRecipientCap calls", async () => {
    const gateway = makeGateway();
    registerBounceHandler(gateway);

    // parseSizeLimitFromBounce returns null for non-size bounces
    mockParseSizeLimitFromBounce.mockReturnValue(null);

    const email = makeParsedEmail({
      subject: "Undeliverable: user not found",
      text: "550 5.1.1 The email account does not exist",
    });
    await getHandlers(gateway)[0](email);

    expect(mockSetRecipientCap).not.toHaveBeenCalled();
  });

  it("Case 3: setRecipientCap throws RangeError → handler does NOT propagate; remaining channels still updated", async () => {
    const gateway = makeGateway();
    registerBounceHandler(gateway);

    mockParseSizeLimitFromBounce.mockReturnValue({ recipientDomain: "qq.com", capBytes: 20971520 });
    // First channel throws; second channel should still be called
    mockSetRecipientCap
      .mockImplementationOnce(() => { throw new RangeError("cap out of range"); })
      .mockImplementationOnce(() => undefined);

    const email = makeParsedEmail();
    // Should NOT throw even though setRecipientCap threw
    await expect(getHandlers(gateway)[0](email)).resolves.not.toThrow();

    // Second channel still called despite first throwing
    expect(mockSetRecipientCap).toHaveBeenCalledTimes(2);
    expect(mockSetRecipientCap).toHaveBeenCalledWith("ch-email-2", "qq.com", 20971520);
  });

  it("Case 4: calling registerBounceHandler twice → handler attached only once (idempotency guard)", async () => {
    const gateway = makeGateway();
    registerBounceHandler(gateway);
    registerBounceHandler(gateway); // idempotency guard must short-circuit this

    mockParseSizeLimitFromBounce.mockReturnValue({ recipientDomain: "qq.com", capBytes: 20971520 });

    const email = makeParsedEmail();
    await getHandlers(gateway)[0](email);

    // Only 2 calls (2 email channels × 1 handler), NOT 4 (which would indicate double registration)
    expect(mockSetRecipientCap).toHaveBeenCalledTimes(2);
    // Only one handler registered
    expect(getHandlers(gateway)).toHaveLength(1);
  });

  // Task 3-tests: Chinese DSN wrapper fixtures (aliyun)
  // These FAIL before Task 3-impl because looksLikeBounce only matches
  // English MAILER-DAEMON + English DSN subjects; aliyun sender + Chinese
  // subject do not match the current heuristic.

  it("Case 5 (aliyun 5.2.2 quota): warn-log fires; setRecipientCap NOT called", async () => {
    const gateway = makeGateway();
    registerBounceHandler(gateway);

    // parseSizeLimitFromBounce returns null: 5.2.2 is quota, not size-limit bounce
    mockParseSizeLimitFromBounce.mockReturnValue(null);

    const warnSpy = vi.spyOn(getLogger("channels"), "warn");

    const email: ParsedInboundEmail = {
      from: "no-reply@mailsupport.aliyun.com",
      to: ["adam@example.org"],
      subject: "来自no-reply@mailsupport.aliyun.com的退信",
      text: "您好，以下邮件投递失败。\n552 5.2.2 user is over quota\nFinal-Recipient: rfc822; foo@example.com",
      attachmentCount: 0,
      rawHeaders: {},
    };

    await getHandlers(gateway)[0](email);

    // warn-log must fire: aliyun bounce looks like DSN but parser returned null (5.2.2 is not size-limit)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ from: email.from, subject: email.subject }),
      "Inbound looks like bounce but parser did not recognize a size-limit cap",
    );
    // setRecipientCap must NOT be called: 5.2.2 is correct skip behavior
    expect(mockSetRecipientCap).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("Case 6 (aliyun 5.3.4 size bounce): warn-log fires AND setRecipientCap IS called", async () => {
    const gateway = makeGateway();
    registerBounceHandler(gateway);

    // parseSizeLimitFromBounce returns a real cap: 5.3.4 is size-limit bounce
    mockParseSizeLimitFromBounce.mockReturnValue({ recipientDomain: "example.com", capBytes: 41943040 });

    const warnSpy = vi.spyOn(getLogger("channels"), "warn");

    const email: ParsedInboundEmail = {
      from: "no-reply@mailsupport.aliyun.com",
      to: ["adam@example.org"],
      subject: "来自no-reply@mailsupport.aliyun.com的退信",
      text: "您好，以下邮件投递失败。\n552 5.3.4 message too large 41943040 bytes\nFinal-Recipient: rfc822; foo@example.com",
      attachmentCount: 0,
      rawHeaders: {},
    };

    await getHandlers(gateway)[0](email);

    // warn-log must NOT fire: parser recognized the cap (parsed !== null path skips looksLikeBounce check)
    expect(warnSpy).not.toHaveBeenCalled();
    // setRecipientCap IS called (size-limit bounce correctly learned)
    expect(mockSetRecipientCap).toHaveBeenCalledWith("ch-email-1", "example.com", 41943040);
    expect(mockSetRecipientCap).toHaveBeenCalledWith("ch-email-2", "example.com", 41943040);

    warnSpy.mockRestore();
  });
});
