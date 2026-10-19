import { listExpiredOpenPrompts, expirePendingPrompt } from "../store/pending-prompts.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("message-handler");

let _timer: ReturnType<typeof setInterval> | null = null;

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h

/**
 * Phase 5 cron sweep: marks pending_prompts rows whose expires_at < now as
 * expired (reason="timeout"). Runs every chat.promptExpiry.intervalMs (default 1h).
 *
 * D-P5-03: setInterval is used rather than BreeEngine because BreeEngine is
 * task_template-specific. See plan §Decisions.
 */
export function startPromptExpirySweep(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (_timer) return;
  _timer = setInterval(() => {
    sweepExpiredPrompts();
  }, intervalMs);
  log.info({ intervalMs }, "Prompt expiry sweep started");
}

export function stopPromptExpirySweep(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

export function sweepExpiredPrompts(): number {
  const now = Date.now();
  const expired = listExpiredOpenPrompts(now);
  for (const prompt of expired) {
    expirePendingPrompt(prompt.id, "timeout");
    log.debug({ promptId: prompt.id, expiresAt: prompt.expiresAt }, "Prompt expired by sweep");
  }
  return expired.length;
}
