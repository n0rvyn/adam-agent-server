import { describe, it, expect } from "vitest";
import { commands, filterCommands, findCommand, findPrefixMatch } from "../../../cli/tui/commands.js";

describe("commands registry", () => {
  it("has 12 commands", () => {
    expect(commands).toHaveLength(12);
  });

  it("each command has name and description", () => {
    for (const cmd of commands) {
      expect(cmd.name).toBeTruthy();
      expect(cmd.description).toBeTruthy();
    }
  });

  it("includes all expected commands", () => {
    const names = commands.map((c) => c.name);
    expect(names).toContain("work");
    expect(names).toContain("config");
    expect(names).toContain("evolution");
    expect(names).toContain("webhooks");
    expect(names).toContain("memories");
    expect(names).toContain("strategies");
    expect(names).toContain("plugins");
    expect(names).toContain("roles");
    expect(names).toContain("artifacts");
    expect(names).toContain("settings");
    expect(names).toContain("back");
    expect(names).toContain("quit");
  });
});

describe("filterCommands()", () => {
  it("returns all commands for empty query", () => {
    expect(filterCommands("")).toHaveLength(12);
  });

  it("filters by prefix", () => {
    const results = filterCommands("wo");
    expect(results.map((c) => c.name)).toEqual(["work"]);
  });

  it("returns multiple matches", () => {
    const results = filterCommands("s");
    const names = results.map((c) => c.name);
    expect(names).toContain("strategies");
    expect(names).toContain("settings");
  });

  it("returns empty for no match", () => {
    expect(filterCommands("xyz")).toHaveLength(0);
  });

  it("is case-insensitive", () => {
    expect(filterCommands("WO")).toHaveLength(1);
  });
});

describe("findCommand()", () => {
  it("finds exact match", () => {
    expect(findCommand("work")?.name).toBe("work");
  });

  it("returns undefined for no match", () => {
    expect(findCommand("nope")).toBeUndefined();
  });
});

describe("findPrefixMatch()", () => {
  it("returns command for unique prefix", () => {
    expect(findPrefixMatch("ev")?.name).toBe("evolution");
  });

  it("returns undefined for ambiguous prefix", () => {
    // "s" matches strategies, settings
    expect(findPrefixMatch("s")).toBeUndefined();
  });

  it("returns undefined for no match", () => {
    expect(findPrefixMatch("xyz")).toBeUndefined();
  });
});
