/**
 * Task 2: live-session config keys — maxConcurrentLiveSessions + liveSessionIdleMinutes.
 *
 * Verifies:
 * - Both keys are in MUTABLE_PATHS (silent PATCH reject guard).
 * - DEFAULT_CONFIG seeds maxConcurrentLiveSessions=3 and liveSessionIdleMinutes=30.
 * - Validators accept positive integers and reject 0, negatives, NaN, floats, non-numbers.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { initRuntimeConfig, isMutablePath, updateMutableConfig, getRuntimeConfig } from "../../config/runtime.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { ServerConfig } from "../../shared/types.js";

beforeEach(() => {
  initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
});

// ─── maxConcurrentLiveSessions ────────────────────────────────────────────────

describe("chat.maxConcurrentLiveSessions config layer", () => {
  it("is in MUTABLE_PATHS", () => {
    expect(isMutablePath("chat.maxConcurrentLiveSessions")).toBe(true);
  });

  it("DEFAULT_CONFIG seeds maxConcurrentLiveSessions = 3", () => {
    expect(DEFAULT_CONFIG.chat?.maxConcurrentLiveSessions).toBe(3);
  });

  it("getRuntimeConfig().chat.maxConcurrentLiveSessions = 3 after init", () => {
    expect(getRuntimeConfig().chat?.maxConcurrentLiveSessions).toBe(3);
  });

  describe("validator accepts valid values", () => {
    it("accepts 1", () => {
      const result = updateMutableConfig({ "chat.maxConcurrentLiveSessions": 1 });
      expect(result.errors).toHaveLength(0);
      expect(result.updated).toContain("chat.maxConcurrentLiveSessions");
    });

    it("accepts 3 (default)", () => {
      const result = updateMutableConfig({ "chat.maxConcurrentLiveSessions": 3 });
      expect(result.errors).toHaveLength(0);
    });

    it("accepts 10", () => {
      const result = updateMutableConfig({ "chat.maxConcurrentLiveSessions": 10 });
      expect(result.errors).toHaveLength(0);
      expect(getRuntimeConfig().chat?.maxConcurrentLiveSessions).toBe(10);
    });
  });

  describe("validator rejects invalid values", () => {
    it("rejects 0", () => {
      const result = updateMutableConfig({ "chat.maxConcurrentLiveSessions": 0 });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("chat.maxConcurrentLiveSessions");
    });

    it("rejects -1 (negative)", () => {
      const result = updateMutableConfig({ "chat.maxConcurrentLiveSessions": -1 });
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects NaN", () => {
      const result = updateMutableConfig({ "chat.maxConcurrentLiveSessions": NaN });
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects 1.5 (float)", () => {
      const result = updateMutableConfig({ "chat.maxConcurrentLiveSessions": 1.5 });
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects string '3'", () => {
      const result = updateMutableConfig({ "chat.maxConcurrentLiveSessions": "3" });
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects null", () => {
      const result = updateMutableConfig({ "chat.maxConcurrentLiveSessions": null });
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});

// ─── liveSessionIdleMinutes ───────────────────────────────────────────────────

describe("chat.liveSessionIdleMinutes config layer", () => {
  it("is in MUTABLE_PATHS", () => {
    expect(isMutablePath("chat.liveSessionIdleMinutes")).toBe(true);
  });

  it("DEFAULT_CONFIG seeds liveSessionIdleMinutes = 30", () => {
    expect(DEFAULT_CONFIG.chat?.liveSessionIdleMinutes).toBe(30);
  });

  it("getRuntimeConfig().chat.liveSessionIdleMinutes = 30 after init", () => {
    expect(getRuntimeConfig().chat?.liveSessionIdleMinutes).toBe(30);
  });

  describe("validator accepts valid values", () => {
    it("accepts 1", () => {
      const result = updateMutableConfig({ "chat.liveSessionIdleMinutes": 1 });
      expect(result.errors).toHaveLength(0);
      expect(result.updated).toContain("chat.liveSessionIdleMinutes");
    });

    it("accepts 60", () => {
      const result = updateMutableConfig({ "chat.liveSessionIdleMinutes": 60 });
      expect(result.errors).toHaveLength(0);
      expect(getRuntimeConfig().chat?.liveSessionIdleMinutes).toBe(60);
    });
  });

  describe("validator rejects invalid values", () => {
    it("rejects 0", () => {
      const result = updateMutableConfig({ "chat.liveSessionIdleMinutes": 0 });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("chat.liveSessionIdleMinutes");
    });

    it("rejects -5 (negative)", () => {
      const result = updateMutableConfig({ "chat.liveSessionIdleMinutes": -5 });
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects NaN", () => {
      const result = updateMutableConfig({ "chat.liveSessionIdleMinutes": NaN });
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects 1.5 (float)", () => {
      const result = updateMutableConfig({ "chat.liveSessionIdleMinutes": 1.5 });
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects string '30'", () => {
      const result = updateMutableConfig({ "chat.liveSessionIdleMinutes": "30" });
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
