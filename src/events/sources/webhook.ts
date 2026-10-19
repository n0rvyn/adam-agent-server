import { z } from "zod/v4";
import { publishEvent } from "../../lib/event-publish.js";
import { sanitizeSignal } from "../../security/signal-sanitizer.js";
import { getLogger } from "../../lib/logger.js";
import type { EventDef } from "../../shared/types.js";

const log = getLogger("scheduler");

/** Zod envelope schema for incoming webhook event payloads (Threat Model §4). */
export const WebhookEventEnvelopeSchema = z.object({
  /** Event type string — alphanumeric with dots/underscores, max 100 chars. */
  type: z.string().regex(/^[a-z0-9._]+$/, "type must be lowercase alphanumeric with dots or underscores").max(100),
  /** Arbitrary event payload. */
  payload: z.record(z.string(), z.unknown()),
  /** Deduplication key — unique per source, max 200 chars. */
  dedup_key: z.string().max(200),
  /** ISO 8601 timestamp of when the event occurred (defaults to server receive time). */
  occurred_at: z.string().datetime().optional(),
  /** Schema version for future compatibility. */
  schema_version: z.number().int().positive().optional(),
  /** Override default confidence (defaults to 1.0). */
  confidence: z.number().min(0).max(1).optional(),
});

export type WebhookEventEnvelope = z.infer<typeof WebhookEventEnvelopeSchema>;

/**
 * Fire an event from a webhook source.
 * Returns whether the event was inserted (vs deduplicated).
 */
export function fireWebhookEvent(
  def: EventDef,
  body: unknown,
): { duplicate: boolean; eventId: string; sanitized: boolean } {
  const parsed = WebhookEventEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`Invalid webhook envelope: ${z.prettifyError(parsed.error)}`);
  }

  const envelope = parsed.data;
  const now = new Date().toISOString();

  // S5-B: scan payload for prompt injection patterns
  const sanitizerResult = sanitizeSignal(envelope.payload, `webhook-${def.id}`);
  if (sanitizerResult.suspicious) {
    log.warn(
      { defId: def.id, defName: def.name, flags: sanitizerResult.flags.map((f) => ({ p: f.pattern, loc: f.location })) },
      "Webhook payload flagged by sanitizer; downgrading trust_level to untrusted",
    );
  }

  const result = publishEvent({
    eventDefId: def.id,
    type: envelope.type,
    source: `webhook-${def.id}`,
    dedupKey: envelope.dedup_key,
    payload: envelope.payload,
    occurredAt: envelope.occurred_at ?? now,
    confidence: envelope.confidence,
    trustLevel: sanitizerResult.recommendedTrustLevel,
  });

  return { duplicate: !result.inserted, eventId: result.id, sanitized: sanitizerResult.suspicious };
}
