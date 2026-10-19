import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import { getEventDef } from "../../store/event-defs.js";
import { fireWebhookEvent } from "../../events/sources/webhook.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const paramsSchema = z.object({
  event_def_id: z.string().regex(UUID_REGEX, "must be a valid UUID v4"),
});

/**
 * POST /webhooks/events/:event_def_id — ingest an event from an external webhook.
 * Security: API key via x-api-key header (Threat Model §1).
 */
export async function webhookEventRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    "/webhooks/events/:event_def_id",
    {
      schema: {
        tags: ["Webhooks", "Events"],
        summary: "Fire an event via webhook",
        description: "Ingest an event from an external system. Returns 200 with duplicate=true if the event was already received (dedup key match).",
        params: {
          type: "object",
          required: ["event_def_id"],
          properties: {
            event_def_id: { type: "string", format: "uuid", description: "Event definition ID" },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const paramsResult = paramsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: `Invalid event_def_id: ${z.prettifyError(paramsResult.error)}`,
        });
      }

      const { event_def_id } = paramsResult.data;

      const def = getEventDef(event_def_id);
      if (!def || !def.enabled) {
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: `Event def '${event_def_id}' not found or disabled`,
        });
      }

      if (def.sourceType !== "webhook") {
        return reply.status(400).send({
          code: "WRONG_SOURCE",
          message: `Event def '${event_def_id}' has source type '${def.sourceType}', not 'webhook'`,
        });
      }

      try {
        const result = fireWebhookEvent(def, request.body);
        const status = result.duplicate ? 200 : 201;
        return reply.status(status).send({
          ok: true,
          event_id: result.eventId,
          duplicate: result.duplicate,
          sanitized: result.sanitized,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ code: "INVALID_ENVELOPE", message });
      }
    },
  );
}
