import { serverBus } from "../server/events/server-bus.js";
import { listTaskTemplates } from "../store/task-templates.js";
import { dispatchTemplate } from "../scheduler/template-dispatch.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("event-dispatcher");
let started = false;

/**
 * Defense-in-depth eventId dedup for the dispatcher.
 *
 * Primary dedup is DB-level in `publishEvent` / `createEvent` via
 * INSERT OR IGNORE on (source, dedup_key). This LRU guards the narrow case
 * where the same event_fired emission reaches the dispatcher twice
 * (e.g. re-emit bug, test harness double-firing), preventing duplicate
 * duplicate template dispatches for the same logical event.
 *
 * 10k entries keeps memory bounded. 5-min TTL covers realistic event
 * bursts without suppressing legitimate long-tail events.
 */
const DISPATCHER_LRU_MAX = 10_000;
const DISPATCHER_LRU_TTL_MS = 5 * 60 * 1000;

const seenEventIds = new Map<string, number>(); // eventId -> expiresAt

function markSeen(eventId: string): boolean {
  const now = Date.now();
  const expiresAt = seenEventIds.get(eventId);
  if (expiresAt !== undefined && expiresAt > now) {
    return false; // already seen
  }
  // Opportunistic eviction: drop expired entries when we hit capacity.
  if (seenEventIds.size >= DISPATCHER_LRU_MAX) {
    for (const [id, exp] of seenEventIds) {
      if (exp <= now) seenEventIds.delete(id);
      if (seenEventIds.size < DISPATCHER_LRU_MAX) break;
    }
    // If still at capacity after TTL sweep, drop oldest insertion (Map preserves order).
    if (seenEventIds.size >= DISPATCHER_LRU_MAX) {
      const oldestKey = seenEventIds.keys().next().value;
      if (oldestKey !== undefined) seenEventIds.delete(oldestKey);
    }
  }
  seenEventIds.set(eventId, now + DISPATCHER_LRU_TTL_MS);
  return true;
}

/** Exported for tests. */
export function _resetDispatcherLru(): void {
  seenEventIds.clear();
}

export function startEventDispatcher(): void {
  if (started) return;
  serverBus.on("event_fired", async ({ eventDefId, eventId, payload }) => {
    if (!markSeen(eventId)) {
      log.debug({ eventDefId, eventId }, "event_fired: duplicate suppressed by LRU");
      return;
    }
    const templates = listTaskTemplates(true).filter(
      (t) => t.trigger.type === "event" && t.trigger.eventDefId === eventDefId,
    );
    if (templates.length === 0) {
      log.debug({ eventDefId, eventId }, "event_fired: no matching templates");
      return;
    }
    log.info({ eventDefId, eventId, matchedCount: templates.length }, "event_fired: dispatching templates");
    for (const tmpl of templates) {
      dispatchTemplate(tmpl, { triggerContext: { eventId, payload } }).catch((err) => {
        log.error({ templateId: tmpl.id, eventId, error: err }, "template dispatch failed");
      });
    }
  });
  started = true;
  log.info("EventDispatcher started");
}
