/**
 * Task 1-tests: attachment-packer-partial-drop
 *
 * Tests FAIL before Task 1-impl because packAttachmentsToCap currently returns
 * { firstItemOverflow } for ANY case where the highest-priority item overflows,
 * rather than attempting to pack the remaining smaller items.
 *
 * After Task 1-impl: all pass.
 */
import { describe, it, expect } from "vitest";
import { packAttachmentsToCap } from "../../lib/attachment-packer.js";
import type { PackInput } from "../../lib/attachment-packer.js";

const MB = 1024 * 1024;

// Scenario: 3 items, priorities [10, 50, 50], sizes [40MB, 100KB, 50KB], cap 35MB.
// item-1 (40MB × 1.33 = 53.2MB) overflows cap; item-2 (100KB × 1.33 ≈ 133KB) and item-3 (50KB × 1.33 ≈ 66KB) fit.
// Expected: firstOverflowWarning=true, included=[item-2, item-3], dropped=[item-1]
describe("packAttachmentsToCap — partial-drop when first item overflows but smaller items exist", () => {
  it("returns firstOverflowWarning=true and packs smaller items when first-priority item overflows", () => {
    const items: PackInput[] = [
      { id: "item-1", sizeBytes: 40 * MB, priority: 10 },     // overflows 35MB cap (53.2MB encoded)
      { id: "item-2", sizeBytes: 100 * 1024, priority: 50 },  // 133KB encoded — fits
      { id: "item-3", sizeBytes: 50 * 1024, priority: 50 },   // 66KB encoded — fits
    ];
    const result = packAttachmentsToCap(items, 35 * MB);

    // Should NOT return firstItemOverflow sentinel
    expect(result).not.toHaveProperty("firstItemOverflow");

    // Should be a PackResult with firstOverflowWarning
    expect("included" in result).toBe(true);
    if (!("included" in result)) return;

    expect(result.firstOverflowWarning).toBe(true);
    expect(result.included.map((i) => i.id)).toEqual(["item-2", "item-3"]);
    expect(result.dropped.map((i) => i.id)).toEqual(["item-1"]);
  });
});

// Edge case: single 40MB item, cap 35MB → no smaller items to pack → must still return { firstItemOverflow }
describe("packAttachmentsToCap — all items overflow → firstItemOverflow preserved", () => {
  it("returns firstItemOverflow when only item exceeds cap (no smaller items)", () => {
    const item: PackInput = { id: "item-1", sizeBytes: 40 * MB, priority: 10 };
    const result = packAttachmentsToCap([item], 35 * MB);

    expect(result).toHaveProperty("firstItemOverflow");
    if ("firstItemOverflow" in result) {
      expect(result.firstItemOverflow.id).toBe("item-1");
    }
  });

  it("returns firstItemOverflow when ALL items exceed cap (no item can pack)", () => {
    const items: PackInput[] = [
      { id: "big-1", sizeBytes: 40 * MB, priority: 10 },   // 53.2MB encoded > 35MB
      { id: "big-2", sizeBytes: 30 * MB, priority: 50 },   // 39.9MB encoded > 35MB
    ];
    const result = packAttachmentsToCap(items, 35 * MB);

    // big-1 is highest priority and overflows; big-2 also overflows → all overflow
    expect(result).toHaveProperty("firstItemOverflow");
    if ("firstItemOverflow" in result) {
      // firstItemOverflow is the highest-priority (sorted first) item
      expect(result.firstItemOverflow.id).toBe("big-1");
    }
  });
});
