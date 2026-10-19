/**
 * Task 3-tests: artifact-priority heuristic
 *
 * Tests FAIL before Task 3-impl because src/lib/artifact-priority.ts doesn't exist yet.
 * Expected fail signal: "Cannot find module '../../lib/artifact-priority'"
 *
 * After Task 3-impl: 9/9 pass.
 */
import { describe, it, expect } from "vitest";
import { effectivePriority } from "../../lib/artifact-priority.js";

// Case A: explicit priority set → return that value
describe("effectivePriority — Case A: explicit priority is returned as-is", () => {
  it("returns 7 when priority=7", () => {
    expect(effectivePriority({ priority: 7, mime: "application/pdf" })).toBe(7);
  });
});

// Case B: audio mime → 10
describe("effectivePriority — Case B: audio/mp3 → 10", () => {
  it("returns 10 for audio/mp3", () => {
    expect(effectivePriority({ priority: undefined, mime: "audio/mp3" })).toBe(10);
  });
});

// Case C: video mime → 10
describe("effectivePriority — Case C: video/mp4 → 10", () => {
  it("returns 10 for video/mp4", () => {
    expect(effectivePriority({ priority: undefined, mime: "video/mp4" })).toBe(10);
  });
});

// Case D: text/markdown → 50
describe("effectivePriority — Case D: text/markdown → 50", () => {
  it("returns 50 for text/markdown", () => {
    expect(effectivePriority({ priority: undefined, mime: "text/markdown" })).toBe(50);
  });
});

// Case E: text/plain → 50
describe("effectivePriority — Case E: text/plain → 50", () => {
  it("returns 50 for text/plain", () => {
    expect(effectivePriority({ priority: undefined, mime: "text/plain" })).toBe(50);
  });
});

// Case F: image/png → 100
describe("effectivePriority — Case F: image/png → 100", () => {
  it("returns 100 for image/png", () => {
    expect(effectivePriority({ priority: undefined, mime: "image/png" })).toBe(100);
  });
});

// Case G: application/pdf → 200 (other)
describe("effectivePriority — Case G: application/pdf → 200", () => {
  it("returns 200 for application/pdf", () => {
    expect(effectivePriority({ priority: undefined, mime: "application/pdf" })).toBe(200);
  });
});

// Case H: mime=undefined → 200
describe("effectivePriority — Case H: undefined mime → 200", () => {
  it("returns 200 when mime is undefined", () => {
    expect(effectivePriority({ priority: undefined, mime: undefined })).toBe(200);
  });
});

// Case I: priority=0 → returns 0 (NOT falsy-coerced to heuristic)
describe("effectivePriority — Case I: priority=0 returns 0 (not heuristic)", () => {
  it("returns 0 when priority=0 (highest priority)", () => {
    expect(effectivePriority({ priority: 0, mime: "application/pdf" })).toBe(0);
  });
});
