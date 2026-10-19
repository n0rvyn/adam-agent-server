import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const { cleanup } = setupTestDb();

// Redirect RUNTIME_DIR to a temp path so we don't touch ~/.adam/adam.key
const { TEST_RUNTIME_DIR } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join: pathJoin } = require("node:path");
  return { TEST_RUNTIME_DIR: mkdtempSync(pathJoin(tmpdir(), "adam-boot-test-")) };
});

vi.mock("../../shared/constants.js", async () => {
  const actual = await vi.importActual<typeof import("../../shared/constants.js")>(
    "../../shared/constants.js",
  );
  return { ...actual, RUNTIME_DIR: TEST_RUNTIME_DIR };
});

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => {
  cleanup();
  rmSync(TEST_RUNTIME_DIR, { recursive: true, force: true });
});

import { ensureApiKey } from "../../config/bootstrap-api-key.js";
import { getAuthKey, setAuthKey } from "../../server/auth-key.js";
import { getConfigValue, setConfigValue } from "../../store/config.js";
import type { ServerConfig } from "../../shared/types.js";

const KEY_FILE = join(TEST_RUNTIME_DIR, "adam.key");

function makeConfig(apiKey = ""): ServerConfig {
  return {
    server: { host: "127.0.0.1", port: 0, apiKey },
    defaults: {} as never,
  } as ServerConfig;
}

describe("ensureApiKey", () => {
  beforeEach(() => {
    setAuthKey("");
    delete process.env.ADAM_API_KEY;
    // Clear config table
    getTestDb().prepare("DELETE FROM config WHERE key = ?").run("server.apiKey");
    if (existsSync(KEY_FILE)) rmSync(KEY_FILE);
  });

  it("generates a 64-char hex key when config has no key", () => {
    const config = makeConfig("");
    const key = ensureApiKey(config, { devMode: false });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists generated key to DB and file", () => {
    const config = makeConfig("");
    const key = ensureApiKey(config, { devMode: false });

    expect(getConfigValue("server.apiKey")).toBe(key);
    expect(existsSync(KEY_FILE)).toBe(true);
    expect(readFileSync(KEY_FILE, "utf-8")).toBe(key);
  });

  it("seeds the auth-key module with the generated key", () => {
    const config = makeConfig("");
    const key = ensureApiKey(config, { devMode: false });
    expect(getAuthKey()).toBe(key);
  });

  it("returns existing key without regenerating", () => {
    const existingKey = "existing-key-abc";
    setConfigValue("server.apiKey", existingKey);
    const config = makeConfig(existingKey);

    const key = ensureApiKey(config, { devMode: false });

    expect(key).toBe(existingKey);
    expect(getAuthKey()).toBe(existingKey);
  });

  it("syncs file when key exists in config (idempotent write)", () => {
    const existingKey = "sync-key-xyz";
    const config = makeConfig(existingKey);

    ensureApiKey(config, { devMode: false });

    expect(readFileSync(KEY_FILE, "utf-8")).toBe(existingKey);
  });
});
