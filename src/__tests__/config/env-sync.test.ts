/**
 * Unit tests for src/config/env-sync.ts
 * Tests readEnvFile, computeEnvDiff, syncDbToEnvFile
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock ENV_PATH to a temp directory so tests don't touch ~/.adam/.env
const TEST_ENV_PATH = join(tmpdir(), "adam-test-env-sync", ".env");
const TEST_ENV_DIR = join(tmpdir(), "adam-test-env-sync");

vi.mock("../../shared/constants.js", () => ({
  ENV_PATH: TEST_ENV_PATH,
}));

// Must import after the mock is set
import { readEnvFile, computeEnvDiff, syncDbToEnvFile } from "../../config/env-sync.js";

beforeEach(() => {
  // Ensure test dir exists
  mkdirSync(TEST_ENV_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(TEST_ENV_DIR, { recursive: true, force: true }); } catch {}
});

function writeTestEnv(content: string) {
  writeFileSync(TEST_ENV_PATH, content, "utf-8");
}

describe("readEnvFile", () => {
  it("returns null when .env does not exist", async () => {
    vi.resetModules();
    // Ensure no file
    try { rmSync(TEST_ENV_PATH, { force: true }); } catch {}
    const { readEnvFile: freshRead } = await import("../../config/env-sync.js");
    expect(freshRead()).toBeNull();
  });

  it("parses key=value pairs", async () => {
    writeTestEnv("ANTHROPIC_API_KEY=sk-test-key-123\nANTHROPIC_MODEL=claude-sonnet-4-6\n");
    const { readEnvFile: freshRead } = await import("../../config/env-sync.js");
    const result = freshRead();
    expect(result).not.toBeNull();
    expect(result!["ANTHROPIC_API_KEY"]).toBe("sk-test-key-123");
    expect(result!["ANTHROPIC_MODEL"]).toBe("claude-sonnet-4-6");
  });

  it("skips comments", async () => {
    writeTestEnv("# this is a comment\nANTHROPIC_API_KEY=sk-test\n# another comment\n");
    const { readEnvFile: freshRead } = await import("../../config/env-sync.js");
    const result = freshRead();
    expect(Object.keys(result!).length).toBe(1);
    expect(result!["ANTHROPIC_API_KEY"]).toBe("sk-test");
  });

  it("skips variable references ($VAR)", async () => {
    writeTestEnv("ANTHROPIC_API_KEY=$EXISTING_KEY\nANTHROPIC_MODEL=claude-sonnet-4-6\n");
    const { readEnvFile: freshRead } = await import("../../config/env-sync.js");
    const result = freshRead();
    expect(result!["ANTHROPIC_MODEL"]).toBe("claude-sonnet-4-6");
    expect(result!["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("strips export prefix", async () => {
    writeTestEnv("export ANTHROPIC_API_KEY=sk-exported\n");
    const { readEnvFile: freshRead } = await import("../../config/env-sync.js");
    const result = freshRead();
    expect(result!["ANTHROPIC_API_KEY"]).toBe("sk-exported");
  });

  it("handles quoted values", async () => {
    writeTestEnv('ANTHROPIC_API_KEY="sk-quoted"\nANTHROPIC_BASE_URL=\'https://quoted.url.com\'\n');
    const { readEnvFile: freshRead } = await import("../../config/env-sync.js");
    const result = freshRead();
    expect(result!["ANTHROPIC_API_KEY"]).toBe("sk-quoted");
    expect(result!["ANTHROPIC_BASE_URL"]).toBe("https://quoted.url.com");
  });
});

describe("computeEnvDiff", () => {
  it("returns empty when .env does not exist", async () => {
    vi.resetModules();
    try { rmSync(TEST_ENV_PATH, { force: true }); } catch {}
    const { computeEnvDiff: freshDiff } = await import("../../config/env-sync.js");
    expect(freshDiff({})).toEqual([]);
  });

  it("detects differences between DB and .env", async () => {
    writeTestEnv("ANTHROPIC_API_KEY=sk-from-env\nANTHROPIC_MODEL=claude-sonnet-4-6\n");
    const { computeEnvDiff: freshDiff } = await import("../../config/env-sync.js");
    const dbConfig = {
      "anthropic.apiKey": "sk-from-db",
      "anthropic.model": "claude-sonnet-4-6", // same as .env
    };
    const diffs = freshDiff(dbConfig);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].envKey).toBe("ANTHROPIC_API_KEY");
    expect(diffs[0].dbValue).toBe("sk-from-db");
    expect(diffs[0].envValue).toBe("sk-from-env");
  });

  it("ignores keys not in .env", async () => {
    writeTestEnv("ANTHROPIC_API_KEY=sk-from-env\n");
    const { computeEnvDiff: freshDiff } = await import("../../config/env-sync.js");
    const dbConfig = {
      "anthropic.apiKey": "sk-from-db",
      "anthropic.model": "claude-opus-4-6",
    };
    const diffs = freshDiff(dbConfig);
    // Only ANTHROPIC_API_KEY is in .env; ANTHROPIC_MODEL is not
    expect(diffs).toHaveLength(1);
    expect(diffs[0].envKey).toBe("ANTHROPIC_API_KEY");
  });
});

describe("syncDbToEnvFile", () => {
  it("returns 0 when .env does not exist", async () => {
    vi.resetModules();
    try { rmSync(TEST_ENV_PATH, { force: true }); } catch {}
    const { syncDbToEnvFile: freshSync } = await import("../../config/env-sync.js");
    expect(freshSync({ "anthropic.apiKey": "sk-test" })).toBe(0);
  });

  it("updates existing keys in .env from DB values", async () => {
    writeTestEnv("ANTHROPIC_API_KEY=sk-old\nANTHROPIC_MODEL=claude-sonnet-4-6\n");
    const { syncDbToEnvFile: freshSync } = await import("../../config/env-sync.js");
    const dbConfig = {
      "anthropic.apiKey": "sk-new-from-db",
      "anthropic.model": "claude-opus-4-6",
    };
    const changed = freshSync(dbConfig);
    expect(changed).toBeGreaterThanOrEqual(1);
    const content = readFileSync(TEST_ENV_PATH, "utf-8");
    expect(content).toContain("ANTHROPIC_API_KEY=sk-new-from-db");
    expect(content).toContain("ANTHROPIC_MODEL=claude-opus-4-6");
  });

  it("preserves comments in .env", async () => {
    writeTestEnv("# My API Key\nANTHROPIC_API_KEY=sk-old\n# My Model\nANTHROPIC_MODEL=claude-sonnet-4-6\n");
    const { syncDbToEnvFile: freshSync } = await import("../../config/env-sync.js");
    freshSync({ "anthropic.apiKey": "sk-new", "anthropic.model": "claude-opus-4-6" });
    const content = readFileSync(TEST_ENV_PATH, "utf-8");
    expect(content).toContain("# My API Key");
    expect(content).toContain("# My Model");
  });

  it("appends keys that exist in DB but not in .env", async () => {
    writeTestEnv("ANTHROPIC_API_KEY=sk-existing\n");
    const { syncDbToEnvFile: freshSync } = await import("../../config/env-sync.js");
    freshSync({ "anthropic.apiKey": "sk-ex", "anthropic.model": "claude-opus-4-6" });
    const content = readFileSync(TEST_ENV_PATH, "utf-8");
    expect(content).toContain("ANTHROPIC_API_KEY=sk-ex");
    expect(content).toContain("ANTHROPIC_MODEL=claude-opus-4-6");
  });
});
