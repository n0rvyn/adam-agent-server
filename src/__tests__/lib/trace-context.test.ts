import { describe, it, expect } from "vitest";
import { withNewTrace, withTrace, getCurrentTraceId, getTraceStore } from "../../lib/trace-context.js";

describe("trace-context", () => {
  it("returns undefined outside any context", () => {
    expect(getCurrentTraceId()).toBeUndefined();
    expect(getTraceStore()).toBeUndefined();
  });

  it("withNewTrace generates a UUID and exposes it", () => {
    const seen = withNewTrace("chat", () => getCurrentTraceId());
    expect(seen).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("withTrace accepts an explicit ID", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const seen = withTrace(id, "webhook", () => getCurrentTraceId());
    expect(seen).toBe(id);
  });

  it("propagates across await boundaries", async () => {
    const seen = await withNewTrace("chat", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getCurrentTraceId();
    });
    expect(seen).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("nested withNewTrace overrides the outer trace", () => {
    const result = withNewTrace("chat", () => {
      const outer = getCurrentTraceId();
      const inner = withNewTrace("webhook", () => getCurrentTraceId());
      return { outer, inner, after: getCurrentTraceId() };
    });
    expect(result.outer).not.toBe(result.inner);
    expect(result.after).toBe(result.outer);
  });

  it("getTraceStore returns origin alongside ID", () => {
    const store = withNewTrace("template", () => getTraceStore());
    expect(store?.origin).toBe("template");
  });
});
