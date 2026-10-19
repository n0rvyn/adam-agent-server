/**
 * Audio analysis for the Track B PostToolUse verifier (audioDurationMs / audioZeroCrossingRatePerS).
 * Reuses the ffprobe/ffmpeg-backed DSL handlers so there is one audio-analysis implementation.
 */

import { handlers } from "../validators/handlers.js";

/**
 * Returns the duration (ms) and zero-crossing rate (per second) of an audio file.
 * Throws (via the underlying handlers) if ffprobe/ffmpeg is unavailable or the file is unreadable;
 * the Track B hook treats a throw as a fail-closed internal error.
 */
export async function analyzeAudioFile(filePath: string): Promise<{ zcRatePerS: number; durationMs: number }> {
  const durationS = (await handlers["audio.duration_s"](filePath)) as number;
  const zcRatePerS = (await handlers["audio.zc_rate_per_s"](filePath)) as number;
  return { zcRatePerS, durationMs: Math.round(durationS * 1000) };
}
