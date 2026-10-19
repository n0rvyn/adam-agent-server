import { describe, it, expect } from "vitest";
import { buildRoleSystemPrompt } from "../../agent/persona.js";

describe("buildRoleSystemPrompt", () => {
  it("includes role and name in the output", () => {
    const result = buildRoleSystemPrompt(
      "Engineer",
      "Ada",
      ["Read", "Write"],
      ["rm"],
    );
    expect(result).toContain("Role: Engineer");
    expect(result).toContain("Name: Ada");
  });

  it("lists allowed and denied tools", () => {
    const result = buildRoleSystemPrompt(
      "Engineer", "Ada",
      ["Read", "Write"], ["rm"],
    );
    expect(result).toContain("Allowed Tools: Read, Write");
    expect(result).toContain("Disallowed Tools: rm");
  });

  it("does not include path restrictions (sandbox handles paths)", () => {
    const result = buildRoleSystemPrompt(
      "Engineer", "Ada",
      [], [],
    );
    expect(result).not.toContain("Allowed Paths");
    expect(result).not.toContain("Denied Paths");
  });

  it("handles empty allowedTools with '(all)'", () => {
    const result = buildRoleSystemPrompt(
      "Engineer", "Ada",
      [], [],
    );
    expect(result).toContain("Allowed Tools: (all)");
    expect(result).toContain("Disallowed Tools: (none)");
  });

  it("does NOT contain 'claude_code' preset identity", () => {
    const result = buildRoleSystemPrompt(
      "Analyst", "DataBot",
      ["Read"], [],
    );
    expect(result).not.toContain("claude_code");
    expect(result).not.toContain("You are Adam");
  });
});
