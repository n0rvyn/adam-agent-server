/**
 * Publish-time freshness guard for TemplateExecution file deliverables.
 *
 * A step's published file must be PRODUCED during the execution that publishes it. The failure this
 * guards against: a fixed-name file (e.g. `audio.mp3`) left in a role's persistent workspace by a
 * prior run gets republished when the current run's producer fails — shipping a stale, wrong-day
 * deliverable (2026-06-03 podcast: 5/28 audio shipped as 6/3's).
 *
 * birthtime (file creation) is the load-bearing signal: a copy/touch/in-place re-open bumps mtime
 * but not birthtime, so a stale file re-touched at publish time still reports its original (old)
 * birthtime. We take the earliest of birthtime/mtime as the conservative "first existed" time.
 * A birthtimeMs of 0 (filesystems that don't record it) falls back to mtimeMs.
 *
 * Producers must write each run's output as a fresh file (new inode → fresh birthtime); the
 * tts merge step does this via temp-write + atomic rename. Without that, an in-place overwrite
 * would keep the old birthtime and this guard would (correctly, given the signal) flag fresh
 * content — which is why the producer fix and this guard ship together.
 */

/** Default clock-skew tolerance so a deliverable produced moments around execution start is not flagged. */
export const PUBLISH_FRESHNESS_SKEW_MS = 5 * 60 * 1000;

export interface FreshnessStat {
  birthtimeMs: number;
  mtimeMs: number;
}

/**
 * Returns whether `stat` describes a file that predates the execution (stale leftover), plus the
 * computed file time used for the decision (for logging / error messages).
 */
export function isStalePublish(
  stat: FreshnessStat,
  executionStartedAt: number,
  skewMs: number = PUBLISH_FRESHNESS_SKEW_MS,
): { stale: boolean; fileTimeMs: number } {
  const birthMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
  const fileTimeMs = Math.min(birthMs, stat.mtimeMs);
  return { stale: fileTimeMs < executionStartedAt - skewMs, fileTimeMs };
}
