import { describe, expect, it } from "vitest";
import type { Channel, ChannelStatus } from "../../../../shared/types.js";
import {
  getNormalizedMailChannelAddress,
  isEmailPlatform,
  parseMailChannelConfig,
} from "../../../../channels/adapters/email/address.js";

describe("mail channel config", () => {
  it("accepts only { address: string }", () => {
    expect(parseMailChannelConfig({ address: "Test.User@Example.COM" })).toEqual({
      address: "test.user@example.com",
    });
    expect(() => parseMailChannelConfig({ address: "a@example.com", label: "extra" })).toThrow("only address");
    expect(() => parseMailChannelConfig({})).toThrow("only address");
  });

  it("identifies only email platform channels", () => {
    expect(isEmailPlatform(channel({ platform: "email", address: "a@example.com" }))).toBe(true);
    expect(isEmailPlatform(channel({ platform: "slack", address: "a@example.com" }))).toBe(false);
  });

  it("existing email row with valid address registers after normalization", () => {
    const registry = registerExistingEmailChannels([
      channel({ id: "mail-1", platform: "email", address: "Test.User@Example.COM" }),
    ]);

    expect(registry.addresses).toEqual(["test.user@example.com"]);
    expect(registry.statusById.get("mail-1")).toBe("connected");
  });

  it("existing email row without valid address is marked unavailable and not registered", () => {
    const registry = registerExistingEmailChannels([
      channel({ id: "mail-1", platform: "email", config: {} }),
      channel({ id: "mail-2", platform: "email", address: "a@example.com,b@example.com" }),
      channel({ id: "slack-1", platform: "slack", address: "a@example.com" }),
    ]);

    expect(registry.addresses).toEqual([]);
    expect(registry.statusById.get("mail-1")).toBe("error");
    expect(registry.statusById.get("mail-2")).toBe("error");
    expect(registry.statusById.has("slack-1")).toBe(false);
  });
});

function registerExistingEmailChannels(channels: Channel[]): {
  addresses: string[];
  statusById: Map<string, ChannelStatus>;
} {
  const addresses: string[] = [];
  const statusById = new Map<string, ChannelStatus>();
  for (const candidate of channels) {
    if (!isEmailPlatform(candidate)) continue;
    try {
      addresses.push(getNormalizedMailChannelAddress(candidate));
      statusById.set(candidate.id, "connected");
    } catch {
      statusById.set(candidate.id, "error");
    }
  }
  return { addresses, statusById };
}

function channel(opts: {
  id?: string;
  platform: string;
  address?: string;
  config?: Record<string, unknown>;
}): Channel {
  return {
    id: opts.id ?? "channel-1",
    name: opts.id ?? "Channel",
    platform: opts.platform,
    enabled: true,
    status: "disconnected",
    config: opts.config ?? { address: opts.address },
    createdAt: 1,
    messageCount: 0,
  };
}
