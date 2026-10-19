import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const mockGetUploadUrl = vi.fn();
const mockSendMessage = vi.fn();
const mockFetch = vi.fn();
const mockFsReadFile = vi.fn();

vi.stubGlobal("fetch", mockFetch);

vi.mock("../../../channels/adapters/wechat/api.js", () => ({
  getUploadUrl: (...args: unknown[]) => mockGetUploadUrl(...args),
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
}));

// Mock the entire cdn/upload module to avoid fs.readFile in tests
vi.mock("../../../channels/adapters/wechat/cdn/upload.js", () => ({
  uploadImageToWeixin: vi.fn(),
  uploadVideoToWeixin: vi.fn(),
  uploadFileAttachmentToWeixin: vi.fn(),
  uploadVoiceToWeixin: vi.fn(),
}));

// Stub fs.readFile used by cdn/upload.ts
vi.mock("node:fs/promises", () => ({
  __esModule: true,
  default: { readFile: mockFsReadFile },
  readFile: mockFsReadFile,
}));

import {
  sendTextMessage,
  sendImageMessage,
  sendFileMessage,
  sendVideoMessage,
  sendVoiceMessage,
  sendWeixinMediaFile,
  markdownToPlainText,
} from "../../../channels/adapters/wechat/messaging/send-media.js";
import { uploadImageToWeixin, uploadVideoToWeixin, uploadFileAttachmentToWeixin, uploadVoiceToWeixin } from "../../../channels/adapters/wechat/cdn/upload.js";

