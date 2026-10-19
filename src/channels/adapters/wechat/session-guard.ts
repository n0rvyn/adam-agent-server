/**
 * Session guard: handles errcode=-14 (session expired) by pausing all inbound/outbound
 * API calls for one hour, then resuming automatically.
 * Extracted from @tencent-weixin/openclaw-weixin@2.1.1.
 */
import { getLogger } from "../../../lib/logger.js";

const log = getLogger("channels");

/** Error code returned by the server when the bot session has expired. */
export const SESSION_EXPIRED_ERRCODE = -14;

/** Pause duration: 1 hour in milliseconds. */
export const SESSION_PAUSE_DURATION_MS = 60 * 60 * 1000;

// In-memory pause state keyed by channelId
const pauseUntilMap = new Map<string, number>();

/**
 * Pause all inbound/outbound API calls for `channelId` for SESSION_PAUSE_DURATION_MS.
 * Called when the server returns errcode=-14.
 */
export function pauseSession(channelId: string): void {
  const until = Date.now() + SESSION_PAUSE_DURATION_MS;
  pauseUntilMap.set(channelId, until);
  log.info(
    { channelId },
    `Session paused until ${new Date(until).toISOString()} (${SESSION_PAUSE_DURATION_MS / 1000}s)`,
  );
}

/**
 * Returns `true` when the channel is still within its pause window.
 * Auto-cleans expired entries.
 */
export function isSessionPaused(channelId: string): boolean {
  const until = pauseUntilMap.get(channelId);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    pauseUntilMap.delete(channelId);
    return false;
  }
  return true;
}

/**
 * Milliseconds remaining until the pause expires (0 when not paused).
 * Auto-cleans expired entries.
 */
export function getRemainingPauseMs(channelId: string): number {
  const until = pauseUntilMap.get(channelId);
  if (until === undefined) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    pauseUntilMap.delete(channelId);
    return 0;
  }
  return remaining;
}

/**
 * Clear any active pause for `channelId` (e.g. after manual reconnect).
 */
export function clearSessionPause(channelId: string): void {
  pauseUntilMap.delete(channelId);
}

/**
 * Reset internal state — only for tests.
 * @internal
 */
export function _resetForTest(): void {
  pauseUntilMap.clear();
}
