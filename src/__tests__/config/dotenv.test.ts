import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadDotEnv } from "../../config/dotenv.js";

describe("loadDotEnv", () => {
  let testDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    testDir = join(tmpdir(), `adam-dotenv-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    Object.keys(savedEnv).forEach((k) => delete savedEnv[k]);
    rmSync(testDir, { recursive: true, force: true });
  });

  function saveEnv(...keys: string[]) {
    for (const key of keys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }

  it("loads .env file into process.env", () => {
    saveEnv("TEST_DOTENV_KEY");
    writeFileSync(join(testDir, ".env"), "TEST_DOTENV_KEY=hello\n");

    loadDotEnv(testDir);
    expect(process.env.TEST_DOTENV_KEY).toBe("hello");
  });

  it("does not overwrite existing env vars", () => {
    saveEnv("TEST_EXISTING");
    process.env.TEST_EXISTING = "original";
    writeFileSync(join(testDir, ".env"), "TEST_EXISTING=overwritten\n");

    loadDotEnv(testDir);
    expect(process.env.TEST_EXISTING).toBe("original");
  });

  it("skips comments and blank lines", () => {
    saveEnv("TEST_COMMENT_KEY");
    writeFileSync(join(testDir, ".env"), "# comment\n\nTEST_COMMENT_KEY=value\n");

    loadDotEnv(testDir);
    expect(process.env.TEST_COMMENT_KEY).toBe("value");
  });

  it("strips surrounding quotes", () => {
    saveEnv("TEST_DOUBLE_Q", "TEST_SINGLE_Q");
    writeFileSync(join(testDir, ".env"), 'TEST_DOUBLE_Q="quoted"\nTEST_SINGLE_Q=\'single\'\n');

    loadDotEnv(testDir);
    expect(process.env.TEST_DOUBLE_Q).toBe("quoted");
    expect(process.env.TEST_SINGLE_Q).toBe("single");
  });

  it("strips export prefix", () => {
    saveEnv("TEST_EXPORT_KEY");
    writeFileSync(join(testDir, ".env"), "export TEST_EXPORT_KEY=exported\n");

    loadDotEnv(testDir);
    expect(process.env.TEST_EXPORT_KEY).toBe("exported");
  });

  it("expands $VAR and ${VAR} references", () => {
    saveEnv("TEST_REF_BASE", "TEST_REF_DOLLAR", "TEST_REF_BRACED");
    process.env.TEST_REF_BASE = "base_value";
    writeFileSync(join(testDir, ".env"), "TEST_REF_DOLLAR=$TEST_REF_BASE\nTEST_REF_BRACED=${TEST_REF_BASE}\n");

    loadDotEnv(testDir);
    expect(process.env.TEST_REF_DOLLAR).toBe("base_value");
    expect(process.env.TEST_REF_BRACED).toBe("base_value");
  });

  it(".env.local overrides .env", () => {
    saveEnv("TEST_PRIORITY");
    writeFileSync(join(testDir, ".env"), "TEST_PRIORITY=from_env\n");
    writeFileSync(join(testDir, ".env.local"), "TEST_PRIORITY=from_local\n");

    loadDotEnv(testDir);
    // .env.local loads first (higher priority) → .env skipped for this key
    expect(process.env.TEST_PRIORITY).toBe("from_local");
  });

  it("ADAM_ENV_FILE overrides both .env and .env.local", () => {
    saveEnv("TEST_CUSTOM_ENV", "ADAM_ENV_FILE");
    process.env.ADAM_ENV_FILE = ".env.test";
    writeFileSync(join(testDir, ".env"), "TEST_CUSTOM_ENV=from_default\n");
    writeFileSync(join(testDir, ".env.local"), "TEST_CUSTOM_ENV=from_local\n");
    writeFileSync(join(testDir, ".env.test"), "TEST_CUSTOM_ENV=from_test\n");

    loadDotEnv(testDir);
    // ADAM_ENV_FILE loads first (highest priority)
    expect(process.env.TEST_CUSTOM_ENV).toBe("from_test");
  });

  it("returns loaded file paths", () => {
    saveEnv("TEST_LOADED");
    writeFileSync(join(testDir, ".env"), "TEST_LOADED=yes\n");

    const loaded = loadDotEnv(testDir);
    expect(loaded.length).toBe(1);
    expect(loaded[0]).toContain(".env");
  });

  it("returns empty array when no .env files exist", () => {
    const loaded = loadDotEnv(testDir);
    expect(loaded).toEqual([]);
  });

  it("handles empty values", () => {
    saveEnv("TEST_EMPTY");
    writeFileSync(join(testDir, ".env"), "TEST_EMPTY=\n");

    loadDotEnv(testDir);
    expect(process.env.TEST_EMPTY).toBe("");
  });

  it("ANTHROPIC_* vars always override parent process env", () => {
    saveEnv("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "EXISTING_VAR");
    process.env.ANTHROPIC_API_KEY = "parent-key";
    process.env.ANTHROPIC_BASE_URL = "https://parent.example.com";
    process.env.EXISTING_VAR = "parent-value";

    writeFileSync(
      join(testDir, ".env"),
      "ANTHROPIC_API_KEY=adam-key-from-env\nANTHROPIC_BASE_URL=https://api.anthropic.com\nEXISTING_VAR=should-not-change\n",
    );

    loadDotEnv(testDir);

    // ANTHROPIC_* vars must be overridden by .env
    expect(process.env.ANTHROPIC_API_KEY).toBe("adam-key-from-env");
    expect(process.env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");

    // Non-ANTHROPIC vars that already exist in parent env must NOT be overwritten
    expect(process.env.EXISTING_VAR).toBe("parent-value");
  });
});
