import { describe, it, expect } from "vitest";
import { taskStepSchema } from "../../server/routes/task-templates.js";

describe("taskStepSchema — assertions field", () => {
  it("accepts a step with assertions array present", () => {
    const result = taskStepSchema.parse({
      id: "s1",
      prompt: "p",
      assertions: ["audio.duration_s > 60"],
    });
    expect(result.assertions).toEqual(["audio.duration_s > 60"]);
  });

  it("accepts a step with multiple assertions", () => {
    const result = taskStepSchema.parse({
      id: "s2",
      prompt: "p",
      assertions: [
        "audio.duration_s between 60 and 1800",
        "audio.zc_rate_per_s < 5000",
        "markdown.word_count > 100",
      ],
    });
    expect(result.assertions).toHaveLength(3);
  });

  it("omitting assertions returns undefined (not null, not error)", () => {
    const result = taskStepSchema.parse({ id: "s1", prompt: "p" });
    expect(result.assertions).toBeUndefined();
  });

  it("rejects assertions when not an array", () => {
    expect(() =>
      taskStepSchema.parse({ id: "s1", prompt: "p", assertions: "not-an-array" }),
    ).toThrow();
  });

  it("rejects assertions when array contains non-strings", () => {
    expect(() =>
      taskStepSchema.parse({ id: "s1", prompt: "p", assertions: [123, true] }),
    ).toThrow();
  });
});
