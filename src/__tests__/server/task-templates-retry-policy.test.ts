import { describe, it, expect } from "vitest";
import { createBodySchema } from "../../server/routes/task-templates.js";

describe("createBodySchema — retryPolicy field", () => {
  it("accepts a body with retryPolicy: { maxAttempts: 2 }", () => {
    const result = createBodySchema.parse({
      name: "Test Template",
      trigger: { type: "manual" },
      steps: [{ id: "s1", prompt: "do the thing" }],
      retryPolicy: { maxAttempts: 2 },
    });
    expect(result.retryPolicy).toEqual({ maxAttempts: 2 });
  });

  it("accepts a body without retryPolicy (optional field)", () => {
    const result = createBodySchema.parse({
      name: "Test Template",
      trigger: { type: "manual" },
      steps: [{ id: "s1", prompt: "do the thing" }],
    });
    expect(result.retryPolicy).toBeUndefined();
  });

  it("rejects retryPolicy with maxAttempts = 0", () => {
    expect(() =>
      createBodySchema.parse({
        name: "Test Template",
        trigger: { type: "manual" },
        steps: [{ id: "s1", prompt: "do the thing" }],
        retryPolicy: { maxAttempts: 0 },
      }),
    ).toThrow();
  });

  it("rejects retryPolicy with non-positive maxAttempts", () => {
    expect(() =>
      createBodySchema.parse({
        name: "Test Template",
        trigger: { type: "manual" },
        steps: [{ id: "s1", prompt: "do the thing" }],
        retryPolicy: { maxAttempts: -1 },
      }),
    ).toThrow();
  });

  it("rejects retryPolicy with non-integer maxAttempts", () => {
    expect(() =>
      createBodySchema.parse({
        name: "Test Template",
        trigger: { type: "manual" },
        steps: [{ id: "s1", prompt: "do the thing" }],
        retryPolicy: { maxAttempts: 2.5 },
      }),
    ).toThrow();
  });

  it("survives createBodySchema.parse for maxAttempts=3 (DB round-trip shape)", () => {
    const input = {
      name: "Retry Test",
      trigger: { type: "manual" },
      steps: [{ id: "s1", prompt: "publish a file" }],
      retryPolicy: { maxAttempts: 3 },
    };
    const parsed = createBodySchema.parse(input);
    expect(parsed.retryPolicy).toEqual({ maxAttempts: 3 });
    // The transform (if any) should pass it through — verify the shape is unchanged
    expect(typeof parsed.retryPolicy!.maxAttempts).toBe("number");
  });
});
