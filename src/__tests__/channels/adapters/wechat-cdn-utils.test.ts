import { describe, it, expect } from "vitest";
import { encryptAesEcb, decryptAesEcb, aesEcbPaddedSize } from "../../../channels/adapters/wechat/cdn/aes-ecb.js";
import { buildCdnDownloadUrl, buildCdnUploadUrl } from "../../../channels/adapters/wechat/cdn/cdn-url.js";

describe("wechat-cdn-utils", () => {
  describe("AES-128-ECB", () => {
    it("encrypt/decrypt roundtrip returns original data", () => {
      const key = Buffer.from("0123456789abcdef", "utf-8"); // 16 bytes
      const plaintext = Buffer.from("Hello, WeChat!", "utf-8");
      const encrypted = encryptAesEcb(plaintext, key);
      const decrypted = decryptAesEcb(encrypted, key);
      expect(decrypted.toString("utf-8")).toBe(plaintext.toString("utf-8"));
    });

    it("encrypted output differs from plaintext", () => {
      const key = Buffer.from("fedcba9876543210", "utf-8");
      const plaintext = Buffer.from("Secret message", "utf-8");
      const encrypted = encryptAesEcb(plaintext, key);
      expect(encrypted.toString("hex")).not.toBe(plaintext.toString("hex"));
    });

    it("aesEcbPaddedSize(0) === 16", () => {
      expect(aesEcbPaddedSize(0)).toBe(16);
    });

    it("aesEcbPaddedSize(16) === 32", () => {
      expect(aesEcbPaddedSize(16)).toBe(32);
    });

    it("aesEcbPaddedSize boundary: exact block stays one block", () => {
      // 15 bytes needs 16 (one block)
      expect(aesEcbPaddedSize(15)).toBe(16);
      // 17 bytes needs 32 (two blocks)
      expect(aesEcbPaddedSize(17)).toBe(32);
    });

    it("aesEcbPaddedSize is ceil((n+1)/16)*16", () => {
      for (const n of [0, 1, 15, 16, 17, 31, 32, 100, 255, 256]) {
        const expected = Math.ceil((n + 1) / 16) * 16;
        expect(aesEcbPaddedSize(n)).toBe(expected);
      }
    });
  });

  describe("CDN URL builders", () => {
    it("buildCdnDownloadUrl formats correctly", () => {
      // Use a plain param value (encodeURIComponent handles the encoding)
      const url = buildCdnDownloadUrl("abc123@def", "https://cdn.wechat.com");
      expect(url).toBe("https://cdn.wechat.com/download?encrypted_query_param=abc123%40def");
    });

    it("buildCdnDownloadUrl encodes special chars", () => {
      // Use plain special chars; encodeURIComponent will encode them correctly
      const url = buildCdnDownloadUrl("a=b&c=d", "https://cdn.example.com");
      expect(url).toContain("encrypted_query_param=" + encodeURIComponent("a=b&c=d"));
    });

    it("buildCdnUploadUrl formats correctly", () => {
      const url = buildCdnUploadUrl({
        cdnBaseUrl: "https://cdn.wechat.com",
        uploadParam: "up-param-123",
        filekey: "fk-abc-def",
      });
      expect(url).toBe(
        "https://cdn.wechat.com/upload?encrypted_query_param=up-param-123&filekey=fk-abc-def",
      );
    });

    it("buildCdnUploadUrl encodes both params", () => {
      const url = buildCdnUploadUrl({
        cdnBaseUrl: "https://cdn.example.com",
        uploadParam: "x=y&z",
        filekey: "kf&test",
      });
      expect(url).toContain(encodeURIComponent("x=y&z"));
      expect(url).toContain(encodeURIComponent("kf&test"));
    });
  });
});
