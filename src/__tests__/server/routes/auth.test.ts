import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, getTestDb } from "../../helpers/test-db.js";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

const { cleanup } = setupTestDb();

const { TEST_RUNTIME_DIR } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join: pathJoin } = require("node:path");
  return { TEST_RUNTIME_DIR: mkdtempSync(pathJoin(tmpdir(), "adam-auth-test-")) };
});

vi.mock("../../../shared/constants.js", async () => {
  const actual = await vi.importActual<typeof import("../../../shared/constants.js")>(
    "../../../shared/constants.js",
  );
  return { ...actual, RUNTIME_DIR: TEST_RUNTIME_DIR };
});

vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => {
  cleanup();
  rmSync(TEST_RUNTIME_DIR, { recursive: true, force: true });
});

import { authRoutes } from "../../../server/routes/auth.js";
import { setAuthKey, getAuthKey } from "../../../server/auth-key.js";
import { initRuntimeConfig, getRuntimeConfig } from "../../../config/runtime.js";
import { DEFAULT_CONFIG } from "../../../config/defaults.js";
import { TEST_API_KEY } from "../../helpers/test-auth.js";

const KEY_FILE = join(TEST_RUNTIME_DIR, "adam.key");

describe("auth routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    delete process.env.ADAM_API_KEY;
    setAuthKey(TEST_API_KEY);
    initRuntimeConfig({
      ...DEFAULT_CONFIG,
      server: { ...DEFAULT_CONFIG.server, apiKey: TEST_API_KEY },
    });
    if (existsSync(KEY_FILE)) rmSync(KEY_FILE);

    app = Fastify();
    await app.register(authRoutes);
    await app.ready();
  });

  describe("GET /auth/verify", () => {
    it("returns ok when reached (auth enforcement assumed upstream)", async () => {
      const res = await app.inject({ method: "GET", url: "/auth/verify" });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
    });
  });

  describe("POST /auth/rotate", () => {
    it("generates a new key, persists to file + auth-key module, returns it", async () => {
      const res = await app.inject({ method: "POST", url: "/auth/rotate" });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.apiKey).toMatch(/^[0-9a-f]{64}$/);
      expect(body.apiKey).not.toBe(TEST_API_KEY);

      expect(getAuthKey()).toBe(body.apiKey);
      expect(readFileSync(KEY_FILE, "utf-8")).toBe(body.apiKey);
      expect(getRuntimeConfig().server.apiKey).toBe(body.apiKey);
    });

    it("returns 409 when ADAM_API_KEY env var is set", async () => {
      process.env.ADAM_API_KEY = "env-set-key";
      try {
        const res = await app.inject({ method: "POST", url: "/auth/rotate" });
        expect(res.statusCode).toBe(409);
        const body = JSON.parse(res.body);
        expect(body.code).toBe("ROTATE_BLOCKED_BY_ENV");
      } finally {
        delete process.env.ADAM_API_KEY;
      }
    });

    it("invalidates the old key in auth-key module", async () => {
      const oldKey = getAuthKey();
      const res = await app.inject({ method: "POST", url: "/auth/rotate" });
      const newKey = JSON.parse(res.body).apiKey;

      expect(newKey).not.toBe(oldKey);
      expect(getAuthKey()).toBe(newKey);
    });
  });
});
