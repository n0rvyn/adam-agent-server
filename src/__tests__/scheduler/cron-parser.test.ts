import { describe, it, expect } from "vitest";
import { CronExpressionParser } from "cron-parser";

describe("cron-parser integration", () => {
  it("parses daily at 9 AM correctly", () => {
    const expr = CronExpressionParser.parse("0 9 * * *");
    const next = expr.next();
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it("parses every 5 minutes", () => {
    const expr = CronExpressionParser.parse("*/5 * * * *");
    const next = expr.next();
    expect(next.getMinutes() % 5).toBe(0);
  });

  it("parses twice daily at 8 and 20", () => {
    const expr = CronExpressionParser.parse("0 8,20 * * *");
    const next = expr.next();
    const hour = next.getHours();
    expect([8, 20]).toContain(hour);
  });

  it("parses weekly on Monday at 9", () => {
    const expr = CronExpressionParser.parse("0 9 * * 1");
    const next = expr.next();
    expect(next.getDay()).toBe(1); // Monday
    expect(next.getHours()).toBe(9);
  });

  it("parses every 15 minutes", () => {
    const expr = CronExpressionParser.parse("*/15 * * * *");
    const next = expr.next();
    expect(next.getMinutes() % 15).toBe(0);
  });

  it("throws on invalid expression", () => {
    expect(() => CronExpressionParser.parse("invalid")).toThrow();
  });

  it("throws on incomplete expression", () => {
    expect(() => CronExpressionParser.parse("* *")).toThrow();
  });

  it("calculates correct delay to next occurrence", () => {
    const expr = CronExpressionParser.parse("*/1 * * * *"); // every minute
    const next = expr.next();
    const delay = next.getTime() - Date.now();
    // Should be between 0 and 60 seconds
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(60000);
  });
});
