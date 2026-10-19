import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";
import { ChannelManager } from "../../channels/manager.js";
import { createChannel, listChannels } from "../../store/channels.js";
import type { Channel } from "../../shared/types.js";

const emailRuntime = vi.hoisted(() => ({
  enabled: false,
  status: "stopped",
}));

vi.mock("../../store/db.js", () => ({
  getDb: () => dbRef,
}));

vi.mock("../../channels/adapters/email/email-gateway.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/adapters/email/email-gateway.js")>("../../channels/adapters/email/email-gateway.js");
  return {
    ...actual,
    getEmailGateway: () => ({
      getStatus: () => ({ status: emailRuntime.status }),
      onInbound: vi.fn(),
      isSentByAdam: vi.fn(() => false),
      send: vi.fn(async () => "<sent@example.com>"),
    }),
    startEmailGatewayFromConfig: vi.fn(async () => {
      emailRuntime.status = "connected";
    }),
  };
});

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({
    emailGateway: {
      enabled: emailRuntime.enabled,
      address: "adam@example.com",
      displayName: "Adam",
      imap: { host: "imap.example.com", port: 993, secure: true, auth: { user: "adam@example.com", pass: "secret" }, mailbox: "INBOX" },
      smtp: { host: "smtp.example.com", port: 465, secure: true, auth: { user: "adam@example.com", pass: "secret" }, from: "" },
      subjectPrefix: "Adam",
    },
  }),
}));

let dbRef: ReturnType<typeof setupTestDb>["db"];

beforeEach(() => {
  if (!dbRef) dbRef = setupTestDb().db;
  emailRuntime.enabled = false;
  emailRuntime.status = "stopped";
  clearTestDb();
});

describe("email channel connect routes", () => {
  it("connect creates an adapter for a valid Mail channel", async () => {
    emailRuntime.enabled = true;
    const manager = new ChannelManager();
    const app = await appWithManager(manager);
    createChannel(channel({ id: crypto.randomUUID(), platform: "email", config: { address: "client@example.com" } }));
    const mail = getChannelByPlatform("email");

    const res = await app.inject({ method: "POST", url: `/channels/${mail.id}/connect` });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("connected");
    expect(manager.hasAdapter(mail.id)).toBe(true);
    await app.close();
  });

  it("connect returns Email Gateway error when the gateway is disabled", async () => {
    const manager = new ChannelManager();
    const app = await appWithManager(manager);
    createChannel(channel({ id: crypto.randomUUID(), platform: "email", config: { address: "client@example.com" } }));
    const mail = getChannelByPlatform("email");

    const res = await app.inject({ method: "POST", url: `/channels/${mail.id}/connect` });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("EMAIL_GATEWAY_NOT_READY");
    expect(res.json().message).toContain("Email Gateway is disabled");
    await app.close();
  });

  it("connect returns validation error when config.address is missing", async () => {
    emailRuntime.enabled = true;
    const manager = new ChannelManager();
    const app = await appWithManager(manager);
    createChannel(channel({ id: crypto.randomUUID(), platform: "email", config: {} }));
    const mail = getChannelByPlatform("email");

    const res = await app.inject({ method: "POST", url: `/channels/${mail.id}/connect` });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("POST /channels rejects invalid email config before persistence", async () => {
    const app = await appWithManager(new ChannelManager());

    const res = await app.inject({
      method: "POST",
      url: "/channels",
      payload: { name: "Client Mail", platform: "email", enabled: true, config: {} },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("POST /channels registers a valid enabled Mail channel", async () => {
    const manager = new ChannelManager();
    const app = await appWithManager(manager);

    const res = await app.inject({
      method: "POST",
      url: "/channels",
      payload: { name: "Client Mail", platform: "email", enabled: true, config: { address: "Client@Example.com" } },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.channel.config.address).toBe("client@example.com");
    expect(manager.hasAdapter(body.channel.id)).toBe(true);
    await app.close();
  });

  it("PATCH changing Mail channel address refreshes the adapter", async () => {
    const manager = new ChannelManager();
    const app = await appWithManager(manager);
    createChannel(channel({ id: crypto.randomUUID(), platform: "email", config: { address: "old@example.com" } }));
    const mail = getChannelByPlatform("email");

    const res = await app.inject({
      method: "PATCH",
      url: `/channels/${mail.id}`,
      payload: { config: { address: "new@example.com" } },
    });

    expect(res.statusCode).toBe(200);
    expect(manager.hasAdapter(mail.id)).toBe(true);
    expect(res.json().channel.config.address).toBe("new@example.com");
    await app.close();
  });

  it("DELETE removes the Mail channel adapter", async () => {
    const manager = new ChannelManager();
    const app = await appWithManager(manager);
    createChannel(channel({ id: crypto.randomUUID(), platform: "email", config: { address: "client@example.com" } }));
    const mail = getChannelByPlatform("email");
    await app.inject({ method: "POST", url: `/channels/${mail.id}/connect` });

    const res = await app.inject({ method: "DELETE", url: `/channels/${mail.id}` });

    expect(res.statusCode).toBe(204);
    expect(manager.hasAdapter(mail.id)).toBe(false);
    await app.close();
  });
});

async function appWithManager(manager: ChannelManager) {
  const { channelRoutes, setChannelManager } = await import("../../server/routes/channels.js");
  setChannelManager(manager);
  const app = Fastify();
  await app.register(channelRoutes);
  await app.ready();
  return app;
}

function getChannelByPlatform(platform: string): Channel {
  const channel = listChannels().find((candidate) => candidate.platform === platform);
  if (!channel) throw new Error(`Missing ${platform} channel`);
  return channel;
}

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
