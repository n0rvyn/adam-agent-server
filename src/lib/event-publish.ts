/**
 * Central event publish helper — the single path from an event source to the
 * dispatcher bus. Every source (directory-watch, cron, manual, webhook, future
 * sources) MUST route through `publishEvent` instead of calling `createEvent`
 * and `serverBus.emit` separately.
 *
 * Guarantees:
 *   1. DB-level dedup via `createEvent` (INSERT OR IGNORE on source+dedup_key)
 *   2. `event_fired` is emitted ONLY when `createEvent` actually inserted a
 *      new row. Duplicate inserts → no emit → no downstream dispatch.
 *
 * Defense-in-depth LRU dedup in `src/events/dispatcher.ts` catches the narrow
 * case where a source accidentally calls publishEvent twice with the same
 * final eventId across a DB reset boundary.
 */

import { createEvent, type CreateEventInput } from "../store/events.js";
import { serverBus } from "../server/events/server-bus.js";

export interface PublishEventInput extends CreateEventInput {
  /** Optional payload override for the `event_fired` emission. Defaults to `input.payload`. */
  emitPayload?: Record<string, unknown>;
}

export interface PublishEventResult {
  /** True if the event was a fresh insert and `event_fired` was emitted. False if DB dedup'd it. */
  inserted: boolean;
  /** Canonical event id (existing row's id on dedup, or the freshly-inserted id). */
  id: string;
}

export function publishEvent(input: PublishEventInput): PublishEventResult {
  const { emitPayload, ...createInput } = input;
  const result = createEvent(createInput);

  if (!result.inserted) {
    return { inserted: false, id: result.id };
  }

  if (input.eventDefId) {
    serverBus.emit({
      type: "event_fired",
      eventDefId: input.eventDefId,
      eventId: result.id,
      payload: emitPayload ?? input.payload,
    });
  }

  return { inserted: true, id: result.id };
}
