import { v4 as uuidv4 } from "uuid";
import { publishEvent } from "../../lib/event-publish.js";
import type { EventDef } from "../../shared/types.js";

/**
 * Fire a manual event for a given event def.
 * Returns the created event id.
 */
export function fireManualEvent(
  def: EventDef,
  payload?: Record<string, unknown>,
): { eventId: string } {
  if (!def.enabled) {
    throw new Error(`Event def '${def.id}' is disabled`);
  }
  const eventId = uuidv4();
  publishEvent({
    id: eventId,
    eventDefId: def.id,
    type: "manual.fire",
    source: "manual",
    dedupKey: `manual-${def.id}-${Date.now()}`,
    payload: payload ?? {},
    occurredAt: new Date().toISOString(),
    trustLevel: "trusted",
  });
  return { eventId };
}

/**
 * Fire a TEST event for any event def regardless of source type.
 * Uses a distinct source prefix (`manual-test-<defId>`) so dedup does not collide
 * with real firings on the same def. Intended for debugging / ChatManager-driven
 * dry-runs via the `?test=true` flag or the `fire_event_def` adam-tool.
 */
export function fireTestEvent(
  def: EventDef,
  payload?: Record<string, unknown>,
): { eventId: string } {
  // Enabled check intentionally omitted — test mode should work on disabled defs so
  // users can validate a def before flipping enabled=true.
  const eventId = uuidv4();
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 10);
  publishEvent({
    id: eventId,
    eventDefId: def.id,
    type: "manual.test.fire",
    source: `manual-test-${def.id}`,
    dedupKey: `manual-test-${def.id}-${timestamp}-${random}`,
    payload: payload ?? {},
    occurredAt: new Date().toISOString(),
    trustLevel: "trusted",
  });
  return { eventId };
}
