import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  initRuntimeConfig,
  getRuntimeConfig,
  updateMutableConfig,
  loadPersistedConfig,
  buildSdkAuthEnv,
} from "../../config/runtime.js";
import { setConfigValue, getAllConfig, getConfigValue } from "../../store/config.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { ServerConfig } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  // Initialize with a deep clone of DEFAULT_CONFIG
  initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
});

// Save/restore env vars
const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function saveEnv(...keys: string[]) {
  for (const key of keys) {
    savedEnv[key] = process.env[key];
  }
}

describe("config/runtime persistence", () => {
  describe("updateMutableConfig", () => {
    it("persists updated values to DB via persistFn", () => {
      const result = updateMutableConfig(
        { "defaults.effort": "max" },
        setConfigValue,
      );
      expect(result.updated).toContain("defaults.effort");
      expect(getConfigValue("defaults.effort")).toBe("max");
    });

    it("does not persist when no persistFn provided (backward compat)", () => {
      const result = updateMutableConfig({ "defaults.effort": "max" });
      expect(result.updated).toContain("defaults.effort");
      expect(getConfigValue("defaults.effort")).toBeUndefined();
    });

    it("persists multiple values in a single call", () => {
      updateMutableConfig(
        {
          "defaults.effort": "low",
          "defaults.timeout": 300,
          "defaults.maxTurns": 50,
        },
        setConfigValue,
      );
      expect(getConfigValue("defaults.effort")).toBe("low");
      expect(getConfigValue("defaults.timeout")).toBe(300);
      expect(getConfigValue("defaults.maxTurns")).toBe(50);
    });

    it("accepts defaults.deniedReadPaths as mutable and persists array", () => {
      const paths = ["~/.ssh", "~/.aws", "~/.gnupg"];
      const result = updateMutableConfig(
        { "defaults.deniedReadPaths": paths },
        setConfigValue,
      );
      expect(result.updated).toContain("defaults.deniedReadPaths");
      expect(result.errors).toHaveLength(0);
      expect(getConfigValue("defaults.deniedReadPaths")).toEqual(paths);
    });

    it("accepts defaults.approvalRequired as mutable and persists array", () => {
      const patterns = ["rm -rf *", "git push*"];
      const result = updateMutableConfig(
        { "defaults.approvalRequired": patterns },
        setConfigValue,
      );
      expect(result.updated).toContain("defaults.approvalRequired");
      expect(result.errors).toHaveLength(0);
      expect(getConfigValue("defaults.approvalRequired")).toEqual(patterns);
    });

    it("accepts audit.intentEval config as mutable and persists both fields", () => {
      const result = updateMutableConfig(
        {
          "audit.intentEval.maxBudgetUsd": 2.5,
          "audit.intentEval.timeoutMs": 45_000,
        },
        setConfigValue,
      );
      expect(result.updated).toContain("audit.intentEval.maxBudgetUsd");
      expect(result.updated).toContain("audit.intentEval.timeoutMs");
      expect(result.errors).toHaveLength(0);
      expect(getConfigValue("audit.intentEval.maxBudgetUsd")).toBe(2.5);
      expect(getConfigValue("audit.intentEval.timeoutMs")).toBe(45_000);
      expect(getRuntimeConfig().audit?.intentEval).toEqual({
        maxBudgetUsd: 2.5,
        timeoutMs: 45_000,
      });
    });

    it("rejects invalid audit.intentEval values and does not persist them", () => {
      const result = updateMutableConfig(
        {
          "audit.intentEval.maxBudgetUsd": "oops",
          "audit.intentEval.timeoutMs": -1,
        },
        setConfigValue,
      );

      expect(result.updated).toHaveLength(0);
      expect(result.errors).toEqual([
        "\"audit.intentEval.maxBudgetUsd\" must be a positive number.",
        "\"audit.intentEval.timeoutMs\" must be a positive integer in milliseconds.",
      ]);
      expect(getConfigValue("audit.intentEval.maxBudgetUsd")).toBeUndefined();
      expect(getConfigValue("audit.intentEval.timeoutMs")).toBeUndefined();
      expect(getRuntimeConfig().audit?.intentEval).toEqual(DEFAULT_CONFIG.audit!.intentEval);
    });

    it("rejects non-mutable paths and does not persist them", () => {
      const result = updateMutableConfig(
        { "server.port": 8080 },
        setConfigValue,
      );
      expect(result.errors).toHaveLength(1);
      expect(result.updated).toHaveLength(0);
      expect(getConfigValue("server.port")).toBeUndefined();
    });
  });

  describe("loadPersistedConfig", () => {
    it("applies DB values to runtimeConfig", () => {
      // Pre-seed DB
      setConfigValue("defaults.effort", "max");
      setConfigValue("defaults.timeout", 120);

      // Re-init runtime with defaults, then load from DB
      initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
      loadPersistedConfig(getAllConfig);

      const config = getRuntimeConfig();
      expect(config.defaults.effort).toBe("max");
      expect(config.defaults.timeout).toBe(120);
    });

    it("preserves default values for keys not in DB", () => {
      setConfigValue("defaults.effort", "low");

      initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
      loadPersistedConfig(getAllConfig);

      const config = getRuntimeConfig();
      expect(config.defaults.effort).toBe("low");
      // maxTurns was not in DB — should retain default
      expect(config.defaults.maxTurns).toBe(DEFAULT_CONFIG.defaults.maxTurns);
    });

    it("skips invalid persisted audit.intentEval values and keeps defaults", () => {
      setConfigValue("audit.intentEval.maxBudgetUsd", "oops");
      setConfigValue("audit.intentEval.timeoutMs", -1);

      initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
      loadPersistedConfig(getAllConfig);

      expect(getRuntimeConfig().audit?.intentEval).toEqual(DEFAULT_CONFIG.audit!.intentEval);
    });

    it("loads valid persisted audit.intentEval values and skips invalid ones independently", () => {
      setConfigValue("audit.intentEval.maxBudgetUsd", 2.5);
      setConfigValue("audit.intentEval.timeoutMs", -1);

      initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
      loadPersistedConfig(getAllConfig);

      expect(getRuntimeConfig().audit?.intentEval).toEqual({
        maxBudgetUsd: 2.5,
        timeoutMs: DEFAULT_CONFIG.audit!.intentEval!.timeoutMs,
      });
    });
  });

  describe("buildSdkAuthEnv", () => {
    it("returns DB values when DB has them", () => {
      initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
      updateMutableConfig({
        "anthropic.apiKey": "sk-ant-test-key",
        "anthropic.baseUrl": "https://api.test.com",
      }, setConfigValue);

      const env = buildSdkAuthEnv();
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test-key");
      expect(env.ANTHROPIC_BASE_URL).toBe("https://api.test.com");
    });

    it("falls back to process.env when DB value is empty", () => {
      initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
      saveEnv("ANTHROPIC_API_KEY");
      process.env.ANTHROPIC_API_KEY = "sk-from-process-env";

      const env = buildSdkAuthEnv();
      expect(env.ANTHROPIC_API_KEY).toBe("sk-from-process-env");
    });

    it("DB value takes priority over process.env", () => {
      initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
      saveEnv("ANTHROPIC_API_KEY");
      process.env.ANTHROPIC_API_KEY = "sk-from-process-env";

      updateMutableConfig({
        "anthropic.apiKey": "sk-from-db",
      }, setConfigValue);

      const env = buildSdkAuthEnv();
      expect(env.ANTHROPIC_API_KEY).toBe("sk-from-db");
    });
  });
});
