import { describe, it, expect } from "vitest";
import { sanitizeSignal } from "../../security/signal-sanitizer.js";

describe("signal-sanitizer ReDoS resistance", () => {
  it("completes within 100ms on 10KB pathological input", () => {
    // Worst-case for naive nested quantifiers: many a's followed by !
    const pathological = "a".repeat(10000) + "!";
    const t0 = Date.now();
    sanitizeSignal({ body: pathological }, "test");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(100);
  });

  it("completes within 200ms on long string with near-matches", () => {
    // String that almost matches several patterns but doesn't
    const nearMatch = "ignore the prior agreement; system check; you are now done".repeat(500);
    const t0 = Date.now();
    sanitizeSignal({ body: nearMatch }, "test");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(200);
  });
});
