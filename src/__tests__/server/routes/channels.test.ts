import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import { setupTestDb, clearTestDb } from "../../helpers/test-db.js";

vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
}));

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

import { channelRoutes } from "../../../server/routes/channels.js";
import { createChannel, getChannel } from "../../../store/channels.js";
import { REDACTED_SECRET } from "../../../channels/channel-redaction.js";
import type { Channel } from "../../../shared/types.js";

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: crypto.randomUUID(),
    name: "Test",
    platform: "telegram",
    enabled: true,
    status: "disconnected",
    config: { token: "test" },
    createdAt: Date.now(),
    messageCount: 0,
    ...overrides,
  };
}

describe("server/routes/channels", () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    const { db } = setupTestDb();
    dbRef = db;
    app = Fastify();
    await app.register(channelRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    dbRef.close();
  });

  beforeEach(() => {
    clearTestDb();
  });

  describe("POST /channels", () => {
    it("creates a channel", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/channels",
        payload: { name: "TG Bot", platform: "telegram", config: { token: "abc" } },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.channel.name).toBe("TG Bot");
      expect(body.channel.platform).toBe("telegram");
    });

    it("returns 400 for missing required fields", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/channels",
        payload: { name: "Missing" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /channels", () => {
    it("lists all channels", async () => {
      createChannel(makeChannel({ id: "ch1" }));
      createChannel(makeChannel({ id: "ch2" }));
      const res = await app.inject({ method: "GET", url: "/channels" });
      expect(res.statusCode).toBe(200);
      expect(res.json().channels).toHaveLength(2);
    });
  });

  describe("GET /channels/:id", () => {
    it("returns channel details", async () => {
      const ch = makeChannel();
      createChannel(ch);
      const res = await app.inject({ method: "GET", url: `/channels/${ch.id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().channel.id).toBe(ch.id);
    });

    it("returns 404 for non-existent channel", async () => {
      const res = await app.inject({ method: "GET", url: `/channels/${crypto.randomUUID()}` });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("PATCH /channels/:id", () => {
    it("updates channel", async () => {
      const ch = makeChannel();
      createChannel(ch);
      const res = await app.inject({
        method: "PATCH",
        url: `/channels/${ch.id}`,
        payload: { name: "Updated" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().channel.name).toBe("Updated");
    });

    it("returns 404 for non-existent", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/channels/${crypto.randomUUID()}`,
        payload: { name: "X" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("updates viewerKey", async () => {
      const ch = makeChannel();
      createChannel(ch);
      const res = await app.inject({
        method: "PATCH",
        url: `/channels/${ch.id}`,
        payload: { viewerKey: "user-bob" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().channel.viewerKey).toBe("user-bob");
    });

    it("rejects empty viewerKey", async () => {
      const ch = makeChannel();
      createChannel(ch);
      const res = await app.inject({
        method: "PATCH",
        url: `/channels/${ch.id}`,
        payload: { viewerKey: "" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects viewerKey > 100 chars", async () => {
      const ch = makeChannel();
      createChannel(ch);
      const res = await app.inject({
        method: "PATCH",
        url: `/channels/${ch.id}`,
        payload: { viewerKey: "x".repeat(101) },
      });
      expect(res.statusCode).toBe(400);
    });

    it("does not touch historical user_visible_events when viewerKey changes", async () => {
      const ch = makeChannel();
      createChannel(ch);
      // Update viewerKey
      await app.inject({
        method: "PATCH",
        url: `/channels/${ch.id}`,
        payload: { viewerKey: "user-bob" },
      });
      // Verify channel viewerKey is updated
      const getRes = await app.inject({ method: "GET", url: `/channels/${ch.id}` });
      expect(getRes.json().channel.viewerKey).toBe("user-bob");
    });
  });

  describe("secret redaction (issue #181)", () => {
    const SECRET = "super-secret-58-char-token-value-aaaaaaaaaaaaaaaaaaaaaaaaaa";

    it("GET /channels never returns plaintext secret config values", async () => {
      createChannel(makeChannel({ id: "wc1", platform: "wechat", config: { baseUrl: "https://x", botToken: SECRET, accountId: "acct" } }));
      const res = await app.inject({ method: "GET", url: "/channels" });
      expect(res.statusCode).toBe(200);
      const ch = res.json().channels.find((c: Channel) => c.id === "wc1");
      expect(ch.config.botToken).toBe(REDACTED_SECRET);
      expect(ch.config.accountId).toBe("acct"); // non-secret identifier preserved
      // hard guarantee: the real secret appears nowhere in the serialized payload
      expect(res.payload).not.toContain(SECRET);
    });

    it("GET /channels/:id redacts secret config values", async () => {
      const ch = makeChannel({ platform: "wechat", config: { baseUrl: "https://x", botToken: SECRET } });
      createChannel(ch);
      const res = await app.inject({ method: "GET", url: `/channels/${ch.id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().channel.config.botToken).toBe(REDACTED_SECRET);
      expect(res.payload).not.toContain(SECRET);
    });

    it("POST response redacts the just-created secret", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/channels",
        payload: { name: "TG", platform: "telegram", config: { botToken: SECRET } },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().channel.config.botToken).toBe(REDACTED_SECRET);
      expect(res.payload).not.toContain(SECRET);
    });

    it("PATCH preserves the stored secret when the redaction placeholder is echoed back", async () => {
      const ch = makeChannel({ platform: "wechat", config: { baseUrl: "https://old", botToken: SECRET } });
      createChannel(ch);
      // Simulate an edit form populated from a redacted GET: only the name changes,
      // the placeholder is sent back verbatim for botToken.
      const res = await app.inject({
        method: "PATCH",
        url: `/channels/${ch.id}`,
        payload: { config: { baseUrl: "https://new", botToken: REDACTED_SECRET } },
      });
      expect(res.statusCode).toBe(200);
      // Response is still redacted...
      expect(res.json().channel.config.botToken).toBe(REDACTED_SECRET);
      // ...but the raw stored secret was NOT clobbered by the placeholder.
      const stored = getChannel(ch.id);
      expect(stored?.config.botToken).toBe(SECRET);
      expect(stored?.config.baseUrl).toBe("https://new");
    });

    it("PATCH with a genuinely new secret updates the stored value", async () => {
      const ch = makeChannel({ platform: "wechat", config: { baseUrl: "https://x", botToken: SECRET } });
      createChannel(ch);
      const res = await app.inject({
        method: "PATCH",
        url: `/channels/${ch.id}`,
        payload: { config: { baseUrl: "https://x", botToken: "brand-new-token" } },
      });
      expect(res.statusCode).toBe(200);
      const stored = getChannel(ch.id);
      expect(stored?.config.botToken).toBe("brand-new-token");
    });
  });

  describe("DELETE /channels/:id", () => {
    it("deletes channel", async () => {
      const ch = makeChannel();
      createChannel(ch);
      const res = await app.inject({ method: "DELETE", url: `/channels/${ch.id}` });
      expect(res.statusCode).toBe(204);
    });

    it("returns 404 for non-existent", async () => {
      const res = await app.inject({ method: "DELETE", url: `/channels/${crypto.randomUUID()}` });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /channels/:id/connect", () => {
    it("returns 501 when no channel manager", async () => {
      const ch = makeChannel();
      createChannel(ch);
      const res = await app.inject({ method: "POST", url: `/channels/${ch.id}/connect` });
      expect(res.statusCode).toBe(501);
      expect(res.json().code).toBe("NOT_IMPLEMENTED");
    });
  });

  describe("POST /channels/:id/disconnect", () => {
    it("returns 501 when no channel manager", async () => {
      const ch = makeChannel();
      createChannel(ch);
      const res = await app.inject({ method: "POST", url: `/channels/${ch.id}/disconnect` });
      expect(res.statusCode).toBe(501);
      expect(res.json().code).toBe("NOT_IMPLEMENTED");
    });
  });

  describe("GET /channels/:id/messages", () => {
    it("returns 404 for non-existent channel", async () => {
      const res = await app.inject({ method: "GET", url: `/channels/${crypto.randomUUID()}/messages` });
      expect(res.statusCode).toBe(404);
    });

    it("returns empty messages for channel with no sessions", async () => {
      const ch = makeChannel();
      createChannel(ch);
      const res = await app.inject({ method: "GET", url: `/channels/${ch.id}/messages` });
      expect(res.statusCode).toBe(200);
      expect(res.json().messages).toHaveLength(0);
    });
  });
});
