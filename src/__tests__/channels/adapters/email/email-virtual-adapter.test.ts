import { describe, expect, it, vi } from "vitest";
import type { Channel } from "../../../../shared/types.js";
import { EmailVirtualAdapter } from "../../../../channels/adapters/email/email-virtual-adapter.js";
import type { EmailGateway, ParsedInboundEmail } from "../../../../channels/adapters/email/email-gateway.js";

describe("EmailVirtualAdapter", () => {
  it("accepts inbound email as a channel message", () => {
    const adapter = new EmailVirtualAdapter(channel("Client Mail", "test1@test.com"), fakeGateway());
    const handler = vi.fn();
    adapter.onMessage(handler);

    adapter.acceptInbound(email({ from: "Test1@Test.com", text: "Hello" }));

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "mail-1",
      platform: "email",
      chatId: "test1@test.com",
      senderId: "test1@test.com",
      content: "Hello",
      replyToMessageId: "<inbound@example.com>",
      raw: expect.objectContaining({
        subject: "Subject",
        attachmentCount: 0,
      }),
    }));
  });

  it("sends to the normalized configured recipient", async () => {
    const gateway = fakeGateway();
    const adapter = new EmailVirtualAdapter(channel("Client Mail", "test1@test.com"), gateway);

    await expect(adapter.sendMessage("TEST1@test.com", { content: "Hello" })).resolves.toBe("<sent@example.com>");
    expect(gateway.send).toHaveBeenCalledWith(expect.objectContaining({
      to: "test1@test.com",
      text: "Hello",
    }));
  });

  it("rejects mismatched recipients", async () => {
    const adapter = new EmailVirtualAdapter(channel("Client Mail", "test1@test.com"), fakeGateway());

    await expect(adapter.sendMessage("other@test.com", { content: "Hello" })).rejects.toThrow("does not match");
  });
});

function channel(name: string, address: string): Channel {
  return {
    id: "mail-1",
    name,
    platform: "email",
    enabled: true,
    status: "disconnected",
    config: { address },
    createdAt: 1,
    messageCount: 0,
  };
}

function email(overrides: Partial<ParsedInboundEmail>): ParsedInboundEmail {
  return {
    messageId: "<inbound@example.com>",
    from: "test1@test.com",
    to: ["adam@example.com"],
    subject: "Subject",
    text: "Hello",
    date: 123,
    rawHeaders: {},
    attachmentCount: 0,
    ...overrides,
  };
}

function fakeGateway(): EmailGateway {
  return {
    getStatus: vi.fn(() => ({ status: "connected" })),
    send: vi.fn(async () => "<sent@example.com>"),
    isSentByAdam: vi.fn(() => false),
  } as unknown as EmailGateway;
}
