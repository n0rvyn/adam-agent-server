import { describe, it, expect } from "vitest";
import { heuristicTokenCounter } from "../../chat/context-token-counter.js";

describe("chat/context-token-counter", () => {
  it("returns 0 for empty string", () => {
    expect(heuristicTokenCounter("")).toBe(0);
  });

  it("estimates English text at ~3.5 chars/token", () => {
    const text = "Hello world this is a test"; // 26 chars
    expect(heuristicTokenCounter(text)).toBe(Math.ceil(26 / 3.5)); // 8
  });

  it("estimates CJK text at ~3.5 chars/token (mostly multi-byte)", () => {
    const text = "今天天气真好"; // 6 chars
    expect(heuristicTokenCounter(text)).toBe(Math.ceil(6 / 3.5)); // 2
  });

  it("rounds up partial tokens", () => {
    expect(heuristicTokenCounter("a")).toBe(1); // 1/3.5 = 0.28 → 1
    expect(heuristicTokenCounter("abc")).toBe(1); // 3/3.5 = 0.85 → 1
    expect(heuristicTokenCounter("abcd")).toBe(2); // 4/3.5 = 1.14 → 2
  });
});
