import { describe, it, expect } from "vitest";
import { PLAYWRIGHT_TOOLS, SENSITIVE_PLAYWRIGHT_TOOLS, executePlaywrightTool } from "../../plugins/playwright/playwright-tools.js";

describe("plugins/playwright-tools", () => {
  describe("tool sets", () => {
    it("defines 6 browser tools", () => {
      expect(PLAYWRIGHT_TOOLS.size).toBe(6);
      expect(PLAYWRIGHT_TOOLS.has("browser_navigate")).toBe(true);
      expect(PLAYWRIGHT_TOOLS.has("browser_click")).toBe(true);
      expect(PLAYWRIGHT_TOOLS.has("browser_type")).toBe(true);
      expect(PLAYWRIGHT_TOOLS.has("browser_screenshot")).toBe(true);
      expect(PLAYWRIGHT_TOOLS.has("browser_evaluate")).toBe(true);
      expect(PLAYWRIGHT_TOOLS.has("browser_snapshot")).toBe(true);
    });

    it("defines 3 sensitive tools requiring approval (D-015)", () => {
      expect(SENSITIVE_PLAYWRIGHT_TOOLS.size).toBe(3);
      expect(SENSITIVE_PLAYWRIGHT_TOOLS.has("browser_click")).toBe(true);
      expect(SENSITIVE_PLAYWRIGHT_TOOLS.has("browser_type")).toBe(true);
      expect(SENSITIVE_PLAYWRIGHT_TOOLS.has("browser_evaluate")).toBe(true);
      // Non-sensitive
      expect(SENSITIVE_PLAYWRIGHT_TOOLS.has("browser_navigate")).toBe(false);
      expect(SENSITIVE_PLAYWRIGHT_TOOLS.has("browser_screenshot")).toBe(false);
    });
  });

  describe("executePlaywrightTool", () => {
    it("returns error for unknown tool", async () => {
      const result = await executePlaywrightTool("browser_unknown", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown Playwright tool");
    });

    it("returns error when playwright not installed (navigate)", async () => {
      // Playwright is not installed in test env
      const result = await executePlaywrightTool("browser_navigate", { url: "https://example.com" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("not installed");
    });

    it("returns error when playwright not installed (screenshot)", async () => {
      const result = await executePlaywrightTool("browser_screenshot", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("not installed");
    });
  });
});
