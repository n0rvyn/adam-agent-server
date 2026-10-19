import { getRuntimeConfig } from "../config/runtime.js";

function getTimezone(): string | undefined {
  try {
    const tz = getRuntimeConfig().server?.timezone;
    return tz === "system" || !tz ? undefined : tz;
  } catch { return undefined; }
}

/** Format epoch ms to localized datetime string using configured timezone. */
export function formatLocalTime(epochMs: number): string {
  const tz = getTimezone();
  return new Date(epochMs).toLocaleString(undefined, tz ? { timeZone: tz } : undefined);
}

/** Format epoch ms to time-only string using configured timezone. */
export function formatLocalTimeOnly(epochMs: number): string {
  const tz = getTimezone();
  return new Date(epochMs).toLocaleTimeString(undefined, tz ? { timeZone: tz } : undefined);
}

/** Get start-of-day (midnight) as epoch ms in the configured timezone. */
export function getStartOfDayMs(tzOverride?: string): number {
  const tz = tzOverride ?? getTimezone();
  const now = new Date();
  // Get today's date string in the target timezone (YYYY-MM-DD)
  const dateStr = now.toLocaleDateString("en-CA", tz ? { timeZone: tz } : undefined);
  if (tz) {
    // Parse timezone offset to compute midnight in UTC terms
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" });
    const parts = formatter.formatToParts(now);
    const tzPart = parts.find(p => p.type === "timeZoneName")?.value ?? "";
    const match = tzPart.match(/GMT([+-]?)(\d+)(?::(\d+))?/);
    if (match) {
      const sign = match[1] === "-" ? -1 : 1;
      const hours = parseInt(match[2], 10);
      const minutes = parseInt(match[3] ?? "0", 10);
      const offsetMs = sign * (hours * 60 + minutes) * 60_000;
      return new Date(`${dateStr}T00:00:00Z`).getTime() - offsetMs;
    }
  }
  // Fallback: system timezone
  return new Date(`${dateStr}T00:00:00`).getTime();
}
