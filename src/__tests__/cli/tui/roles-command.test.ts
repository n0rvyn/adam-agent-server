import { describe, it, expect, beforeEach } from "vitest";
import { findCommand, findPrefixMatch, filterCommands } from "../../../cli/tui/commands.js";

describe("TUI Commands", () => {
  describe("roles command", () => {
    it("should include roles command", () => {
      const cmd = findCommand("roles");
      expect(cmd).toBeDefined();
      expect(cmd?.name).toBe("roles");
      expect(cmd?.description).toBe("Role management");
    });

    it("should be found via prefix match", () => {
      const cmd = findPrefixMatch("role");
      expect(cmd?.name).toBe("roles");
    });

    it("should appear in filtered list for 'r'", () => {
      const filtered = filterCommands("r");
      const names = filtered.map((c) => c.name);
      expect(names).toContain("roles");
    });

    it("should appear in filtered list for 'roles'", () => {
      const filtered = filterCommands("roles");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe("roles");
    });
  });
});
