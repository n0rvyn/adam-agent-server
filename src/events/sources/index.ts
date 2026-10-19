import { startCronSource, stopCronSource } from "./cron.js";
import { startDirectoryWatch, stopDirectoryWatch } from "./directory-watch.js";
import { fireManualEvent, fireTestEvent } from "./manual.js";
import { listEventDefs } from "../../store/event-defs.js";
import type { EventDef } from "../../shared/types.js";
import { getLogger } from "../../lib/logger.js";

const log = getLogger("scheduler");

/**
 * Start an event source handler based on the def's sourceType.
 * - "webhook": no-op here (HTTP handler always registered via webhookEventRoutes)
 * - "manual": no-op here (invoked on demand via fireManualEvent)
 * - "cron" / "directory_watch": start the active handler
 */
export function startEventDefSource(def: EventDef): void {
  if (!def.enabled) return;
  switch (def.sourceType) {
    case "cron":
      startCronSource(def);
      break;
    case "directory_watch":
      startDirectoryWatch(def);
      break;
    case "webhook":
      // HTTP handler registered via webhookEventRoutes — nothing to start
      break;
    case "manual":
      // Invoked on demand — nothing to pre-register
      break;
    default:
      log.warn({ defId: def.id, sourceType: def.sourceType }, "Unknown source type, skipping");
  }
}

/**
 * Stop an event source handler by id and source type.
 */
export function stopEventDefSource(defId: string, sourceType: EventDef["sourceType"]): void {
  switch (sourceType) {
    case "cron":
      stopCronSource(defId);
      break;
    case "directory_watch":
      stopDirectoryWatch(defId);
      break;
    case "webhook":
    case "manual":
      // No active handler to tear down
      break;
    default:
      log.warn({ defId, sourceType }, "Unknown source type, nothing to stop");
  }
}

/**
 * Stop all active event source handlers (cron timers + fswatch watchers).
 * Called during shutdown and when restarting sources.
 */
export async function stopAllEventDefSources(): Promise<void> {
  const defs = listEventDefs({});
  for (const def of defs) {
    if (def.enabled) {
      stopEventDefSource(def.id, def.sourceType);
    }
  }
  log.info("All event source handlers stopped");
}

export { fireManualEvent, fireTestEvent };
