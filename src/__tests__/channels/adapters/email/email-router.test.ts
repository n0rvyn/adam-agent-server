import { describe, expect, it, vi } from "vitest";
import type { Channel } from "../../../../shared/types.js";
import { EmailRouter } from "../../../../channels/adapters/email/email-router.js";
import type { EmailGateway, ParsedInboundEmail } from "../../../../channels/adapters/email/email-gateway.js";

describe("EmailRouter", () => {
  it("routes inbound email from a configured address", () => {
    const router = new EmailRouter(fakeGateway());
    const adapter = adapterDouble();
    router.registerAdapter(channel("mail-1", "client@example.com"), adapter);

    router.handle(email({ from: "Client@Example.com" }));

    expect(adapter.acceptInbound).toHaveBeenCalledOnce();
  });

  it("skips unknown senders", () => {
    const router = new EmailRouter(fakeGateway());
    const adapter = adapterDouble();
    router.registerAdapter(channel("mail-1", "client@example.com"), adapter);

    router.handle(email({ from: "unknown@example.com" }));

    expect(adapter.acceptInbound).not.toHaveBeenCalled();
  });

  it("skips Adam-sent message IDs", () => {
    const router = new EmailRouter(fakeGateway({ sent: true }));
    const adapter = adapterDouble();
    router.registerAdapter(channel("mail-1", "client@example.com"), adapter);

    router.handle(email({ messageId: "<sent@example.com>", from: "client@example.com" }));

    expect(adapter.acceptInbound).not.toHaveBeenCalled();
  });

  it("updates the router map for create, update, disconnect, and delete", () => {
    const router = new EmailRouter(fakeGateway());
    const adapter = adapterDouble();
    router.registerAdapter(channel("mail-1", "old@example.com"), adapter);
    expect(router.hasAddress("old@example.com")).toBe(true);

    router.registerAdapter(channel("mail-1", "new@example.com"), adapter);
    expect(router.hasAddress("old@example.com")).toBe(false);
    expect(router.hasAddress("new@example.com")).toBe(true);

    router.unregisterAdapter("mail-1");
    expect(router.hasAddress("new@example.com")).toBe(false);
  });

  it("refreshes from enabled email channels only", () => {
    const router = new EmailRouter(fakeGateway());
    const adapter = adapterDouble();
    router.refreshFromChannels([
      channel("mail-1", "enabled@example.com"),
      { ...channel("mail-2", "disabled@example.com"), enabled: false },
      { ...channel("slack-1", "slack@example.com"), platform: "slack" },
    ], new Map([["mail-1", adapter], ["mail-2", adapter], ["slack-1", adapter]]));

    expect(router.hasAddress("enabled@example.com")).toBe(true);
    expect(router.hasAddress("disabled@example.com")).toBe(false);
    expect(router.hasAddress("slack@example.com")).toBe(false);
  });
});

function channel(id: string, address: string): Channel {
  return {
    id,
    name: id,
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
    from: "client@example.com",
    to: ["adam@example.com"],
    text: "Hello",
    rawHeaders: {},
    attachmentCount: 0,
    ...overrides,
  };
}

function adapterDouble() {
  return { acceptInbound: vi.fn() } as any;
}

function fakeGateway(opts?: { sent?: boolean }): Pick<EmailGateway, "isSentByAdam"> {
  return { isSentByAdam: vi.fn(() => opts?.sent ?? false) };
}
