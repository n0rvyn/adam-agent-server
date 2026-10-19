import { describe, it, expect } from "vitest";
import { recipientCapInputSchema } from "../../lib/recipient-cap-input.js";

describe("recipientCapInputSchema", () => {
  describe("accepts valid byte integers", () => {
    it("passes 36700160 (35 MB) as-is", () => {
      const result = recipientCapInputSchema.parse(36700160);
      expect(result).toBe(36700160);
      expect(Number.isInteger(result)).toBe(true);
    });

    it("passes 20971520 (20 MB default) as-is", () => {
      const result = recipientCapInputSchema.parse(20971520);
      expect(result).toBe(20971520);
      expect(Number.isInteger(result)).toBe(true);
    });
  });

  describe("accepts human-readable strings and converts to bytes", () => {
    it('parses "35MB" → 36700160', () => {
      const result = recipientCapInputSchema.parse("35MB");
      expect(result).toBe(36700160);
      expect(Number.isInteger(result)).toBe(true);
    });

    it('parses "35M" → 36700160', () => {
      const result = recipientCapInputSchema.parse("35M");
      expect(result).toBe(36700160);
      expect(Number.isInteger(result)).toBe(true);
    });

    it('parses "35 mb" (lowercase + space) → 36700160', () => {
      const result = recipientCapInputSchema.parse("35 mb");
      expect(result).toBe(36700160);
      expect(Number.isInteger(result)).toBe(true);
    });

    it('parses "35 MB" (uppercase + space) → 36700160', () => {
      const result = recipientCapInputSchema.parse("35 MB");
      expect(result).toBe(36700160);
      expect(Number.isInteger(result)).toBe(true);
    });

    it('parses "2MB" → 2097152 (verifying KB multiplier via MB)', () => {
      const result = recipientCapInputSchema.parse("2MB");
      expect(result).toBe(2097152);
      expect(Number.isInteger(result)).toBe(true);
    });

    it('parses "100MB" → 104857600 (100 MB, within bounds)', () => {
      const result = recipientCapInputSchema.parse("100MB");
      expect(result).toBe(104857600);
      expect(Number.isInteger(result)).toBe(true);
    });
  });

  describe("rejects out-of-range values", () => {
    it("rejects 500000 (500 KB) — below 1 MB minimum", () => {
      const result = recipientCapInputSchema.safeParse(500_000);
      expect(result.success).toBe(false);
      if (!result.success) {
        const msg = result.error.issues[0].message;
        expect(msg).toMatch(/below minimum|1 MB/i);
      }
    });

    it('rejects "300MB" (300 MB) — above 200 MB maximum', () => {
      const result = recipientCapInputSchema.safeParse("300MB");
      expect(result.success).toBe(false);
      if (!result.success) {
        const msg = result.error.issues[0].message;
        expect(msg).toMatch(/exceeds maximum|200 MB/i);
      }
    });

    it("rejects -1 (negative number)", () => {
      const result = recipientCapInputSchema.safeParse(-1);
      expect(result.success).toBe(false);
    });
  });

  describe("rejects unparseable strings", () => {
    it('rejects "abc"', () => {
      const result = recipientCapInputSchema.safeParse("abc");
      expect(result.success).toBe(false);
      if (!result.success) {
        const msg = result.error.issues[0].message;
        expect(msg).toMatch(/invalid size/i);
      }
    });

    it('rejects "" (empty string)', () => {
      const result = recipientCapInputSchema.safeParse("");
      expect(result.success).toBe(false);
    });

    it('rejects "35XB" (unknown unit suffix)', () => {
      const result = recipientCapInputSchema.safeParse("35XB");
      expect(result.success).toBe(false);
    });
  });

  describe("return type is always integer", () => {
    it("returns a number and Number.isInteger === true for int input", () => {
      const result = recipientCapInputSchema.parse(10_485_760);
      expect(typeof result).toBe("number");
      expect(Number.isInteger(result)).toBe(true);
    });

    it("returns a number and Number.isInteger === true for string input", () => {
      const result = recipientCapInputSchema.parse("10MB");
      expect(typeof result).toBe("number");
      expect(Number.isInteger(result)).toBe(true);
    });
  });

  describe("short unit aliases", () => {
    it('parses "1024K" → 1048576 (K short form, lands on lower boundary)', () => {
      const result = recipientCapInputSchema.parse("1024K");
      expect(result).toBe(1_048_576);
    });

    it('parses "1024KB" → 1048576 (KB long form on lower boundary)', () => {
      const result = recipientCapInputSchema.parse("1024KB");
      expect(result).toBe(1_048_576);
    });

    it('parses "0.1G" → 107374182 (G short form, decimal, within bounds)', () => {
      const result = recipientCapInputSchema.parse("0.1G");
      expect(result).toBe(Math.round(0.1 * 1024 * 1024 * 1024));
      expect(Number.isInteger(result)).toBe(true);
    });

    it('parses "0.1GB" → 107374182 (GB long form, decimal)', () => {
      const result = recipientCapInputSchema.parse("0.1GB");
      expect(result).toBe(Math.round(0.1 * 1024 * 1024 * 1024));
    });

    it('parses "1048576B" → 1048576 (raw bytes string, B unit, lower boundary)', () => {
      const result = recipientCapInputSchema.parse("1048576B");
      expect(result).toBe(1_048_576);
    });
  });

  describe("default unit and decimals", () => {
    it('parses "20" (no unit) → 20971520 (defaults to MB per implementation)', () => {
      const result = recipientCapInputSchema.parse("20");
      expect(result).toBe(20 * 1024 * 1024);
    });

    it('parses "1.5MB" → 1572864 (decimal path)', () => {
      const result = recipientCapInputSchema.parse("1.5MB");
      expect(result).toBe(Math.round(1.5 * 1024 * 1024));
      expect(Number.isInteger(result)).toBe(true);
    });
  });

  describe("exact boundary values", () => {
    it("accepts 1_048_576 (exact lower boundary, 1 MB)", () => {
      const result = recipientCapInputSchema.parse(1_048_576);
      expect(result).toBe(1_048_576);
    });

    it("rejects 1_048_575 (one byte below lower boundary)", () => {
      const result = recipientCapInputSchema.safeParse(1_048_575);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/below minimum|1 MB/i);
      }
    });

    it("accepts 209_715_200 (exact upper boundary, 200 MB)", () => {
      const result = recipientCapInputSchema.parse(209_715_200);
      expect(result).toBe(209_715_200);
    });

    it("rejects 209_715_201 (one byte above upper boundary)", () => {
      const result = recipientCapInputSchema.safeParse(209_715_201);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/exceeds maximum|200 MB/i);
      }
    });
  });

  describe("invalid numeric edge cases", () => {
    it("rejects integer 0 (positive-integer guard)", () => {
      const result = recipientCapInputSchema.safeParse(0);
      expect(result.success).toBe(false);
      if (!result.success) {
        // 0 hits the positive-integer guard before the bounds check
        expect(result.error.issues[0].message).toMatch(/positive integer|invalid size/i);
      }
    });

    it('rejects " " (whitespace-only string — trims to empty)', () => {
      const result = recipientCapInputSchema.safeParse(" ");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/empty string|invalid size/i);
      }
    });
  });
});