describe("wechat-media-upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("markdownToPlainText", () => {
    it("strips code fences", () => {
      expect(markdownToPlainText("```js\nconsole.log('hi')\n```")).toBe("console.log('hi')");
    });

    it("strips image syntax", () => {
      expect(markdownToPlainText("Hello ![img](url) world")).toBe("Hello  world");
    });

    it("keeps link text only", () => {
      expect(markdownToPlainText("Click [here](https://example.com)")).toBe("Click here");
    });

    it("strips table separators", () => {
      const input = "| a | b |\n|---|---|\n| 1 | 2 |";
      const result = markdownToPlainText(input);
      // The function removes separator rows; the remaining rows have their pipes stripped
      expect(result).toContain("a  b");
      expect(result).toContain("1  2");
    });
  });

  describe("sendTextMessage", () => {
    it("sends a text message via API", async () => {
      mockSendMessage.mockResolvedValueOnce(undefined);

      const result = await sendTextMessage({
        to: "user123",
        text: "Hello *world*",
        opts: {
          baseUrl: "https://ilink.example.com",
          token: "token-abc",
        },
      });

      expect(result.messageId).toMatch(/^adam-wechat-/);
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "https://ilink.example.com",
          token: "token-abc",
        }),
      );
    });
  });

  describe("sendImageMessage", () => {
    it("sends an image message with CDN refs", async () => {
      mockSendMessage.mockResolvedValue(undefined);

      const uploaded = {
        filekey: "fk-123",
        downloadEncryptedQueryParam: "abc",
        aeskey: "0123456789abcdef0123456789abcdef",
        fileSize: 12345,
        fileSizeCiphertext: 12352,
      };

      await sendImageMessage({
        to: "user123",
        text: "Here is your image",
        uploaded,
        opts: { baseUrl: "https://ilink.example.com", token: "token-abc" },
      });

      expect(mockSendMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
      // Check that the image item was constructed correctly
      const callArgs = mockSendMessage.mock.calls[mockSendMessage.mock.calls.length - 1][0];
      const items = callArgs.body.msg.item_list;
      const imageItem = items?.find((i: { type: number }) => i.type === 2);
      expect(imageItem).toBeDefined();
      expect(imageItem.image_item.media.encrypt_query_param).toBe("abc");
      expect(imageItem.image_item.mid_size).toBe(12352);
    });
  });

  describe("sendVideoMessage", () => {
    it("sends a video message with CDN refs", async () => {
      mockSendMessage.mockResolvedValue(undefined);

      const uploaded = {
        filekey: "fk-456",
        downloadEncryptedQueryParam: "xyz",
        aeskey: "fedcba9876543210fedcba9876543210",
        fileSize: 999999,
        fileSizeCiphertext: 1000000,
      };

      await sendVideoMessage({
        to: "user456",
        text: "Check this video",
        uploaded,
        opts: { baseUrl: "https://ilink.example.com", token: "token-abc" },
      });

      const callArgs = mockSendMessage.mock.calls[mockSendMessage.mock.calls.length - 1][0];
      const items = callArgs.body.msg.item_list;
      const videoItem = items?.find((i: { type: number }) => i.type === 5);
      expect(videoItem).toBeDefined();
      expect(videoItem.video_item.media.encrypt_query_param).toBe("xyz");
      expect(videoItem.video_item.video_size).toBe(1000000);
    });
  });

  describe("sendFileMessage", () => {
    it("sends a file message with CDN refs and filename", async () => {
      mockSendMessage.mockResolvedValue(undefined);

      const uploaded = {
        filekey: "fk-789",
        downloadEncryptedQueryParam: "doc-param",
        aeskey: "abcdefabcdefabcdefabcdefabcdefab",
        fileSize: 50000,
        fileSizeCiphertext: 50064,
      };

      await sendFileMessage({
        to: "user789",
        text: "Your document",
        fileName: "report.pdf",
        uploaded,
        opts: { baseUrl: "https://ilink.example.com", token: "token-abc" },
      });

      const callArgs = mockSendMessage.mock.calls[mockSendMessage.mock.calls.length - 1][0];
      const items = callArgs.body.msg.item_list;
      const fileItem = items?.find((i: { type: number }) => i.type === 4);
      expect(fileItem).toBeDefined();
      expect(fileItem.file_item.file_name).toBe("report.pdf");
      expect(fileItem.file_item.len).toBe("50000");
    });
  });

  describe("sendVoiceMessage", () => {
    it("sends a voice message with CDN refs and encode_type from extension", async () => {
      mockSendMessage.mockResolvedValue(undefined);

      const uploaded = {
        filekey: "fk-voice",
        downloadEncryptedQueryParam: "voice-param",
        aeskey: "0123456789abcdef0123456789abcdef",
        fileSize: 8000,
        fileSizeCiphertext: 8016,
      };

      await sendVoiceMessage({
        to: "user123",
        text: "Voice message",
        uploaded,
        opts: { baseUrl: "https://ilink.example.com", token: "token-abc" },
        fileName: "recording.mp3",
      });

      const callArgs = mockSendMessage.mock.calls[mockSendMessage.mock.calls.length - 1][0];
      const items = callArgs.body.msg.item_list;
      const voiceItem = items?.find((i: { type: number }) => i.type === 3);
      expect(voiceItem).toBeDefined();
      expect(voiceItem.voice_item.media.encrypt_query_param).toBe("voice-param");
      expect(voiceItem.voice_item.encode_type).toBe(7); // mp3 = 7
    });

    it("leaves encode_type undefined for unknown extensions", async () => {
      mockSendMessage.mockResolvedValue(undefined);

      const uploaded = {
        filekey: "fk-voice",
        downloadEncryptedQueryParam: "voice-param",
        aeskey: "0123456789abcdef0123456789abcdef",
        fileSize: 8000,
        fileSizeCiphertext: 8016,
      };

      await sendVoiceMessage({
        to: "user123",
        text: "",
        uploaded,
        opts: { baseUrl: "https://ilink.example.com", token: "token-abc" },
        fileName: "recording.aac",
      });

      const callArgs = mockSendMessage.mock.calls[mockSendMessage.mock.calls.length - 1][0];
      const items = callArgs.body.msg.item_list;
      const voiceItem = items?.find((i: { type: number }) => i.type === 3);
      expect(voiceItem.voice_item.encode_type).toBeUndefined();
    });
  });

  describe("sendWeixinMediaFile", () => {
    beforeEach(() => {
      mockGetUploadUrl.mockResolvedValue({
        upload_full_url: "https://cdn.example.com/upload/full",
      });
      mockSendMessage.mockResolvedValue(undefined);
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map([["x-encrypted-param", "dl-param"]]),
      });
    });

    it("routes image/* to uploadImageToWeixin + sendImageMessage", async () => {
      (uploadImageToWeixin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        filekey: "fk-img",
        downloadEncryptedQueryParam: "img-param",
        aeskey: "0123456789abcdef0123456789abcdef",
        fileSize: 100,
        fileSizeCiphertext: 112,
      });

      await sendWeixinMediaFile({
        filePath: "/tmp/photo.png",
        to: "user123",
        text: "Photo caption",
        opts: { baseUrl: "https://ilink.example.com", token: "token-abc" },
        cdnBaseUrl: "https://cdn.example.com",
      });

      expect(uploadImageToWeixin).toHaveBeenCalled();
    });

    it("routes video/* to uploadVideoToWeixin + sendVideoMessage", async () => {
      (uploadVideoToWeixin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        filekey: "fk-vid",
        downloadEncryptedQueryParam: "vid-param",
        aeskey: "fedcba9876543210fedcba9876543210",
        fileSize: 1000,
        fileSizeCiphertext: 1008,
      });

      await sendWeixinMediaFile({
        filePath: "/tmp/video.mp4",
        to: "user123",
        text: "Video caption",
        opts: { baseUrl: "https://ilink.example.com", token: "token-abc" },
        cdnBaseUrl: "https://cdn.example.com",
      });

      expect(uploadVideoToWeixin).toHaveBeenCalledTimes(1);
      expect(uploadImageToWeixin).not.toHaveBeenCalled();
      expect(uploadFileAttachmentToWeixin).not.toHaveBeenCalled();
    });

    it("routes audio/* to uploadFileAttachmentToWeixin + sendFileMessage (iLink drops VOICE type)", async () => {
      (uploadFileAttachmentToWeixin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        filekey: "fk-voice",
        downloadEncryptedQueryParam: "voice-param",
        aeskey: "0123456789abcdef0123456789abcdef",
        fileSize: 8000,
        fileSizeCiphertext: 8016,
      });

      await sendWeixinMediaFile({
        filePath: "/tmp/recording.mp3",
        to: "user123",
        text: "Voice note",
        opts: { baseUrl: "https://ilink.example.com", token: "token-abc" },
        cdnBaseUrl: "https://cdn.example.com",
      });

      expect(uploadFileAttachmentToWeixin).toHaveBeenCalledTimes(1);
      expect(uploadVoiceToWeixin).not.toHaveBeenCalled();
      expect(uploadImageToWeixin).not.toHaveBeenCalled();
      expect(uploadVideoToWeixin).not.toHaveBeenCalled();
    });

    it("routes unknown types to uploadFileAttachmentToWeixin + sendFileMessage", async () => {
      (uploadFileAttachmentToWeixin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        filekey: "fk-doc",
        downloadEncryptedQueryParam: "doc-param",
        aeskey: "abcdefabcdefabcdefabcdefabcdefab",
        fileSize: 5000,
        fileSizeCiphertext: 5008,
      });

      await sendWeixinMediaFile({
        filePath: "/tmp/document.pdf",
        to: "user123",
        text: "Document",
        opts: { baseUrl: "https://ilink.example.com", token: "token-abc" },
        cdnBaseUrl: "https://cdn.example.com",
      });

      expect(uploadFileAttachmentToWeixin).toHaveBeenCalledTimes(1);
      expect(uploadImageToWeixin).not.toHaveBeenCalled();
      expect(uploadVideoToWeixin).not.toHaveBeenCalled();
    });
  });
});
