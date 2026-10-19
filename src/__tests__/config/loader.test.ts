import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock logger to capture log.warn calls from loader.ts
const { _mockLogger } = vi.hoisted(() => {
  const _mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  };
  return { _mockLogger };
});
vi.mock("../../lib/logger.js", () => ({
  getLogger: () => _mockLogger,
}));

import { loadConfig } from "../../config/loader.js";

describe("config/loader", () => {
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];

  beforeEach(() => {
    // Clean test-specific env vars
    delete process.env.ADAM_PORT;
    delete process.env.ADAM_API_KEY;

    delete process.env.ANTHROPIC_MODEL;
    delete process.env.CUSTOM_HOST;
    delete process.env.NONEXISTENT_VAR;
    process.argv = ["node", "test"];
  });

  afterEach(() => {
    process.argv = originalArgv;
    // Restore all env vars
    delete process.env.ADAM_PORT;
    delete process.env.ADAM_API_KEY;

    delete process.env.ANTHROPIC_MODEL;
    delete process.env.CUSTOM_HOST;
    delete process.env.NONEXISTENT_VAR;
  });

  it("should return default config when no file exists", () => {
    const config = loadConfig("/nonexistent/path.yaml");
    expect(config.defaults.timeout).toBe(600);
    expect(config.server.port).toBe(7100);
    expect(config.server.host).toBe("0.0.0.0");
    expect(config.defaults.maxTurns).toBe(400);
    expect(config.defaults.model).toBe("");
  });

  it("should override port via ADAM_PORT env var", () => {
    process.env.ADAM_PORT = "4000";
    const config = loadConfig("/nonexistent/path.yaml");
    expect(config.server.port).toBe(4000);
  });

  it("should override port via --port CLI flag", () => {
    process.argv = ["node", "test", "--port=5000"];
    const config = loadConfig("/nonexistent/path.yaml");
    expect(config.server.port).toBe(5000);
  });

  it("should override host via --host CLI flag", () => {
    process.argv = ["node", "test", "--host=127.0.0.1"];
    const config = loadConfig("/nonexistent/path.yaml");
    expect(config.server.host).toBe("127.0.0.1");
  });

  it("should have default approvalRequired patterns", () => {
    const config = loadConfig("/nonexistent/path.yaml");
    expect(config.defaults.approvalRequired).toContain("rm -rf *");
    expect(config.defaults.approvalRequired).toContain("git push*");
  });

  it("should override model via ANTHROPIC_MODEL env var", () => {
    process.env.ANTHROPIC_MODEL = "claude-opus-4-6";
    const config = loadConfig("/nonexistent/path.yaml");
    expect(config.defaults.model).toBe("claude-opus-4-6");
    delete process.env.ANTHROPIC_MODEL;
  });

  it("should override timeout via CLI flag", () => {
    process.argv = ["node", "test", "--timeout=120"];
    const config = loadConfig("/nonexistent/path.yaml");
    expect(config.defaults.timeout).toBe(120);
  });

  it("should override apiKey via ADAM_API_KEY env var", () => {
    process.env.ADAM_API_KEY = "my-secret-key";
    const config = loadConfig("/nonexistent/path.yaml");
    expect(config.server.apiKey).toBe("my-secret-key");
  });

  it("should override apiKey via --api-key CLI flag", () => {
    process.argv = ["node", "test", "--api-key=cli-key"];
    const config = loadConfig("/nonexistent/path.yaml");
    expect(config.server.apiKey).toBe("cli-key");
  });

  it("CLI flags should override env vars", () => {
    process.env.ADAM_PORT = "4000";
    process.argv = ["node", "test", "--port=5000"];
    const config = loadConfig("/nonexistent/path.yaml");
    expect(config.server.port).toBe(5000);
  });

  it("resolves tilde paths in deniedReadPaths", () => {
    const config = loadConfig("/nonexistent/path.yaml");
    // Tilde paths in defaults should be resolved
    for (const p of config.defaults.deniedReadPaths ?? []) {
      expect(p).not.toMatch(/^~\//);
    }
  });

  describe("file loading", () => {
    const tmpDir = join(tmpdir(), "adam-config-test-" + process.pid);
    const configFile = join(tmpDir, "adam.config.yaml");

    beforeEach(() => {
      mkdirSync(tmpDir, { recursive: true });
      process.argv = ["node", "test"];
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should load and override from YAML file", () => {
      writeFileSync(configFile, `server:\n  port: 9999\n`);
      const config = loadConfig(configFile);
      expect(config.server.port).toBe(9999);
    });

    it("should deep merge nested objects from file", () => {
      writeFileSync(
        configFile,
        `defaults:\n  timeout: 120\n`,
      );
      const config = loadConfig(configFile);
      // timeout overridden from file
      expect(config.defaults.timeout).toBe(120);
      // Deep merge preserves non-overridden defaults
      expect(config.defaults.maxBudgetUsd).toBeGreaterThan(0);
    });

    it("should expand ${VAR} in config values", () => {
      process.env.CUSTOM_HOST = "10.0.0.1";
      writeFileSync(configFile, `server:\n  host: "\${CUSTOM_HOST}"\n`);
      const config = loadConfig(configFile);
      expect(config.server.host).toBe("10.0.0.1");
    });

    it("should replace missing env vars with empty string", () => {
      delete process.env.NONEXISTENT_VAR;
      writeFileSync(configFile, `server:\n  host: "\${NONEXISTENT_VAR}"\n`);
      const config = loadConfig(configFile);
      expect(config.server.host).toBe("");
    });
  });
});
