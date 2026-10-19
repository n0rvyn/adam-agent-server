import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { tmpdir } from "os";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { setupTestDb, clearTestDb, getTestDb } from "../../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

let TEST_ENV_DIR: string;
let TEST_ENV_PATH: string;

vi.mock("../../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock("../../../lib/logger.js", () => ({
  setLogLevel: vi.fn(),
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock ENV_PATH to test temp directory using importOriginal to preserve other exports
vi.mock("../../../shared/constants.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/constants.js")>();
  const path = require("path");
  const os = require("os");
  const d = path.join(os.tmpdir(), "adam-test-config-routes");
  return { ...actual, ENV_PATH: path.join(d, ".env") };
});

import Fastify from "fastify";
import { configRoutes } from "../../../server/routes/config.js";
import { initRuntimeConfig, getRuntimeConfig } from "../../../config/runtime.js";
import { DEFAULT_CONFIG } from "../../../config/defaults.js";
import { serverBus } from "../../../server/events/server-bus.js";
import { setLogLevel } from "../../../lib/logger.js";

// Assign after imports — now safe to use join()
TEST_ENV_DIR = join(tmpdir(), "adam-test-config-routes");
TEST_ENV_PATH = join(TEST_ENV_DIR, ".env");

afterAll(() => cleanup());

