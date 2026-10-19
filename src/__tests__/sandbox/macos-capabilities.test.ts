import { describe, it, expect } from "vitest";
import {
  generateCapabilityRules,
  validateSbplBundleId,
} from "../../sandbox/macos-capabilities.js";

describe("sandbox/macos-capabilities", () => {
  it("generates target-scoped automation SBPL rules", () => {
    const rules = generateCapabilityRules([
      { id: "automation", targets: ["com.apple.mail", "com.apple.systemevents"] },
    ]);

    expect(rules).toContain("; ===== Role OS capability: Automation =====");
    expect(rules).toContain("(allow lsopen)");
    expect(rules).toContain("(allow mach-lookup");
    expect(rules).toContain('(global-name "com.apple.coreservices.appleevents")');
    expect(rules).toContain('(allow appleevent-send (appleevent-destination "com.apple.mail"))');
    expect(rules).toContain('(allow appleevent-send (appleevent-destination "com.apple.systemevents"))');
  });

  it("generates accessibility rules separately", () => {
    const rules = generateCapabilityRules([{ id: "accessibility" }]);

    expect(rules).toContain("; ===== Role OS capability: Accessibility =====");
    expect(rules).toContain("(allow mach-priv-host-port)");
    expect(rules).toContain("(allow mach-task-name)");
    expect(rules).toContain('(allow mach-lookup (local-name "com.apple.axserver"))');
    expect(rules).toContain('(preference-domain "com.apple.Accessibility")');
  });

  it("returns empty string when no supported capability is selected", () => {
    expect(generateCapabilityRules(undefined)).toBe("");
    expect(generateCapabilityRules([])).toBe("");
  });

  it("rejects invalid automation bundle ids", () => {
    expect(() => validateSbplBundleId("Mail App")).toThrow("Invalid bundle id");
  });
});
