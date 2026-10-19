import { describe, it, expect } from "vitest";
import { getSourceTypeKeys, validateSourceConfig } from "../../events/sources/schemas.js";

describe("events/sources/schemas", () => {
  describe("getSourceTypeKeys", () => {
    it("returns all 4 current source types", () => {
      const keys = getSourceTypeKeys();
      expect(keys).toContain("webhook");
      expect(keys).toContain("manual");
      expect(keys).toContain("cron");
      expect(keys).toContain("directory_watch");
      expect(keys).toHaveLength(4);
    });
  });

  describe("validateSourceConfig", () => {
    it("validates cron config with cron expression", () => {
      const result = validateSourceConfig("cron", { cron: "0 9 * * *" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toEqual({ cron: "0 9 * * *" });
    });

    it("rejects cron config missing cron expression", () => {
      const result = validateSourceConfig("cron", {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("cron");
    });

    it("validates directory_watch config with path", () => {
      const result = validateSourceConfig("directory_watch", { path: "/tmp" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toEqual({ path: "/tmp" });
    });

    it("rejects directory_watch config missing path", () => {
      const result = validateSourceConfig("directory_watch", {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("path");
    });

    it("accepts empty webhook config", () => {
      const result = validateSourceConfig("webhook", {});
      expect(result.ok).toBe(true);
    });

    it("accepts empty manual config", () => {
      const result = validateSourceConfig("manual", {});
      expect(result.ok).toBe(true);
    });

    it("rejects nonexistent source type", () => {
      const result = validateSourceConfig("nonexistent", {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Unknown sourceType");
        expect(result.error).toContain("nonexistent");
        expect(result.error).toContain("webhook");
      }
    });

    it("rejects null sourceConfig (treats as missing required fields)", () => {
      const result = validateSourceConfig("cron", null);
      expect(result.ok).toBe(false);
    });
  });
});
