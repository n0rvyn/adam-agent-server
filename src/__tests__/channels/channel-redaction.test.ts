import { describe, it, expect } from "vitest";
import {
  REDACTED_SECRET,
  isSecretConfigKey,
  redactChannelConfig,
  toPublicChannel,
  mergeRedactedConfig,
} from "../../channels/channel-redaction.js";
import type { Channel } from "../../shared/types.js";

describe("channels/channel-redaction", () => {
  describe("isSecretConfigKey", () => {
    it("matches credential-bearing keys across platforms", () => {
      for (const key of [
        "botToken",
        "token",
        "signingSecret",
        "appToken",
        "apiKey",
        "api_key",
        "password",
        "clientSecret",
        "webhookSecret",
        "privateKey",
        "accessKey",
      ]) {
        expect(isSecretConfigKey(key), key).toBe(true);
      }
    });

    it("does not match non-secret identifiers", () => {
      for (const key of ["accountId", "userId", "baseUrl", "smtpHost", "address", "routeTag", "cdnBaseUrl", "name"]) {
        expect(isSecretConfigKey(key), key).toBe(false);
      }
    });
  });

  describe("redactChannelConfig", () => {
    it("masks non-empty string secrets, preserves non-secret fields", () => {
      const out = redactChannelConfig({
        baseUrl: "https://example.com",
        botToken: "super-secret-58-char-token-value-aaaaaaaaaaaaaaaaaaaaaaaaaa",
        accountId: "acct-123",
        userId: "user-456",
      });
      expect(out.botToken).toBe(REDACTED_SECRET);
      expect(out.baseUrl).toBe("https://example.com");
      expect(out.accountId).toBe("acct-123");
      expect(out.userId).toBe("user-456");
    });

    it("does not mask empty-string secrets (shows 'not configured')", () => {
      const out = redactChannelConfig({ botToken: "" });
      expect(out.botToken).toBe("");
    });

    it("does not mask non-string secret values", () => {
      const out = redactChannelConfig({ apiKey: 12345 });
      expect(out.apiKey).toBe(12345);
    });

    it("leaves email config (no secret keys) untouched", () => {
      const out = redactChannelConfig({ address: "norvyn@example.com", smtpHost: "smtp.example.com" });
      expect(out).toEqual({ address: "norvyn@example.com", smtpHost: "smtp.example.com" });
    });

    it("returns empty object for undefined config", () => {
      expect(redactChannelConfig(undefined)).toEqual({});
    });

    it("does not mutate the input", () => {
      const input = { botToken: "real" };
      redactChannelConfig(input);
      expect(input.botToken).toBe("real");
    });
  });

  describe("toPublicChannel", () => {
    it("redacts config while preserving all other channel fields", () => {
      const channel: Channel = {
        id: "id-1",
        name: "WeChat on iPhone",
        platform: "wechat",
        enabled: true,
        status: "connected",
        config: { baseUrl: "https://x", botToken: "real-token", accountId: "acct" },
        createdAt: 1,
        messageCount: 7,
      };
      const pub = toPublicChannel(channel);
      expect(pub.config.botToken).toBe(REDACTED_SECRET);
      expect(pub.config.accountId).toBe("acct");
      expect(pub.name).toBe("WeChat on iPhone");
      expect(pub.messageCount).toBe(7);
      // original untouched
      expect(channel.config.botToken).toBe("real-token");
    });
  });

  describe("mergeRedactedConfig", () => {
    it("restores the real stored value when the placeholder is echoed back", () => {
      const merged = mergeRedactedConfig(
        { baseUrl: "https://new", botToken: REDACTED_SECRET },
        { baseUrl: "https://old", botToken: "the-real-token" },
      );
      expect(merged.botToken).toBe("the-real-token");
      expect(merged.baseUrl).toBe("https://new");
    });

    it("keeps a genuinely new secret value (user typed a replacement)", () => {
      const merged = mergeRedactedConfig(
        { botToken: "brand-new-token" },
        { botToken: "the-real-token" },
      );
      expect(merged.botToken).toBe("brand-new-token");
    });

    it("drops the placeholder when there is no prior value to restore", () => {
      const merged = mergeRedactedConfig({ botToken: REDACTED_SECRET }, {});
      expect("botToken" in merged).toBe(false);
    });

    it("drops the placeholder when existing config is undefined", () => {
      const merged = mergeRedactedConfig({ botToken: REDACTED_SECRET }, undefined);
      expect("botToken" in merged).toBe(false);
    });
  });
});
