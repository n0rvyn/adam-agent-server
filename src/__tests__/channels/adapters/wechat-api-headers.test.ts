import { describe, it, expect } from "vitest";
import { ILINK_APP_ID, ILINK_APP_CLIENT_VERSION, buildBaseInfo, buildClientVersion } from "../../../channels/adapters/wechat/api.js";

describe("WeChat API headers", () => {
  describe("ILINK_APP_ID", () => {
    it("is an exported constant", () => {
      expect(typeof ILINK_APP_ID).toBe("string");
    });
  });

  describe("ILINK_APP_CLIENT_VERSION", () => {
    it("is an exported number", () => {
      expect(typeof ILINK_APP_CLIENT_VERSION).toBe("number");
    });

    it("is the correct encoding of CHANNEL_VERSION", () => {
      // ILINK_APP_CLIENT_VERSION should match buildClientVersion("2.1.7") — aligned with upstream openclaw-weixin
      expect(ILINK_APP_CLIENT_VERSION).toBe(buildClientVersion("2.1.7"));
      expect(ILINK_APP_CLIENT_VERSION).toBe((2 << 16) | (1 << 8) | 7); // 131335
    });

    it('"1.0.0" encodes to 65536 (0x00010000)', () => {
      expect(buildClientVersion("1.0.0")).toBe(65536);
    });

    it('"2.1.1" encodes to 131329 (0x00020101)', () => {
      expect(buildClientVersion("2.1.1")).toBe(131329);
    });
  });

  describe("buildBaseInfo", () => {
    it("returns an object with channel_version", () => {
      const info = buildBaseInfo();
      expect(info.channel_version).toBeDefined();
    });
  });
});
