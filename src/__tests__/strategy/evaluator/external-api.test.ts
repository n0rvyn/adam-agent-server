import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../../config/defaults.js", () => ({
  DEFAULT_CONFIG: {
    externalApis: [
      { name: "test-api", url: "https://api.example.com/score", scorePath: "data.score" },
    ],
  },
}));

vi.mock("../../../lib/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { collectExternalApiScores } from "../../../strategy/evaluator/collectors/external-api.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("external-api collector", () => {
  it("fetches score from configured endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { score: 0.85 } }), { status: 200 }),
    );

    const result = await collectExternalApiScores("goal-1");
    expect(result.scores).toHaveLength(1);
    expect(result.scores[0].score).toBe(0.85);
    expect(result.errors).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it("returns error when fetch fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    const result = await collectExternalApiScores("goal-1");
    expect(result.scores).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Network error");

    fetchSpy.mockRestore();
  });

  it("clamps score to 0-1 range", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { score: 5.0 } }), { status: 200 }),
    );

    const result = await collectExternalApiScores("goal-1");
    expect(result.scores[0].score).toBe(1);

    fetchSpy.mockRestore();
  });

  it("returns error when score is not a number", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { score: "not-a-number" } }), { status: 200 }),
    );

    const result = await collectExternalApiScores("goal-1");
    expect(result.scores).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("not a number");

    fetchSpy.mockRestore();
  });
});
