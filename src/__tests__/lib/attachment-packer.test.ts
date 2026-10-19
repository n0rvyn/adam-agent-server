/**
 * Task 4-tests: attachment-packer
 *
 * Tests FAIL before Task 4-impl because src/lib/attachment-packer.ts doesn't exist yet.
 * Expected fail signal: "Cannot find module '../../lib/attachment-packer'"
 *
 * After Task 4-impl: 7/7 pass.
 */
import { describe, it, expect } from "vitest";
import { packAttachmentsToCap } from "../../lib/attachment-packer.js";
import type { PackInput } from "../../lib/attachment-packer.js";

const MB = 1024 * 1024;

// Case A: empty input → { included: [], dropped: [] }
describe("packAttachmentsToCap — Case A: empty input", () => {
  it("returns empty included and dropped for empty input", () => {
    const result = packAttachmentsToCap([], 20 * MB);
    expect(result).toEqual({ included: [], dropped: [] });
  });
});

// Case B: single small item below cap → included; dropped empty
describe("packAttachmentsToCap — Case B: single small item below cap", () => {
  it("includes a single item that fits under cap", () => {
    const item: PackInput = { id: "a1", sizeBytes: 5 * MB, priority: 10 };
    const result = packAttachmentsToCap([item], 20 * MB);
    expect(result).toEqual({ included: [item], dropped: [] });
  });
});

// Case C: single item > cap → firstItemOverflow sentinel
describe("packAttachmentsToCap — Case C: single item exceeds cap", () => {
  it("returns firstItemOverflow when the only item exceeds cap (×1.33)", () => {
    // 16MB × 1.33 = 21.28MB > 20MB cap
    const item: PackInput = { id: "a2", sizeBytes: 16 * MB, priority: 10 };
    const result = packAttachmentsToCap([item], 20 * MB);
    expect(result).toHaveProperty("firstItemOverflow");
    if ("firstItemOverflow" in result) {
      expect(result.firstItemOverflow).toBe(item);
    }
  });
});

// Case D: 3 items, all fit → all included, in priority order (10, 50, 100)
describe("packAttachmentsToCap — Case D: 3 items all fit", () => {
  it("includes all items in priority-ascending order when all fit", () => {
    const items: PackInput[] = [
      { id: "d3", sizeBytes: 1 * MB, priority: 100 },
      { id: "d1", sizeBytes: 1 * MB, priority: 10 },
      { id: "d2", sizeBytes: 1 * MB, priority: 50 },
    ];
    const result = packAttachmentsToCap(items, 20 * MB);
    expect("included" in result).toBe(true);
    if ("included" in result) {
      expect(result.dropped).toEqual([]);
      expect(result.included.map((i) => i.id)).toEqual(["d1", "d2", "d3"]);
    }
  });
});

// Case E: greedy packing — 5 items, cap 15MB
// Sorted order: priority-asc then size-desc
// priorities: [100, 10, 100, 10, 50], sizes: [1MB, 5MB, 2MB, 8MB, 1MB]
// Sorted: [e4(8MB@10), e2(5MB@10), e5(1MB@50), e3(2MB@100), e1(1MB@100)]
// Effective bytes (1.33x): [10.64MB, 6.65MB, 1.33MB, 2.66MB, 1.33MB]
// Greedy (skip-and-continue, NOT stop-at-first-drop):
//   e4: consumed=10.64 ✓
//   e2: 10.64+6.65=17.29 > 15 → dropped
//   e5: 10.64+1.33=11.97 ≤ 15 → consumed=11.97 ✓
//   e3: 11.97+2.66=14.63 ≤ 15 → consumed=14.63 ✓
//   e1: 14.63+1.33=15.96 > 15 → dropped
// Included=[e4,e5,e3], dropped=[e2,e1]
describe("packAttachmentsToCap — Case E: greedy packing skips oversized, continues", () => {
  it("skips items that would overflow cap and continues packing smaller items", () => {
    const items: PackInput[] = [
      { id: "e1", sizeBytes: 1 * MB, priority: 100 },
      { id: "e2", sizeBytes: 5 * MB, priority: 10 },
      { id: "e3", sizeBytes: 2 * MB, priority: 100 },
      { id: "e4", sizeBytes: 8 * MB, priority: 10 },
      { id: "e5", sizeBytes: 1 * MB, priority: 50 },
    ];
    const result = packAttachmentsToCap(items, 15 * MB);
    expect("included" in result).toBe(true);
    if ("included" in result) {
      expect(result.included.map((i) => i.id)).toEqual(["e4", "e5", "e3"]);
      expect(result.dropped.map((i) => i.id)).toEqual(["e2", "e1"]);
    }
  });
});

// Case F: priority ties broken by size DESC (within same priority, bigger first)
describe("packAttachmentsToCap — Case F: tie-breaking by size DESC within same priority", () => {
  it("sorts bigger items first when priorities are equal", () => {
    const items: PackInput[] = [
      { id: "f1", sizeBytes: 3 * MB, priority: 10 },
      { id: "f2", sizeBytes: 8 * MB, priority: 10 },
      { id: "f3", sizeBytes: 1 * MB, priority: 10 },
    ];
    // All fit in 20MB cap: sorted order should be f2 (8MB), f1 (3MB), f3 (1MB)
    const result = packAttachmentsToCap(items, 20 * MB);
    expect("included" in result).toBe(true);
    if ("included" in result) {
      expect(result.included.map((i) => i.id)).toEqual(["f2", "f1", "f3"]);
    }
  });
});

// Case G: undefined-priority items sorted by effectivePriority heuristic
// audio (heuristic=10) outranks image (heuristic=100)
describe("packAttachmentsToCap — Case G: undefined priority uses effectivePriority heuristic", () => {
  it("audio without explicit priority ranks above image without explicit priority", () => {
    const items: PackInput[] = [
      { id: "g1", sizeBytes: 2 * MB, mime: "image/png" },         // heuristic = 100
      { id: "g2", sizeBytes: 2 * MB, mime: "audio/mp3" },         // heuristic = 10
    ];
    const result = packAttachmentsToCap(items, 20 * MB);
    expect("included" in result).toBe(true);
    if ("included" in result) {
      expect(result.included.map((i) => i.id)).toEqual(["g2", "g1"]);
    }
  });
});
