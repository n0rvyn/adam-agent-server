import { CronExpressionParser } from "cron-parser";
import { v4 as uuidv4 } from "uuid";
import { publishEvent } from "../../lib/event-publish.js";
import { getLogger } from "../../lib/logger.js";
import type { EventDef } from "../../shared/types.js";

const log = getLogger("scheduler");

/** Module-level map of active cron timer handles, keyed by def.id. */
const cronTimers = new Map<string, NodeJS.Timeout>();

/**
 * Schedule the next fire for a cron event source.
 * @param cronExpr  A cron-parser iterator. The iterator's internal cursor must be positioned
 *                  at the desired next occurrence (i.e., .next() has not been called since
 *                  the last fire).
 */
function scheduleNextFire(def: EventDef, cronExpr: ReturnType<typeof CronExpressionParser.parse>): void {
  // Advance to the next occurrence (this is the only place .next() is called per cycle).
  const next = cronExpr.next();
  const delay = Math.max(next.getTime() - Date.now(), 1000);
  const timer = setTimeout(async () => {
    try {
      const eventId = uuidv4();
      const payload_template = (def.sourceConfig["payload_template"] as Record<string, unknown> | undefined) ?? {};
      const payload = { triggered_at: new Date().toISOString(), ...payload_template };
      publishEvent({
        id: eventId,
        eventDefId: def.id,
        type: "scheduler.tick",
        source: "adam-internal",
        dedupKey: `cron-${def.id}-${Date.now()}`,
        payload,
        occurredAt: new Date().toISOString(),
        trustLevel: "trusted",
      });
    } catch (err) {
      log.error({ defId: def.id, err }, "cron handler failed");
    }
    // Re-arm for next occurrence — stopCronSource may have cleared the map entry.
    if (cronTimers.has(def.id)) {
      scheduleNextFire(def, cronExpr);
    }
  }, delay);
  cronTimers.set(def.id, timer);
}

/**
 * Start a cron event source for a given event def.
 * Throws if the cron expression in sourceConfig.cron is invalid.
 */
export function startCronSource(def: EventDef): void {
  if (!def.enabled) return;
  const cronExpr = CronExpressionParser.parse(def.sourceConfig["cron"] as string);
  scheduleNextFire(def, cronExpr);
  log.info({ defId: def.id, defName: def.name }, "Cron source started");
}

/**
 * Stop and clear the cron timer for a given def id.
 */
export function stopCronSource(defId: string): void {
  const timer = cronTimers.get(defId);
  if (timer) {
    clearTimeout(timer);
    cronTimers.delete(defId);
  }
}
