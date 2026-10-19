import { z } from "zod/v4";
import { MIN_REASONABLE_CAP_BYTES, MAX_REASONABLE_CAP_BYTES } from "./recipient-cap-bounds.js";

// Matches: optional whitespace, a number (possibly with decimal), optional whitespace, optional unit, optional whitespace
// Units: B, K/KB, M/MB, G/GB (case-insensitive)
const SIZE_REGEX = /^\s*(\d+(?:\.\d+)?)\s*(B|KB?|MB?|GB?)?\s*$/i;

const UNIT_MULTIPLIERS: Record<string, number> = {
  B: 1,
  K: 1024,
  KB: 1024,
  M: 1024 * 1024,
  MB: 1024 * 1024,
  G: 1024 * 1024 * 1024,
  GB: 1024 * 1024 * 1024,
};

function parseHumanSize(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) throw new Error(`Invalid size: empty string`);
  const match = trimmed.match(SIZE_REGEX);
  if (!match) throw new Error(`Invalid size: "${input}" — accepts integers (bytes) or strings like "35MB", "1KB", "1.5GB"`);
  const num = parseFloat(match[1]);
  const unit = (match[2] ?? "MB").toUpperCase();
  if (!(unit in UNIT_MULTIPLIERS)) throw new Error(`Invalid unit: "${match[2]}"`);
  return Math.round(num * UNIT_MULTIPLIERS[unit]);
}

export const recipientCapInputSchema = z.union([z.number().int(), z.string()])
  .transform((val, ctx) => {
    try {
      const bytes = typeof val === "number" ? val : parseHumanSize(val);
      if (!Number.isInteger(bytes) || bytes <= 0) {
        ctx.addIssue({ code: "custom", message: `Invalid size: must be a positive integer` });
        return z.NEVER;
      }
      return bytes;
    } catch (err) {
      ctx.addIssue({ code: "custom", message: err instanceof Error ? err.message : String(err) });
      return z.NEVER;
    }
  })
  .refine(
    (bytes) => bytes >= MIN_REASONABLE_CAP_BYTES,
    { message: `Size below minimum (${MIN_REASONABLE_CAP_BYTES} bytes = 1 MB)` },
  )
  .refine(
    (bytes) => bytes <= MAX_REASONABLE_CAP_BYTES,
    { message: `Size exceeds maximum (${MAX_REASONABLE_CAP_BYTES} bytes = 200 MB)` },
  );
