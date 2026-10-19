import { describe, it, expect } from "vitest";
import {
  getPresetRoles,
  getPresetTemplates,
  getPresetRole,
  PRESET_ROLE_NAMES,
} from "../../presets/index.js";
import { isPresetRole } from "../../store/role-presets.js";

describe("presets/index", () => {
  describe("getPresetRoles", () => {
    it("returns 8 preset roles", () => {
      const roles = getPresetRoles();
      expect(roles).toHaveLength(8);
    });

    it("returns the expected role presetIds", () => {
      const roles = getPresetRoles();
      const ids = roles.map((r) => r.presetId);
      expect(ids).toContain("engineer");
      expect(ids).toContain("feature-miner");
      expect(ids).toContain("adam-automator");
      expect(ids).toContain("mistake-digester");
    });
  });

  describe("getPresetTemplates", () => {
    it("returns 2 preset templates", () => {
      const templates = getPresetTemplates();
      expect(templates).toHaveLength(2);
    });

    it("includes feature-mining and mistake-digest templates", () => {
      const templates = getPresetTemplates();
      const ids = templates.map((t) => t.presetId);
      expect(ids).toContain("feature-mining");
      expect(ids).toContain("mistake-digest");
    });
  });

  describe("getPresetRole", () => {
    it("returns the feature-miner preset by id", () => {
      const preset = getPresetRole("feature-miner");
      expect(preset).toBeDefined();
      expect(preset!.name).toBe("Feature Miner");
      expect(preset!.presetId).toBe("feature-miner");
    });

    it("returns undefined for nonexistent presetId", () => {
      const preset = getPresetRole("nonexistent-preset");
      expect(preset).toBeUndefined();
    });
  });

  describe("PRESET_ROLE_NAMES", () => {
    it("matches the role names in the registry", () => {
      const roles = getPresetRoles();
      const names = roles.map((r) => r.name);
      for (const name of PRESET_ROLE_NAMES) {
        expect(names).toContain(name);
      }
    });
  });

  describe("isPresetRole", () => {
    it("returns true for engineer", () => {
      expect(isPresetRole({ name: "Engineer" })).toBe(true);
    });
    it("returns true for Feature Miner", () => {
      expect(isPresetRole({ name: "Feature Miner" })).toBe(true);
    });
    it("returns false for non-preset role name", () => {
      expect(isPresetRole({ name: "My Custom Role" })).toBe(false);
    });
  });
});
