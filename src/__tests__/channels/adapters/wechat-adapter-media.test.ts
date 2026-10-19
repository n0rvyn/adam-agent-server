import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const mockGetUpdates = vi.fn();
const mockSendMessage = vi.fn();
const mockSendTyping = vi.fn();
const mockDownloadMediaFromItem = vi.fn();
const mockSendWeixinMediaFile = vi.fn();
const mockFetch = vi.fn();

vi.stubGlobal("fetch", mockFetch);

vi.mock("../../../channels/adapters/wechat/api.js", () => ({
  getUpdates: (...args: unknown[]) => mockGetUpdates(...args),
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  sendTyping: (...args: unknown[]) => mockSendTyping(...args),
  getConfig: vi.fn().mockResolvedValue({ typing_ticket: "test-ticket" }),
}));

vi.mock("../../../channels/adapters/wechat/media/media-download.js", () => ({
  downloadMediaFromItem: (...args: unknown[]) => mockDownloadMediaFromItem(...args),
}));

vi.mock("../../../channels/adapters/wechat/messaging/send-media.js", () => ({
  sendWeixinMediaFile: (...args: unknown[]) => mockSendWeixinMediaFile(...args),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock("node:fs/promises", () => ({
  __esModule: true,
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../channels/adapters/wechat/login-qr.js", () => ({
  startWeixinLoginWithQr: vi.fn(),
  waitForWeixinLogin: vi.fn(),
}));

import { WeChatAdapter } from "../../../channels/adapters/wechat/wechat.js";
import { MessageItemType } from "../../../channels/adapters/wechat/types.js";

function markSessionActive(adapter: WeChatAdapter, chatId: string) {
  const sessions = (adapter as unknown as {
    sessions: Map<string, { lastUserMessageAt: number; quotaRemaining: number }>;
  }).sessions;

  sessions.set(chatId, {
    lastUserMessageAt: Date.now(),
    quotaRemaining: 10,
  });
}

describe("WeChatAdapter media integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUpdates.mockReturnValue(new Promise(() => {}));
    mockSendMessage.mockResolvedValue(undefined);
    mockSendTyping.mockResolvedValue(undefined);
    mockDownloadMediaFromItem.mockResolvedValue(null);
    mockSendWeixinMediaFile.mockResolvedValue({ messageId: "test-msg-id" });
  });

  describe("inbound media download", () => {
    it("calls downloadMediaFromItem for IMAGE messages and sets mediaPath on InboundMessage", async () => {
      const handler = vi.fn();

      mockDownloadMediaFromItem.mockResolvedValueOnce({
        path: "/home/user/.adam/wechat/media/wc1/inbound/1234567890-abc.png",
        mimeType: "image/png",
        type: "image",
      });

      mockGetUpdates
        .mockResolvedValueOnce({
          ret: 0,
          msgs: [{
            from_user_id: "sender@im.wechat",
            to_user_id: "bot@im.bot",
            create_time_ms: Date.now(),
            context_token: "ctx-123",
            item_list: [{
              type: MessageItemType.IMAGE,
              image_item: {
                aeskey: "0123456789abcdef0123456789abcdef",
                media: {
                  encrypt_query_param: "abc123",
                  aes_key: Buffer.from("0123456789abcdef", "utf-8").toString("base64"),
                },
              },
            }],
          }],
          get_updates_buf: "",
        })
        .mockReturnValue(new Promise(() => {}));

      const adapter = new WeChatAdapter("wc1", {
        baseUrl: "https://ilink.example.com",
        botToken: "test-token",
        cdnBaseUrl: "https://cdn.example.com",
      });
      adapter.onMessage(handler);
      await adapter.connect();
      await new Promise((r) => setTimeout(r, 200));

      expect(mockDownloadMediaFromItem).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        channelId: "wc1",
        mediaType: "image",
        mediaPath: "/home/user/.adam/wechat/media/wc1/inbound/1234567890-abc.png",
      }));

      await adapter.disconnect();
    });

    it("download failure does not block message delivery", async () => {
      const handler = vi.fn();

      // Simulate download failure
      mockDownloadMediaFromItem.mockRejectedValueOnce(new Error("CDN fetch failed"));

      mockGetUpdates
        .mockResolvedValueOnce({
          ret: 0,
          msgs: [{
            from_user_id: "sender@im.wechat",
            to_user_id: "bot@im.bot",
            create_time_ms: Date.now(),
            item_list: [{
              type: MessageItemType.IMAGE,
              image_item: {
                aeskey: "0123456789abcdef0123456789abcdef",
                media: { encrypt_query_param: "abc", aes_key: "ABBBBBBBBBBBBBBB=" },
              },
            }],
          }],
          get_updates_buf: "",
        })
        .mockReturnValue(new Promise(() => {}));

      const adapter = new WeChatAdapter("wc1", {
        baseUrl: "https://ilink.example.com",
        botToken: "test-token",
      });
      adapter.onMessage(handler);
      await adapter.connect();
      await new Promise((r) => setTimeout(r, 200));

      // Message still delivered, just without mediaPath
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        channelId: "wc1",
        mediaType: "image",
        mediaPath: undefined,
      }));

      await adapter.disconnect();
    });
  });

  describe("outbound media send", () => {
    it("sendMessage with mediaUrl downloads remote file and calls sendWeixinMediaFile", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      });

      const adapter = new WeChatAdapter("wc1", {
        baseUrl: "https://ilink.example.com",
        botToken: "test-token",
        cdnBaseUrl: "https://cdn.example.com",
      });
      await adapter.connect();
      markSessionActive(adapter, "user123");

      const msgId = await adapter.sendMessage("user123", {
        content: "Here is your photo",
        mediaUrl: "https://example.com/photo.png",
        mediaType: "image",
      });

      expect(mockSendWeixinMediaFile).toHaveBeenCalledTimes(1);
      expect(mockSendWeixinMediaFile.mock.calls[0][0]).toMatchObject({
        to: "user123",
        text: "Here is your photo",
        cdnBaseUrl: "https://cdn.example.com",
      });
      expect(msgId).toBe("test-msg-id");

      await adapter.disconnect();
    });

    it("sendMessage without mediaUrl uses text-only flow", async () => {
      const adapter = new WeChatAdapter("wc1", {
        baseUrl: "https://ilink.example.com",
        botToken: "test-token",
      });
      await adapter.connect();
      markSessionActive(adapter, "user123");

      await adapter.sendMessage("user123", { content: "Hello world" });

      expect(mockSendWeixinMediaFile).not.toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          msg: expect.objectContaining({
            to_user_id: "user123",
          }),
        }),
      }));

      await adapter.disconnect();
    });
  });
});
