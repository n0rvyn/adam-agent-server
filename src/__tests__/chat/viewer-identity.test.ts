import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { initRuntimeConfig } from "../../config/runtime.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import { createChannel } from "../../store/channels.js";
import { createSession } from "../../store/sessions.js";
import { resolveViewerKeyForDeliveryTarget, resolveViewerKeyForSource } from "../../chat/viewer-identity.js";

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  initRuntimeConfig({
    ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
    identity: { ownerViewerKey: "owner-test" },
  });
});

describe("chat/viewer-identity", () => {
  it("resolves Web, TUI, and API sources to the owner viewer key", () => {
    expect(resolveViewerKeyForSource({ type: "web" })).toBe("owner-test");
    expect(resolveViewerKeyForSource({ type: "tui" })).toBe("owner-test");
    expect(resolveViewerKeyForSource({ type: "api" })).toBe("owner-test");
  });

  it("resolves channel sources from channel.viewerKey", () => {
    createChannel({
      id: "ch-1",
      name: "Email",
      platform: "email",
      enabled: true,
      status: "connected",
      config: {},
      viewerKey: "email-owner",
      createdAt: 1,
      messageCount: 0,
    });

    expect(resolveViewerKeyForSource({ type: "channel", channelId: "ch-1", chatId: "mail" })).toBe("email-owner");
  });

  it("fails closed for unmapped channels", () => {
    createChannel({
      id: "ch-2",
      name: "Unmapped",
      platform: "email",
      enabled: true,
      status: "connected",
      config: {},
      createdAt: 1,
      messageCount: 0,
    });

    expect(resolveViewerKeyForSource({ type: "channel", channelId: "ch-2", chatId: "mail" })).toBeUndefined();
    expect(resolveViewerKeyForDeliveryTarget({ type: "channel", channelId: "ch-2", chatId: "mail" })).toBeUndefined();
  });

  it("resolves session delivery targets through their source", () => {
    createSession({
      id: "session-1",
      status: "active",
      source: { type: "web" },
      createdAt: 1,
      lastActiveAt: 1,
      messageCount: 0,
    });

    expect(resolveViewerKeyForDeliveryTarget({ type: "session", sessionId: "session-1" })).toBe("owner-test");
  });
});
