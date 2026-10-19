import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
}));

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

import { createChannel, getChannel, updateChannel, listChannels, deleteChannel, updateChannelStatus } from "../../store/channels.js";
import type { Channel } from "../../shared/types.js";

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: `ch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: "Test Channel",
    platform: "telegram",
    enabled: true,
    status: "disconnected",
    config: { botToken: "test-token" },
    createdAt: Date.now(),
    messageCount: 0,
    ...overrides,
  };
}

describe("store/channels", () => {
  beforeAll(() => {
    const { db } = setupTestDb();
    dbRef = db;
  });

  afterAll(() => {
    dbRef.close();
  });

  beforeEach(() => {
    clearTestDb();
  });

  it("creates and retrieves a channel", () => {
    const channel = makeChannel();
    createChannel(channel);
    const retrieved = getChannel(channel.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe("Test Channel");
    expect(retrieved!.platform).toBe("telegram");
    expect(retrieved!.enabled).toBe(true);
    expect(retrieved!.config).toEqual({ botToken: "test-token" });
  });

  it("returns undefined for non-existent channel", () => {
    expect(getChannel("nonexistent")).toBeUndefined();
  });

  it("updates channel fields", () => {
    const channel = makeChannel();
    createChannel(channel);
    updateChannel(channel.id, { name: "Updated", enabled: false, config: { newKey: "val" } });
    const updated = getChannel(channel.id);
    expect(updated!.name).toBe("Updated");
    expect(updated!.enabled).toBe(false);
    expect(updated!.config).toEqual({ newKey: "val" });
    expect(updated!.updatedAt).toBeDefined();
  });

  it("lists channels filtered by enabled", () => {
    createChannel(makeChannel({ id: "ch1", enabled: true }));
    createChannel(makeChannel({ id: "ch2", enabled: false }));
    createChannel(makeChannel({ id: "ch3", enabled: true }));

    const enabled = listChannels(true);
    expect(enabled).toHaveLength(2);

    const disabled = listChannels(false);
    expect(disabled).toHaveLength(1);

    const all = listChannels();
    expect(all).toHaveLength(3);
  });

  it("deletes a channel", () => {
    const channel = makeChannel();
    createChannel(channel);
    deleteChannel(channel.id);
    expect(getChannel(channel.id)).toBeUndefined();
  });

  it("updates channel status", () => {
    const channel = makeChannel();
    createChannel(channel);
    updateChannelStatus(channel.id, "connected");
    const updated = getChannel(channel.id);
    expect(updated!.status).toBe("connected");
  });

  it("serializes and deserializes allowedChatIds", () => {
    const channel = makeChannel({ allowedChatIds: ["chat1", "chat2"] });
    createChannel(channel);
    const retrieved = getChannel(channel.id);
    expect(retrieved!.allowedChatIds).toEqual(["chat1", "chat2"]);
  });

  it("handles null allowedChatIds", () => {
    const channel = makeChannel();
    createChannel(channel);
    const retrieved = getChannel(channel.id);
    expect(retrieved!.allowedChatIds).toBeUndefined();
  });

  it("handles update with no fields gracefully", () => {
    const channel = makeChannel();
    createChannel(channel);
    updateChannel(channel.id, {});
    expect(getChannel(channel.id)!.name).toBe("Test Channel");
  });

  it("updateChannel writes viewer_key column", () => {
    const channel = makeChannel();
    createChannel(channel);
    updateChannel(channel.id, { viewerKey: "user-alice" });
    const updated = getChannel(channel.id);
    expect(updated!.viewerKey).toBe("user-alice");
  });
});
