import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "../../shared/types.js";
import { ChannelManager } from "../../channels/manager.js";
import { registerBuiltInAdapter, registerEnabledBuiltInAdapters } from "../../channels/built-in-adapters.js";
import { createChannel } from "../../store/channels.js";
import { clearTestDb, setupTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => dbRef,
}));

vi.mock("../../channels/adapters/email/email-gateway.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/adapters/email/email-gateway.js")>("../../channels/adapters/email/email-gateway.js");
  return {
    ...actual,
    getEmailGateway: () => ({
      getStatus: () => ({ status: "stopped" }),
      onInbound: vi.fn(),
      isSentByAdam: vi.fn(() => false),
      send: vi.fn(async () => "<sent@example.com>"),
    }),
    startEmailGatewayFromConfig: vi.fn(async () => undefined),
  };
});

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({ emailGateway: { enabled: false } }),
}));

let dbRef: ReturnType<typeof setupTestDb>["db"];

beforeEach(() => {
  if (!dbRef) dbRef = setupTestDb().db;
  clearTestDb();
});

describe("built-in adapter registration", () => {
  it("registers enabled email channels at startup", async () => {
    const manager = new ChannelManager();
    createChannel(channel({ id: "mail-1", platform: "email", config: { address: "Client@Example.com" } }));

    await registerEnabledBuiltInAdapters(manager);

    expect(manager.hasAdapter("mail-1")).toBe(true);
  });

  it("returns false for Discord without botToken preserving lazy-connect validation", async () => {
    const manager = new ChannelManager();
    const registered = await registerBuiltInAdapter(manager, channel({ id: "discord-1", platform: "discord", config: {} }));

    expect(registered).toBe(false);
    expect(manager.hasAdapter("discord-1")).toBe(false);
  });

  it("throws validation errors for invalid email config", async () => {
    const manager = new ChannelManager();

    await expect(registerBuiltInAdapter(manager, channel({ id: "mail-1", platform: "email", config: {} }))).rejects.toThrow("address");
  });
});

function channel(overrides: Partial<Channel>): Channel {
  return {
    id: "ch-1",
    name: "Channel",
    platform: "telegram",
    enabled: true,
    status: "disconnected",
    config: {},
    createdAt: Date.now(),
    messageCount: 0,
    ...overrides,
  };
}
