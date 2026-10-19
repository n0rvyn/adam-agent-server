import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  getConfigValue,
  setConfigValue,
  getAllConfig,
  seedConfig,
  isConfigEmpty,
  deleteConfigValue,
} from "../../store/config.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

describe("store/config", () => {
  describe("isConfigEmpty", () => {
    it("returns true when config table is empty", () => {
      expect(isConfigEmpty()).toBe(true);
    });

    it("returns false after inserting a value", () => {
      setConfigValue("test.key", "value");
      expect(isConfigEmpty()).toBe(false);
    });
  });

  describe("setConfigValue / getConfigValue", () => {
    it("stores and retrieves a string value", () => {
      setConfigValue("anthropic.apiKey", "sk-ant-123");
      expect(getConfigValue("anthropic.apiKey")).toBe("sk-ant-123");
    });

    it("stores and retrieves a number value", () => {
      setConfigValue("defaults.timeout", 600);
      expect(getConfigValue("defaults.timeout")).toBe(600);
    });

    it("stores and retrieves a boolean value", () => {
      setConfigValue("chat.autoTitle", true);
      expect(getConfigValue("chat.autoTitle")).toBe(true);
    });

    it("returns undefined for non-existent key", () => {
      expect(getConfigValue("nonexistent.key")).toBeUndefined();
    });

    it("upserts: overwriting existing key updates the value", () => {
      setConfigValue("defaults.effort", "high");
      setConfigValue("defaults.effort", "max");
      expect(getConfigValue("defaults.effort")).toBe("max");
    });

    it("sets updated_at timestamp", () => {
      const before = Date.now();
      setConfigValue("test.key", "value");
      const after = Date.now();

      const db = getTestDb();
      const row = db.prepare("SELECT updated_at FROM config WHERE key = ?").get("test.key") as { updated_at: number };
      expect(row.updated_at).toBeGreaterThanOrEqual(before);
      expect(row.updated_at).toBeLessThanOrEqual(after);
    });
  });

  describe("getAllConfig", () => {
    it("returns empty object when no config", () => {
      expect(getAllConfig()).toEqual({});
    });

    it("returns all stored key-value pairs", () => {
      setConfigValue("defaults.effort", "high");
      setConfigValue("defaults.timeout", 300);
      setConfigValue("chat.autoTitle", false);

      const all = getAllConfig();
      expect(all).toEqual({
        "defaults.effort": "high",
        "defaults.timeout": 300,
        "chat.autoTitle": false,
      });
    });
  });

  describe("seedConfig", () => {
    it("inserts values into empty table", () => {
      const count = seedConfig({
        "defaults.effort": "high",
        "defaults.timeout": 600,
        "anthropic.apiKey": "sk-ant-test",
      });
      expect(count).toBe(3);
      expect(getConfigValue("defaults.effort")).toBe("high");
      expect(getConfigValue("defaults.timeout")).toBe(600);
      expect(getConfigValue("anthropic.apiKey")).toBe("sk-ant-test");
    });

    it("does NOT overwrite existing values", () => {
      setConfigValue("defaults.effort", "max");
      const count = seedConfig({
        "defaults.effort": "high",
        "defaults.timeout": 600,
      });
      expect(count).toBe(1); // only timeout was new
      expect(getConfigValue("defaults.effort")).toBe("max"); // preserved
      expect(getConfigValue("defaults.timeout")).toBe(600);
    });

    it("skips empty/null/undefined values", () => {
      const count = seedConfig({
        "key.empty": "",
        "key.null": null as unknown,
        "key.undef": undefined as unknown,
        "key.valid": "value",
      });
      expect(count).toBe(1);
      expect(getConfigValue("key.valid")).toBe("value");
      expect(getConfigValue("key.empty")).toBeUndefined();
    });
  });

  describe("deleteConfigValue", () => {
    it("deletes an existing key and returns true", () => {
      setConfigValue("to.delete", "gone");
      expect(deleteConfigValue("to.delete")).toBe(true);
      expect(getConfigValue("to.delete")).toBeUndefined();
    });

    it("returns false for non-existent key", () => {
      expect(deleteConfigValue("nonexistent")).toBe(false);
    });
  });
});
