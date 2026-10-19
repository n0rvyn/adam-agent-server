import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveTierModel } from "../../manager/effort-tier-resolver.js";
import type { Role, TaskConfig } from "../../shared/types.js";

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    anthropic: {
      defaultHaikuModel: "haiku-x",
      defaultSonnetModel: "sonnet-x",
      defaultOpusModel: "opus-x",
    },
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// Minimal partial Role for testing — only fields relevant to the resolver
function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: "role-test",
    name: "Test",
    cagPrompt: "",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "mem-test",
    status: "active",
    preferences: {},
    createdAt: 0,
    ...overrides,
  } as Role;
}

// Minimal partial TaskConfig — only fields relevant to the resolver
function makeConfig(overrides: Partial<TaskConfig> = {}): TaskConfig {
  return {
    timeout: 300,
    approvalRequired: [],
    approvalTimeout: 300,
    ...overrides,
  } as TaskConfig;
}

describe("resolveTierModel", () => {
  describe("tier-based resolution", () => {
    it("high tier resolves to opus-x with sonnet-x fallback", () => {
      const result = resolveTierModel(makeConfig({ effortTier: "high" }), undefined);
      expect(result).toEqual({ model: "opus-x", fallbackModel: "sonnet-x" });
    });

    it("medium tier resolves to sonnet-x with haiku-x fallback", () => {
      const result = resolveTierModel(makeConfig({ effortTier: "medium" }), undefined);
      expect(result).toEqual({ model: "sonnet-x", fallbackModel: "haiku-x" });
    });

    it("low tier resolves to haiku-x with no fallback", () => {
      const result = resolveTierModel(makeConfig({ effortTier: "low" }), undefined);
      expect(result).toEqual({ model: "haiku-x", fallbackModel: undefined });
    });
  });

  describe("task tier overrides role tier", () => {
    it("task effortTier takes precedence over role effortTier", () => {
      const result = resolveTierModel(
        makeConfig({ effortTier: "high" }),
        makeRole({ effortTier: "low" }),
      );
      expect(result).toEqual({ model: "opus-x", fallbackModel: "sonnet-x" });
    });
  });

  describe("role.model fallback", () => {
    it("no tier but role.model returns the explicit model with no fallback", () => {
      const result = resolveTierModel(undefined, makeRole({ model: "custom-model" }));
      expect(result).toEqual({ model: "custom-model", fallbackModel: undefined });
    });

    it("no tier and no role.model returns undefined for both", () => {
      const result = resolveTierModel(undefined, undefined);
      expect(result).toEqual({ model: undefined, fallbackModel: undefined });
    });
  });

  describe("empty config handling", () => {
    it("high tier with empty defaultOpusModel falls through to undefined, fallback unaffected", async () => {
      vi.resetModules();
      vi.doMock("../../config/runtime.js", () => ({
        getRuntimeConfig: vi.fn(() => ({
          anthropic: {
            defaultHaikuModel: "haiku-x",
            defaultSonnetModel: "sonnet-x",
            defaultOpusModel: "",
          },
        })),
      }));
      const { resolveTierModel: fresh } = await import("../../manager/effort-tier-resolver.js");
      const result = fresh(makeConfig({ effortTier: "high" }), undefined);
      expect(result).toEqual({ model: undefined, fallbackModel: "sonnet-x" });
    });
  });

  describe("safe with undefined role", () => {
    it("returns {undefined, undefined} when role is undefined", () => {
      const result = resolveTierModel(undefined, undefined);
      expect(result).toEqual({ model: undefined, fallbackModel: undefined });
    });
  });

  describe("fallback equal to main model is dropped (SDK rejects fallbackModel === model)", () => {
    it("high tier drops the fallback when opus and sonnet resolve to the same model", async () => {
      vi.resetModules();
      vi.doMock("../../config/runtime.js", () => ({
        getRuntimeConfig: vi.fn(() => ({
          anthropic: {
            defaultHaikuModel: "MiniMax-M3",
            defaultSonnetModel: "MiniMax-M3",
            defaultOpusModel: "MiniMax-M3",
          },
        })),
      }));
      const { resolveTierModel: fresh } = await import("../../manager/effort-tier-resolver.js");
      const result = fresh(makeConfig({ effortTier: "high" }), undefined);
      expect(result).toEqual({ model: "MiniMax-M3", fallbackModel: undefined });
    });

    it("medium tier drops the fallback when sonnet and haiku resolve to the same model", async () => {
      vi.resetModules();
      vi.doMock("../../config/runtime.js", () => ({
        getRuntimeConfig: vi.fn(() => ({
          anthropic: {
            defaultHaikuModel: "same-model",
            defaultSonnetModel: "same-model",
            defaultOpusModel: "opus-x",
          },
        })),
      }));
      const { resolveTierModel: fresh } = await import("../../manager/effort-tier-resolver.js");
      const result = fresh(makeConfig({ effortTier: "medium" }), undefined);
      expect(result).toEqual({ model: "same-model", fallbackModel: undefined });
    });
  });

  describe("model config values are trimmed", () => {
    it("trims surrounding whitespace and keeps a distinct fallback", async () => {
      vi.resetModules();
      vi.doMock("../../config/runtime.js", () => ({
        getRuntimeConfig: vi.fn(() => ({
          anthropic: {
            defaultHaikuModel: "haiku-x",
            defaultSonnetModel: "doubao-pro",
            defaultOpusModel: " glm-5.1 ",
          },
        })),
      }));
      const { resolveTierModel: fresh } = await import("../../manager/effort-tier-resolver.js");
      const result = fresh(makeConfig({ effortTier: "high" }), undefined);
      expect(result).toEqual({ model: "glm-5.1", fallbackModel: "doubao-pro" });
    });

    it("drops the fallback when trimming makes the two values identical", async () => {
      vi.resetModules();
      vi.doMock("../../config/runtime.js", () => ({
        getRuntimeConfig: vi.fn(() => ({
          anthropic: {
            defaultHaikuModel: "haiku-x",
            defaultSonnetModel: " m3 ",
            defaultOpusModel: "m3",
          },
        })),
      }));
      const { resolveTierModel: fresh } = await import("../../manager/effort-tier-resolver.js");
      const result = fresh(makeConfig({ effortTier: "high" }), undefined);
      expect(result).toEqual({ model: "m3", fallbackModel: undefined });
    });
  });
});