describe("server/routes/config", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearTestDb();
    mkdirSync(TEST_ENV_DIR, { recursive: true });
    writeFileSync(TEST_ENV_PATH, "", "utf-8");
    initRuntimeConfig(DEFAULT_CONFIG);
    app = Fastify({ logger: false });
    await app.register(configRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    try { rmSync(TEST_ENV_DIR, { recursive: true, force: true }); } catch {}
  });

  describe("GET /config", () => {
    it("returns config with mutability indication", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/config",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.mutable).toContain("defaults.model");
      expect(body.mutable).toContain("defaults.effort");
      expect(body.mutable).toContain("logging.level");

      expect(body.restartRequired).toContain("server.port");
      expect(body.restartRequired).toContain("server.host");

      expect(body.config["defaults.model"]).toEqual({
        value: "",
        mutable: true,
      });
    });

    it("returns all configured paths", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/config",
      });

      const body = JSON.parse(response.body);
      const allPaths = [...body.mutable, ...body.restartRequired];

      for (const path of allPaths) {
        expect(body.config[path]).toBeDefined();
        expect(body.config[path]).toHaveProperty("value");
        expect(body.config[path]).toHaveProperty("mutable");
      }
    });
  });

  describe("PATCH /config", () => {
    it("updates mutable values", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/config",
        payload: {
          "defaults.model": "claude-opus-4-6",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.updated).toContain("defaults.model");
      expect(body.errors).toEqual([]);

      const config = getRuntimeConfig();
      expect(config.defaults.model).toBe("claude-opus-4-6");
    });

    it("rejects restart-required values with partial success", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/config",
        payload: {
          "server.port": 9999,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toContain("requires restart");
    });

    it("handles mixed mutable and restart-required (DP-001: partial success)", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/config",
        payload: {
          "defaults.model": "claude-opus-4-6",
          "server.port": 9999,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.updated).toContain("defaults.model");
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toContain("server.port");

      const config = getRuntimeConfig();
      expect(config.defaults.model).toBe("claude-opus-4-6");
    });

    it("rejects unrecognized config paths", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/config",
        payload: {
          "nonexistent.path": "value",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.errors[0]).toContain("not a recognized config path");
    });

    it("rejects invalid audit.intentEval values without writing runtime state", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/config",
        payload: {
          "audit.intentEval.maxBudgetUsd": "oops",
          "audit.intentEval.timeoutMs": -1,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.updated).toEqual([]);
      expect(body.errors).toEqual([
        "\"audit.intentEval.maxBudgetUsd\" must be a positive number.",
        "\"audit.intentEval.timeoutMs\" must be a positive integer in milliseconds.",
      ]);
      expect(body.message).toBe("Updated 0 value(s); 2 rejected");
      expect(getRuntimeConfig().audit?.intentEval).toEqual(DEFAULT_CONFIG.audit!.intentEval);
    });

    it("emits config_changed event on successful update", async () => {
      await app.inject({
        method: "PATCH",
        url: "/config",
        payload: {
          "defaults.maxTurns": 200,
        },
      });

      expect(serverBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "config_changed",
          changes: expect.arrayContaining([
            expect.objectContaining({ path: "defaults.maxTurns", value: 200 }),
          ]),
        }),
      );
    });

    it("does not emit event when no values are updated", async () => {
      await app.inject({
        method: "PATCH",
        url: "/config",
        payload: {
          "server.port": 9999,
        },
      });

      expect(serverBus.emit).not.toHaveBeenCalled();
    });

    it("calls setLogLevel when logging.level is updated", async () => {
      await app.inject({
        method: "PATCH",
        url: "/config",
        payload: {
          "logging.level": "debug",
        },
      });

      expect(setLogLevel).toHaveBeenCalledWith("debug");
    });

    it("updates multiple mutable values at once", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/config",
        payload: {
          "defaults.model": "claude-opus-4-6",
          "defaults.effort": "max",
          "defaults.maxTurns": 50,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.updated).toHaveLength(3);

      const config = getRuntimeConfig();
      expect(config.defaults.model).toBe("claude-opus-4-6");
      expect(config.defaults.effort).toBe("max");
      expect(config.defaults.maxTurns).toBe(50);
    });

    it("updates nested evolution settings", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/config",
        payload: {
          "roles.evolution.triggerEvery": 10,
          "roles.evolution.reflectionThreshold": 300,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);

      const config = getRuntimeConfig();
      expect(config.roles?.evolution.triggerEvery).toBe(10);
      expect(config.roles?.evolution.reflectionThreshold).toBe(300);
    });
  });

  describe("GET /config/env-diff", () => {
    it("returns empty diff when .env does not exist", async () => {
      try { rmSync(TEST_ENV_PATH); } catch {}
      const response = await app.inject({
        method: "GET",
        url: "/config/env-diff",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.diffs).toEqual([]);
      expect(body.envFileExists).toBe(false);
    });

    it("returns diffs when .env has different values than DB", async () => {
      writeFileSync(TEST_ENV_PATH, "ANTHROPIC_API_KEY=sk-from-env\n", "utf-8");

      const response = await app.inject({
        method: "GET",
        url: "/config/env-diff",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.envFileExists).toBe(true);
      // DB value for apiKey is "" (from DEFAULT_CONFIG), .env has "sk-from-env"
      const apiKeyDiff = body.diffs.find((d: { envKey: string }) => d.envKey === "ANTHROPIC_API_KEY");
      expect(apiKeyDiff).toBeDefined();
      expect(apiKeyDiff.dbValue).toBe("");
      expect(apiKeyDiff.envValue).toBe("sk-from-env");
    });
  });

  describe("POST /config/sync-to-env", () => {
    it("writes DB values to .env", async () => {
      // First save a value to DB via PATCH
      await app.inject({
        method: "PATCH",
        url: "/config",
        payload: { "anthropic.apiKey": "sk-test-sync" },
      });
      // Write a placeholder to .env so syncDbToEnvFile can find & replace
      writeFileSync(TEST_ENV_PATH, "ANTHROPIC_API_KEY=old-value\n", "utf-8");

      const response = await app.inject({
        method: "POST",
        url: "/config/sync-to-env",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.changed).toBeGreaterThanOrEqual(1);
      const content = await import("fs").then((fs) => fs.readFileSync(TEST_ENV_PATH, "utf-8"));
      expect(content).toContain("ANTHROPIC_API_KEY=sk-test-sync");
    });
  });

  describe("POST /config/load-from-env", () => {
    it("returns error when .env does not exist", async () => {
      try { rmSync(TEST_ENV_PATH); } catch {}
      const response = await app.inject({
        method: "POST",
        url: "/config/load-from-env",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain(".env file not found");
    });

    it("loads .env values into DB", async () => {
      writeFileSync(TEST_ENV_PATH, "ANTHROPIC_MODEL=claude-opus-4-6\nANTHROPIC_API_KEY=sk-test-key\n", "utf-8");

      const response = await app.inject({
        method: "POST",
        url: "/config/load-from-env",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.updated).toBeGreaterThanOrEqual(2);

      const config = getRuntimeConfig();
      expect(config.anthropic?.model).toBe("claude-opus-4-6");
    });

    it("loads custom env vars from .env into defaults.env", async () => {
      writeFileSync(TEST_ENV_PATH, "ANTHROPIC_MODEL=test-model\nMY_CUSTOM_VAR=custom123\nANOTHER_VAR=hello\n", "utf-8");

      const response = await app.inject({
        method: "POST",
        url: "/config/load-from-env",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);

      const config = getRuntimeConfig();
      expect(config.anthropic?.model).toBe("test-model");
      expect(config.defaults.env.MY_CUSTOM_VAR).toBe("custom123");
      expect(config.defaults.env.ANOTHER_VAR).toBe("hello");
    });
  });

  describe("GET /config/env", () => {
    it("returns empty env by default", async () => {
      const response = await app.inject({ method: "GET", url: "/config/env" });
      expect(response.statusCode).toBe(200);
      expect(response.json().env).toEqual({});
    });
  });

  describe("PUT /config/env", () => {
    it("replaces global env vars", async () => {
      const response = await app.inject({
        method: "PUT",
        url: "/config/env",
        payload: { GITHUB_TOKEN: "ghp_abc", SLACK_TOKEN: "xoxb-123" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      expect(response.json().count).toBe(2);

      const config = getRuntimeConfig();
      expect(config.defaults.env.GITHUB_TOKEN).toBe("ghp_abc");
      expect(config.defaults.env.SLACK_TOKEN).toBe("xoxb-123");
    });

    it("rejects ANTHROPIC_* keys", async () => {
      const response = await app.inject({
        method: "PUT",
        url: "/config/env",
        payload: { ANTHROPIC_API_KEY: "sk-hacked" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("VALIDATION_ERROR");
    });

    it("rejects invalid key format", async () => {
      const response = await app.inject({
        method: "PUT",
        url: "/config/env",
        payload: { "invalid-key": "val" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("emits config_changed event", async () => {
      await app.inject({
        method: "PUT",
        url: "/config/env",
        payload: { MY_KEY: "val" },
      });
      expect(serverBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "config_changed" }),
      );
    });
  });

  describe("PATCH /config/env", () => {
    it("adds and deletes keys", async () => {
      // First set some keys
      await app.inject({
        method: "PUT",
        url: "/config/env",
        payload: { KEY_A: "a", KEY_B: "b" },
      });

      // Patch: add KEY_C, delete KEY_A
      const response = await app.inject({
        method: "PATCH",
        url: "/config/env",
        payload: { KEY_C: "c", KEY_A: null },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().count).toBe(2); // KEY_B + KEY_C

      const config = getRuntimeConfig();
      expect(config.defaults.env).toEqual({ KEY_B: "b", KEY_C: "c" });
    });

    it("rejects ANTHROPIC_* keys", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/config/env",
        payload: { ANTHROPIC_BASE_URL: "http://evil" },
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
