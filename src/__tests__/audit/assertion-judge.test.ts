import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCustomAssertionsCheck, buildPrompt } from "../../audit/assertion-judge.js";

vi.mock("../../lib/llm-eval.js", () => ({
  callClaudeForEvaluation: vi.fn(),
}));

import { callClaudeForEvaluation } from "../../lib/llm-eval.js";

describe("runCustomAssertionsCheck (behavior)", () => {
  beforeEach(() => vi.mocked(callClaudeForEvaluation).mockReset());

  it("returns all-pass when judge marks every assertion passed", async () => {
    const assertions = ["thesis must be falsifiable", "must cite a source"];
    vi.mocked(callClaudeForEvaluation).mockResolvedValueOnce(
      JSON.stringify({
        results: [
          { assertion: "thesis must be falsifiable", passed: true, reason: "clearly stated in para 1" },
          { assertion: "must cite a source", reason: "cites Smith 2020", passed: true },
        ],
      }),
    );

    const result = await runCustomAssertionsCheck({ assertions, stepResult: "Content body here." });
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.passed)).toBe(true);
  });

  it("returns partial results when some assertions fail", async () => {
    const assertions = [
      "thesis must be falsifiable",
      "counter-evidence required",
      "must cite a source",
      "no passive voice",
    ];
    vi.mocked(callClaudeForEvaluation).mockResolvedValueOnce(
      JSON.stringify({
        results: [
          { assertion: "thesis must be falsifiable", passed: true, reason: "ok" },
          { assertion: "counter-evidence required", passed: false, reason: "none found" },
          { assertion: "must cite a source", passed: true, reason: "cites Smith 2020" },
          { assertion: "no passive voice", passed: false, reason: "passive voice in line 3" },
        ],
      }),
    );

    const result = await runCustomAssertionsCheck({ assertions, stepResult: "Content body here." });
    expect(result.passed).toBe(false);
    expect(result.results).toHaveLength(4);
    expect(result.results.filter((r) => r.passed)).toHaveLength(2);
    expect(result.results.filter((r) => !r.passed)).toHaveLength(2);
  });

  it("retries JSON parse once on malformed first response", async () => {
    const assertions = ["thesis must be falsifiable", "must cite a source"];
    vi.mocked(callClaudeForEvaluation)
      .mockResolvedValueOnce("not json at all")
      .mockResolvedValueOnce(
        JSON.stringify({
          results: [
            { assertion: "thesis must be falsifiable", passed: true, reason: "ok" },
            { assertion: "must cite a source", passed: true, reason: "cites 2020" },
          ],
        }),
      );

    const result = await runCustomAssertionsCheck({ assertions, stepResult: "Content body." });
    expect(callClaudeForEvaluation).toHaveBeenCalledTimes(2);
    expect(result.passed).toBe(true);
  });

  it("returns all-fail when JSON malformed twice", async () => {
    const assertions = [
      "thesis must be falsifiable",
      "counter-evidence required",
      "must cite a source",
      "no passive voice",
    ];
    vi.mocked(callClaudeForEvaluation)
      .mockResolvedValueOnce("garbage response 1")
      .mockResolvedValueOnce("garbage response 2");

    const result = await runCustomAssertionsCheck({ assertions, stepResult: "Content body." });
    expect(result.passed).toBe(false);
    expect(result.results).toHaveLength(4);
    expect(result.results.every((r) => !r.passed)).toBe(true);
    expect(result.results.every((r) => r.reason.includes("could not be parsed"))).toBe(true);
  });

  it("returns all-fail with reason when callClaudeForEvaluation throws", async () => {
    const assertions = [
      "thesis must be falsifiable",
      "counter-evidence required",
      "must cite a source",
      "no passive voice",
    ];
    vi.mocked(callClaudeForEvaluation)
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"));

    const result = await runCustomAssertionsCheck({ assertions, stepResult: "Content body." });
    expect(result.passed).toBe(false);
    expect(result.results).toHaveLength(4);
    expect(result.results.every((r) => !r.passed)).toBe(true);
    expect(result.results.every((r) => r.reason.includes("judge unavailable"))).toBe(true);
    expect(result.results.every((r) => r.reason.includes("timeout"))).toBe(true);
  });
});

describe("buildPrompt (prompt-construction snapshot — guards multi-layer masking)", () => {
  it("includes every assertion as a numbered bullet AND the content body", () => {
    const assertions = ["thesis must be falsifiable", "must cite a source"];
    const stepResult = "This is the test script body.";
    const prompt = buildPrompt(assertions, stepResult);
    expect(prompt).toContain("1. thesis must be falsifiable");
    expect(prompt).toContain("2. must cite a source");
    expect(prompt).toContain("This is the test script body.");
    expect(prompt).toMatch(/output\s+JSON/i);
  });

  it("truncates content > 30000 chars and marks truncation visibly", () => {
    const long = "x".repeat(35000);
    const prompt = buildPrompt(["a"], long);
    expect(prompt.length).toBeLessThan(34000);
    expect(prompt).toContain("[...truncated]");
  });
});
