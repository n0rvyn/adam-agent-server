import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../../../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

// Mock fetch for API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock fs for persistence
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => false),
    },
    promises: {
      mkdir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      unlink: vi.fn(),
    },
  };
});

// Mock media modules
vi.mock("../../../channels/adapters/wechat/media/media-download.js", () => ({
  downloadMediaFromItem: vi.fn(),
}));
vi.mock("../../../channels/adapters/wechat/messaging/send-media.js", () => ({
  sendWeixinMediaFile: vi.fn(),
}));

import { WeChatAdapter } from "../../../channels/adapters/wechat/wechat.js";

function createAdapter(id = "test-channel"): WeChatAdapter {
  return new WeChatAdapter(id, { baseUrl: "https://example.com", botToken: "test-token" });
}

// Simulate connecting without actually starting long-poll
async function connectAdapter(adapter: WeChatAdapter): Promise<void> {
  // We can't easily connect without the long-poll, so we access internal state
  // via sendMessage which will create sessions on demand
}

describe("WeChat session & quota tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Default: API returns success
    mockFetch.mockResolvedValue({ ok: true, text: async () => "{}" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("session freshness gate", () => {
    it("queues message when no session exists (no prior user message)", async () => {
      const adapter = createAdapter();
      const result = await adapter.sendMessage("user1", { content: "hello" });
      expect(result).toMatch(/^queued-/);
      // No API call should be made
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("queues message when session is expired (>24h)", async () => {
      const adapter = createAdapter();
      // Simulate an old session by manually setting internal state
      const sessions = (adapter as any).sessions as Map<string, { lastUserMessageAt: number; quotaRemaining: number }>;
      sessions.set("user1", {
        lastUserMessageAt: Date.now() - 25 * 60 * 60 * 1000, // 25h ago
        quotaRemaining: 5,
      });

      const result = await adapter.sendMessage("user1", { content: "hello" });
      expect(result).toMatch(/^queued-/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("allows send when session is active (<24h) and has quota", async () => {
      const adapter = createAdapter();
      const sessions = (adapter as any).sessions as Map<string, { lastUserMessageAt: number; quotaRemaining: number }>;
      sessions.set("user1", {
        lastUserMessageAt: Date.now() - 1 * 60 * 60 * 1000, // 1h ago
        quotaRemaining: 5,
      });

      const result = await adapter.sendMessage("user1", { content: "hello" });
      expect(result).not.toMatch(/^queued-/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("quota tracking", () => {
    it("decrements quota on successful send", async () => {
      const adapter = createAdapter();
      const sessions = (adapter as any).sessions as Map<string, { lastUserMessageAt: number; quotaRemaining: number }>;
      sessions.set("user1", {
        lastUserMessageAt: Date.now(),
        quotaRemaining: 5,
      });

      await adapter.sendMessage("user1", { content: "hello" });
      expect(sessions.get("user1")!.quotaRemaining).toBe(4);
    });

    it("queues when quota is exhausted", async () => {
      const adapter = createAdapter();
      const sessions = (adapter as any).sessions as Map<string, { lastUserMessageAt: number; quotaRemaining: number }>;
      sessions.set("user1", {
        lastUserMessageAt: Date.now(),
        quotaRemaining: 0,
      });

      const result = await adapter.sendMessage("user1", { content: "hello" });
      expect(result).toMatch(/^queued-/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("sets quota to 0 and queues on ret=-2 error", async () => {
      // Use real timers for this test — ret=-2 retry uses setTimeout(1s)
      vi.useRealTimers();
      mockFetch.mockResolvedValue({ ok: true, text: async () => '{"ret":-2}' });

      const adapter = createAdapter();
      const sessions = (adapter as any).sessions as Map<string, { lastUserMessageAt: number; quotaRemaining: number }>;
      sessions.set("user1", {
        lastUserMessageAt: Date.now(),
        quotaRemaining: 5,
      });

      const result = await adapter.sendMessage("user1", { content: "hello" });
      expect(result).toMatch(/^queued-/);
      expect(sessions.get("user1")!.quotaRemaining).toBe(0);
      vi.useFakeTimers(); // restore for other tests
    });

    it("resets quota to QUOTA_MAX on inbound message", async () => {
      const adapter = createAdapter();
      const sessions = (adapter as any).sessions as Map<string, { lastUserMessageAt: number; quotaRemaining: number }>;
      sessions.set("user1", {
        lastUserMessageAt: Date.now() - 60_000,
        quotaRemaining: 0,
      });

      // Set up message handler
      let receivedMessage: any;
      adapter.onMessage((msg) => { receivedMessage = msg; });

      // Simulate inbound message
      const processInbound = (adapter as any).processInbound.bind(adapter);
      await processInbound({
        from_user_id: "user1",
        context_token: "ctx-new",
        item_list: [{ type: 1, text_item: { text: "hi" } }],
        create_time_ms: Date.now(),
      });

      expect(sessions.get("user1")!.quotaRemaining).toBe(10);
      expect(sessions.get("user1")!.lastUserMessageAt).toBeGreaterThan(0);
    });
  });

  describe("message queue", () => {
    it("enqueues and respects MAX_QUEUE_PER_CHAT", async () => {
      const adapter = createAdapter();
      const pendingQueue = (adapter as any).pendingQueue as Map<string, any[]>;

      // Queue 20 messages (max)
      for (let i = 0; i < 21; i++) {
        await adapter.sendMessage("user1", { content: `msg ${i}` });
      }

      expect(pendingQueue.get("user1")!.length).toBe(20);
    });

    it("flushes queue on inbound message (reserves 2 for conversation)", async () => {
      const adapter = createAdapter();
      const sessions = (adapter as any).sessions as Map<string, { lastUserMessageAt: number; quotaRemaining: number }>;
      sessions.set("user1", { lastUserMessageAt: Date.now() - 60_000, quotaRemaining: 0 });

      // Queue 5 messages
      for (let i = 0; i < 5; i++) {
        await adapter.sendMessage("user1", { content: `queued ${i}` });
      }
      expect((adapter as any).pendingQueue.get("user1")!.length).toBe(5);

      // Reset mock for flush sends
      mockFetch.mockClear();
      mockFetch.mockResolvedValue({ ok: true, text: async () => "{}" });

      // Simulate inbound → triggers quota reset + flush
      adapter.onMessage(() => {});
      const processInbound = (adapter as any).processInbound.bind(adapter);
      await processInbound({
        from_user_id: "user1",
        context_token: "ctx-new",
        item_list: [{ type: 1, text_item: { text: "trigger" } }],
        create_time_ms: Date.now(),
      });

      // Wait for async flush
      await vi.advanceTimersByTimeAsync(100);

      // Should have sent messages (quota=10, reserve 2, max 8, but only 5 queued)
      // Each send = 1 fetch call
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe("getStatus degraded", () => {
    it("returns 'degraded' when active session has quota=0", () => {
      const adapter = createAdapter();
      const sessions = (adapter as any).sessions as Map<string, { lastUserMessageAt: number; quotaRemaining: number }>;
      (adapter as any).status = "connected";
      sessions.set("user1", {
        lastUserMessageAt: Date.now(), // active
        quotaRemaining: 0,
      });

      expect(adapter.getStatus()).toBe("degraded");
    });

    it("returns 'connected' when expired session has quota=0 (not degraded)", () => {
      const adapter = createAdapter();
      const sessions = (adapter as any).sessions as Map<string, { lastUserMessageAt: number; quotaRemaining: number }>;
      (adapter as any).status = "connected";
      sessions.set("user1", {
        lastUserMessageAt: Date.now() - 25 * 60 * 60 * 1000, // expired
        quotaRemaining: 0,
      });

      expect(adapter.getStatus()).toBe("connected");
    });

    it("returns 'connected' when session has quota remaining", () => {
      const adapter = createAdapter();
      const sessions = (adapter as any).sessions as Map<string, { lastUserMessageAt: number; quotaRemaining: number }>;
      (adapter as any).status = "connected";
      sessions.set("user1", {
        lastUserMessageAt: Date.now(),
        quotaRemaining: 5,
      });

      expect(adapter.getStatus()).toBe("connected");
    });
  });

  describe("checkAndSendReminder", () => {
    it("sends reminder when quota ≤ 1", async () => {
      const adapter = createAdapter();
      const session = { lastUserMessageAt: Date.now() - 1 * 60 * 60 * 1000, quotaRemaining: 1 };
      const sessions = (adapter as any).sessions as Map<string, any>;
      sessions.set("user1", session);

      mockFetch.mockClear();
      mockFetch.mockResolvedValue({ ok: true, text: async () => "{}" });

      const check = (adapter as any).checkAndSendReminder.bind(adapter);
      await check("user1", session);

      // Reminder should have been sent (1 API call)
      expect(mockFetch).toHaveBeenCalledTimes(1);
      // Quota should have decremented
      expect(session.quotaRemaining).toBe(0);
    });

    it("sends reminder when ≤2h remaining (≥22h elapsed)", async () => {
      const adapter = createAdapter();
      const session = { lastUserMessageAt: Date.now() - 22.5 * 60 * 60 * 1000, quotaRemaining: 5 };
      const sessions = (adapter as any).sessions as Map<string, any>;
      sessions.set("user1", session);

      mockFetch.mockClear();
      mockFetch.mockResolvedValue({ ok: true, text: async () => "{}" });

      const check = (adapter as any).checkAndSendReminder.bind(adapter);
      await check("user1", session);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(session.quotaRemaining).toBe(4);
    });

    it("does not send reminder during cooldown", async () => {
      const adapter = createAdapter();
      const session = { lastUserMessageAt: Date.now() - 23 * 60 * 60 * 1000, quotaRemaining: 1 };
      const sessions = (adapter as any).sessions as Map<string, any>;
      sessions.set("user1", session);

      // Set recent reminder
      (adapter as any).lastReminderAt.set("user1", Date.now() - 30 * 60 * 1000); // 30min ago (within 2h cooldown)

      mockFetch.mockClear();
      const check = (adapter as any).checkAndSendReminder.bind(adapter);
      await check("user1", session);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("does not send reminder when neither threshold is met", async () => {
      const adapter = createAdapter();
      const session = { lastUserMessageAt: Date.now() - 1 * 60 * 60 * 1000, quotaRemaining: 5 };
      const sessions = (adapter as any).sessions as Map<string, any>;
      sessions.set("user1", session);

      mockFetch.mockClear();
      const check = (adapter as any).checkAndSendReminder.bind(adapter);
      await check("user1", session);

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
