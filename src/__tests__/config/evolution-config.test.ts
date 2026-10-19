/**
 * UT: Evolution config loading from yaml (via DEFAULT_CONFIG).
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG } from "../../config/defaults.js";

describe("evolution config", () => {
  it("DEFAULT_CONFIG has agents.evolution with triggerEvery", () => {
    expect(DEFAULT_CONFIG.roles?.evolution?.triggerEvery).toBe(5);
  });

  it("DEFAULT_CONFIG has agents.evolution with reflectionThreshold", () => {
    expect(DEFAULT_CONFIG.roles?.evolution?.reflectionThreshold).toBe(150);
  });

  it("DEFAULT_CONFIG has agents.evolution with retirementThreshold", () => {
    expect(DEFAULT_CONFIG.roles?.evolution?.retirementThreshold).toBe(0.4);
  });

  it("DEFAULT_CONFIG has workspacePath defaulting to process.cwd()", () => {
    expect(DEFAULT_CONFIG.defaults.workspacePath).toBeDefined();
    expect(typeof DEFAULT_CONFIG.defaults.workspacePath).toBe("string");
  });

  it("DEFAULT_CONFIG has settingSources including 'user'", () => {
    expect(DEFAULT_CONFIG.defaults.settingSources).toContain("user");
  });
});
