import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSdkEnv, filterAnthropicKeys, maskSensitiveEnvValues, initRuntimeConfig, buildSdkAuthEnv } from "../../config/runtime.js";
import type { ServerConfig } from "../../shared/types.js";

const BASE_CONFIG: ServerConfig = {
  defaults: {
    timeout: 600,
    maxTurns: 100,
    maxBudgetUsd: 5,
    effort: "high",
    model: "claude-sonnet-4-5-20250514",
    settingSources: [],
    allowedTools: [],
    disallowedTools: [],
    approvalRequired: [],
    approvalTimeout: 60,
    env: { GLOBAL_KEY: "global_value", SHARED_KEY: "from_global" },
  },
  server: { port: 7100, host: "0.0.0.0" },
  anthropic: {
    apiKey: "sk-test-key",
    baseUrl: "",
    model: "claude-sonnet-4-5-20250514",
    defaultOpusModel: "",
    defaultSonnetModel: "",
    defaultHaikuModel: "",
    smallFastModel: "",
  },
};

describe("buildSdkEnv", () => {
  beforeEach(() => {
    initRuntimeConfig(BASE_CONFIG);
  });

  it("includes process.env as base layer", () => {
    process.env.TEST_PROCESS_VAR = "from_process";
    const env = buildSdkEnv();
    expect(env.TEST_PROCESS_VAR).toBe("from_process");
    delete process.env.TEST_PROCESS_VAR;
  });

  it("global defaults.env overrides process.env", () => {
    process.env.GLOBAL_KEY = "from_process";
    const env = buildSdkEnv();
    expect(env.GLOBAL_KEY).toBe("global_value");
    delete process.env.GLOBAL_KEY;
  });

  it("ANTHROPIC_* from buildSdkAuthEnv overrides global env", () => {
    const env = buildSdkEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test-key");
  });

  it("role envVars override global env", () => {
    const env = buildSdkEnv({ roleEnvVars: { SHARED_KEY: "from_role", ROLE_ONLY: "yes" } });
    expect(env.SHARED_KEY).toBe("from_role");
    expect(env.ROLE_ONLY).toBe("yes");
    expect(env.GLOBAL_KEY).toBe("global_value");
  });

  it("task env overrides role env", () => {
    const env = buildSdkEnv({
      roleEnvVars: { SHARED_KEY: "from_role" },
      taskEnv: { SHARED_KEY: "from_task" },
    });
    expect(env.SHARED_KEY).toBe("from_task");
  });

  it("filters ANTHROPIC_* from role envVars", () => {
    const env = buildSdkEnv({ roleEnvVars: { ANTHROPIC_API_KEY: "hacked", MY_KEY: "ok" } });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test-key"); // from global, not role
    expect(env.MY_KEY).toBe("ok");
  });

  it("filters ANTHROPIC_* from task env", () => {
    const env = buildSdkEnv({ taskEnv: { ANTHROPIC_BASE_URL: "http://evil" } });
    expect(env.ANTHROPIC_BASE_URL).not.toBe("http://evil");
  });

  it("DISABLE_* flags cannot be overridden", () => {
    const env = buildSdkEnv({
      roleEnvVars: { DISABLE_TELEMETRY: "0" },
      taskEnv: { DISABLE_ERROR_REPORTING: "0" },
    });
    expect(env.DISABLE_TELEMETRY).toBe("1");
    expect(env.DISABLE_ERROR_REPORTING).toBe("1");
  });

  it("handles undefined role and task env gracefully", () => {
    const env = buildSdkEnv();
    expect(env.GLOBAL_KEY).toBe("global_value");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test-key");
    expect(env.DISABLE_TELEMETRY).toBe("1");
  });
});

describe("filterAnthropicKeys", () => {
  it("removes ANTHROPIC_* keys", () => {
    const result = filterAnthropicKeys({
      ANTHROPIC_API_KEY: "x",
      ANTHROPIC_BASE_URL: "y",
      MY_KEY: "z",
    });
    expect(result).toEqual({ MY_KEY: "z" });
  });

  it("returns empty for all ANTHROPIC_* input", () => {
    expect(filterAnthropicKeys({ ANTHROPIC_MODEL: "m" })).toEqual({});
  });
});

describe("maskSensitiveEnvValues", () => {
  it("masks values for keys containing sensitive patterns", () => {
    const result = maskSensitiveEnvValues({
      API_KEY: "sk-1234567890",
      GITHUB_TOKEN: "ghp_abc",
      MY_SECRET: "ab",
      NORMAL_VAR: "hello",
    });
    expect(result.API_KEY).toBe("sk-1****");
    expect(result.GITHUB_TOKEN).toBe("ghp_****");
    expect(result.MY_SECRET).toBe("****"); // too short for prefix
    expect(result.NORMAL_VAR).toBe("hello"); // not sensitive
  });
});
