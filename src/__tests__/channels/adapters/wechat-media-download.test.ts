import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock fs.promises
vi.mock("node:fs/promises", async () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock silk-wasm import
vi.mock("silk-wasm", () => ({
  decode: vi.fn().mockResolvedValue({
    data: new Uint8Array([0, 0, 0, 0]),
    duration: 100,
  }),
}));

import { parseAesKey } from "../../../channels/adapters/wechat/cdn/download.js";
import { downloadAndDecrypt, downloadPlain } from "../../../channels/adapters/wechat/cdn/download.js";
import { encryptAesEcb } from "../../../channels/adapters/wechat/cdn/aes-ecb.js";
import { getMimeFromFilename, getExtensionFromMime, getExtensionFromContentTypeOrUrl } from "../../../channels/adapters/wechat/media/mime.js";
import { downloadMediaFromItem } from "../../../channels/adapters/wechat/media/media-download.js";
import { MessageItemType } from "../../../channels/adapters/wechat/types.js";

describe("wechat-media-download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("parseAesKey", () => {
    it("parses base64 of 16 raw bytes", () => {
      // 16 bytes of all zeros → base64
      const raw16 = Buffer.alloc(16, 0);
      const b64 = raw16.toString("base64");
      const key = parseAesKey(b64);
      expect(key).toEqual(raw16);
    });

    it("parses base64 of 32-char hex string", () => {
      // "00" repeated 16 times = 32 hex chars
      const hexStr = "0".repeat(32);
      const b64 = Buffer.from(hexStr, "utf-8").toString("base64");
      const key = parseAesKey(b64);
      expect(key).toEqual(Buffer.alloc(16, 0));
    });

    it("throws on invalid input", () => {
      // "hello" as base64 = 5 bytes, not 16 or 32 hex
      const b64 = Buffer.from("hello", "utf-8").toString("base64");
      expect(() => parseAesKey(b64)).toThrow();
    });
  });

  describe("downloadAndDecrypt", () => {
    it("fetches from fullUrl when provided", async () => {
      const keyBuf = Buffer.alloc(16, 0);
      const keyB64 = keyBuf.toString("base64");
      const plaintext = Buffer.from("test data");
      const ciphertext = encryptAesEcb(plaintext, keyBuf);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => ciphertext,
      });

      const result = await downloadAndDecrypt({
        aesKeyBase64: keyB64,
        cdnBaseUrl: "https://cdn.example.com",
        fullUrl: "https://cdn.example.com/download?token=abc",
      });

      expect(result.toString()).toBe(plaintext.toString());
      expect(mockFetch).toHaveBeenCalledWith("https://cdn.example.com/download?token=abc");
    });

    it("builds URL from encryptQueryParam when fullUrl is absent", async () => {
      const keyBuf = Buffer.alloc(16, 0);
      const keyB64 = keyBuf.toString("base64");
      const plaintext = Buffer.from("test data");
      const ciphertext = encryptAesEcb(plaintext, keyBuf);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => ciphertext,
      });

      const result = await downloadAndDecrypt({
        encryptQueryParam: "abc123",
        aesKeyBase64: keyB64,
        cdnBaseUrl: "https://cdn.example.com",
      });

      expect(result.toString()).toBe(plaintext.toString());
      expect(mockFetch.mock.calls[0][0]).toBe(
        "https://cdn.example.com/download?encrypted_query_param=abc123",
      );
    });

    it("throws when neither fullUrl nor encryptQueryParam is provided", async () => {
      const keyBuf = Buffer.alloc(16, 0);
      const keyB64 = keyBuf.toString("base64");
      await expect(
        downloadAndDecrypt({ aesKeyBase64: keyB64, cdnBaseUrl: "https://cdn.example.com" }),
      ).rejects.toThrow("need full_url or encrypt_query_param");
    });
  });

  describe("downloadPlain", () => {
    it("fetches from fullUrl and returns raw bytes", async () => {
      const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => data,
      });

      const result = await downloadPlain({
        fullUrl: "https://cdn.example.com/file.png",
        cdnBaseUrl: "https://cdn.example.com",
      });

      expect(result.toString("hex")).toBe("89504e47");
    });
  });

  describe("getMimeFromFilename", () => {
    it("returns correct MIME types", () => {
      expect(getMimeFromFilename("report.pdf")).toBe("application/pdf");
      expect(getMimeFromFilename("audio.mp3")).toBe("audio/mpeg");
      expect(getMimeFromFilename("video.mp4")).toBe("video/mp4");
      expect(getMimeFromFilename("image.png")).toBe("image/png");
    });

    it("returns octet-stream for unknown extensions", () => {
      expect(getMimeFromFilename("file.xyz")).toBe("application/octet-stream");
    });
  });

  describe("getExtensionFromMime", () => {
    it("returns correct extensions", () => {
      expect(getExtensionFromMime("image/jpeg")).toBe(".jpg");
      expect(getExtensionFromMime("audio/wav")).toBe(".wav");
      expect(getExtensionFromMime("video/mp4")).toBe(".mp4");
    });

    it("returns .bin for unknown MIME types", () => {
      expect(getExtensionFromMime("application/unknown")).toBe(".bin");
    });
  });

  describe("getExtensionFromContentTypeOrUrl", () => {
    it("prefers Content-Type over URL extension", () => {
      const ext = getExtensionFromContentTypeOrUrl("image/png", "https://example.com/file.jpg");
      expect(ext).toBe(".png");
    });

    it("falls back to URL extension when Content-Type is unknown", () => {
      const ext = getExtensionFromContentTypeOrUrl(null, "https://example.com/data.csv");
      expect(ext).toBe(".csv");
    });
  });

  describe("downloadMediaFromItem", () => {
    it("returns null for TEXT items", async () => {
      const result = await downloadMediaFromItem(
        { type: MessageItemType.TEXT, text_item: { text: "hello" } },
        { cdnBaseUrl: "https://cdn.example.com", channelId: "wc-1" },
      );
      expect(result).toBeNull();
    });

    it("downloads IMAGE item with hex aeskey", async () => {
      const keyBuf = Buffer.alloc(16, 0);
      const hexKey = keyBuf.toString("hex");
      const plaintext = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ciphertext = encryptAesEcb(plaintext, keyBuf);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => ciphertext,
      });

      const result = await downloadMediaFromItem(
        {
          type: MessageItemType.IMAGE,
          image_item: {
            aeskey: hexKey,
            media: {
              encrypt_query_param: "abc123",
              aes_key: keyBuf.toString("base64"),
            },
          },
        },
        { cdnBaseUrl: "https://cdn.example.com", channelId: "wc-1" },
      );

      expect(result?.type).toBe("image");
      expect(result?.mimeType).toBe("image/png");
      expect(result?.path).toContain(".png");
    });

    it("downloads VOICE item and transcodes to WAV", async () => {
      const keyBuf = Buffer.alloc(16, 0);
      const hexKey = keyBuf.toString("hex");
      const silkData = Buffer.from([0x01, 0x02, 0x03]);
      const ciphertext = encryptAesEcb(silkData, keyBuf);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => ciphertext,
      });

      const result = await downloadMediaFromItem(
        {
          type: MessageItemType.VOICE,
          voice_item: {
            media: {
              encrypt_query_param: "abc123",
              aes_key: keyBuf.toString("base64"),
            },
          },
        },
        { cdnBaseUrl: "https://cdn.example.com", channelId: "wc-1" },
      );

      expect(result?.type).toBe("audio");
      // silk-wasm mock returns PCM bytes which get wrapped as WAV
      expect(result?.mimeType).toBe("audio/wav");
    });

    it("downloads FILE item with correct MIME", async () => {
      const keyBuf = Buffer.alloc(16, 0);
      const plaintext = Buffer.from("Hello PDF world");
      const ciphertext = encryptAesEcb(plaintext, keyBuf);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => ciphertext,
      });

      const result = await downloadMediaFromItem(
        {
          type: MessageItemType.FILE,
          file_item: {
            file_name: "report.pdf",
            media: {
              encrypt_query_param: "abc123",
              aes_key: keyBuf.toString("base64"),
            },
          },
        },
        { cdnBaseUrl: "https://cdn.example.com", channelId: "wc-1" },
      );

      expect(result?.type).toBe("file");
      expect(result?.mimeType).toBe("application/pdf");
    });

    it("downloads VIDEO item", async () => {
      const keyBuf = Buffer.alloc(16, 0);
      const plaintext = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]); // MP4 ftyp
      const ciphertext = encryptAesEcb(plaintext, keyBuf);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => ciphertext,
      });

      const result = await downloadMediaFromItem(
        {
          type: MessageItemType.VIDEO,
          video_item: {
            media: {
              encrypt_query_param: "abc123",
              aes_key: keyBuf.toString("base64"),
            },
          },
        },
        { cdnBaseUrl: "https://cdn.example.com", channelId: "wc-1" },
      );

      expect(result?.type).toBe("video");
      expect(result?.mimeType).toBe("video/mp4");
    });
  });
});
