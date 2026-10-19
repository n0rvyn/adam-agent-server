import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  DEFAULT_ILINK_BOT_TYPE,
} from "../../../channels/adapters/wechat/login-qr.js";

describe("WeChat login-qr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("startWeixinLoginWithQr", () => {
    it("returns QR code URL on success", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ qrcode: "qr-123", qrcode_img_content: "https://example.com/qr.png" }),
      });

      const result = await startWeixinLoginWithQr({
        apiBaseUrl: "https://ilink.example.com",
      });

      expect(result.qrcodeUrl).toBe("https://example.com/qr.png");
      expect(result.sessionKey).toBeDefined();
      expect(result.message).toContain("Scan");
    });

    it("returns error message when no baseUrl", async () => {
      const result = await startWeixinLoginWithQr({ apiBaseUrl: "" });
      expect(result.qrcodeUrl).toBeUndefined();
      expect(result.message).toContain("No baseUrl");
    });

    it("returns error when fetch fails", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));

      const result = await startWeixinLoginWithQr({
        apiBaseUrl: "https://ilink.example.com",
      });

      expect(result.qrcodeUrl).toBeUndefined();
      expect(result.message).toContain("Failed");
    });

    it("passes routeTag as SKRouteTag header", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ qrcode: "qr-123", qrcode_img_content: "https://example.com/qr.png" }),
      });

      await startWeixinLoginWithQr({
        apiBaseUrl: "https://ilink.example.com",
        routeTag: "test-route",
      });

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[1].headers.SKRouteTag).toBe("test-route");
    });
  });

  describe("waitForWeixinLogin", () => {
    it("returns not-found when no active login", async () => {
      const result = await waitForWeixinLogin({
        sessionKey: "nonexistent",
        apiBaseUrl: "https://ilink.example.com",
      });

      expect(result.connected).toBe(false);
      expect(result.message).toContain("No active login");
    });

    it("returns connected on confirmed scan", async () => {
      // First: start a login to create active session
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ qrcode: "qr-456", qrcode_img_content: "https://example.com/qr2.png" }),
      });

      const startResult = await startWeixinLoginWithQr({
        apiBaseUrl: "https://ilink.example.com",
      });

      // Then: mock the status poll to return confirmed immediately
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          status: "confirmed",
          bot_token: "bot-token-abc",
          ilink_bot_id: "bot@im.bot",
          baseurl: "https://ilink.example.com",
          ilink_user_id: "user@im.wechat",
        }),
      });

      const result = await waitForWeixinLogin({
        sessionKey: startResult.sessionKey,
        apiBaseUrl: "https://ilink.example.com",
        timeoutMs: 5000,
      });

      expect(result.connected).toBe(true);
      expect(result.botToken).toBe("bot-token-abc");
      expect(result.accountId).toBe("bot@im.bot");
      expect(result.userId).toBe("user@im.wechat");
    });

    it("handles expired QR with refresh", async () => {
      // Start login
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ qrcode: "qr-789", qrcode_img_content: "https://example.com/qr3.png" }),
      });

      const startResult = await startWeixinLoginWithQr({
        apiBaseUrl: "https://ilink.example.com",
      });

      // Poll returns expired, then refresh QR, then confirmed
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({ status: "expired" }),
        })
        .mockResolvedValueOnce({
          // Refresh QR
          ok: true,
          json: async () => ({ qrcode: "qr-new", qrcode_img_content: "https://example.com/qr-new.png" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => JSON.stringify({
            status: "confirmed",
            bot_token: "token-2",
            ilink_bot_id: "bot2@im.bot",
            ilink_user_id: "user2@im.wechat",
          }),
        });

      const result = await waitForWeixinLogin({
        sessionKey: startResult.sessionKey,
        apiBaseUrl: "https://ilink.example.com",
        timeoutMs: 10000,
      });

      expect(result.connected).toBe(true);
    });
  });
});
