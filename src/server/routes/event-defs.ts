import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import { v4 as uuidv4 } from "uuid";
import {
  createEventDef,
  getEventDef,
  listEventDefs,
  updateEventDef,
  deleteEventDef,
} from "../../store/event-defs.js";
import { queryEvents } from "../../store/events.js";
import { listDispatchesByEventDef } from "../../store/template-executions.js";
import { startEventDefSource, stopEventDefSource, fireManualEvent, fireTestEvent } from "../../events/sources/index.js";
import { getSourceTypeKeys, validateSourceConfig } from "../../events/sources/schemas.js";

// ---- Zod schemas ----

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const createEventDefSchema = z.object({
  name: z.string().min(1).max(100),
  sourceType: z.enum(getSourceTypeKeys() as [string, ...string[]]),
  sourceConfig: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional().default(true),
  description: z.string().max(500).optional(),
});

const updateEventDefSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  sourceType: z.enum(getSourceTypeKeys() as [string, ...string[]]).optional(),
  sourceConfig: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  description: z.string().max(500).optional(),
});

const fireManualSchema = z.object({
  payload: z.record(z.string(), z.unknown()).optional(),
});

// ---- Routes ----

export async function eventDefRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /event-defs
  fastify.get("/event-defs", async (request, reply) => {
    const { sourceType, enabled } = request.query as { sourceType?: string; enabled?: string };
    const defs = listEventDefs({
      sourceType: sourceType as "webhook" | "directory_watch" | "cron" | "manual" | undefined,
      enabled: enabled !== undefined ? enabled === "true" : undefined,
    });
    return reply.send(defs);
  });

  // POST /event-defs
  fastify.post("/event-defs", async (request, reply) => {
    const parsed = createEventDefSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "VALIDATION_ERROR",
        message: `Invalid event def: ${z.prettifyError(parsed.error)}`,
      });
    }
    const body = parsed.data;

    // Validate source config structure
    const configCheck = validateSourceConfig(body.sourceType, body.sourceConfig);
    if (!configCheck.ok) {
      const errMsg = configCheck.error;
      return reply.status(400).send({
        code: "VALIDATION_ERROR",
        message: `Invalid source config: ${errMsg}`,
      });
    }

    // Validate cron expression if cron type
    if (body.sourceType === "cron") {
      const { CronExpressionParser } = await import("cron-parser");
      try {
        CronExpressionParser.parse(body.sourceConfig["cron"] as string);
      } catch {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: `Invalid cron expression: ${body.sourceConfig["cron"]}`,
        });
      }
    }

    const def = createEventDef({
      id: uuidv4(),
      name: body.name,
      sourceType: body.sourceType as "webhook" | "manual" | "cron" | "directory_watch",
      sourceConfig: body.sourceConfig,
      enabled: body.enabled ?? true,
      description: body.description,
    });

    // Start the source handler (crash recovery: re-register on boot)
    startEventDefSource(def);

    return reply.status(201).send(def);
  });

  // GET /event-defs/:id
  fastify.get("/event-defs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID_REGEX.test(id)) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: "Invalid UUID" });
    }
    const def = getEventDef(id);
    if (!def) {
      return reply.status(404).send({ code: "NOT_FOUND", message: `Event def '${id}' not found` });
    }
    return reply.send(def);
  });

  // PATCH /event-defs/:id
  fastify.patch("/event-defs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID_REGEX.test(id)) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: "Invalid UUID" });
    }
    const existing = getEventDef(id);
    if (!existing) {
      return reply.status(404).send({ code: "NOT_FOUND", message: `Event def '${id}' not found` });
    }

    const parsed = updateEventDefSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "VALIDATION_ERROR",
        message: `Invalid update: ${z.prettifyError(parsed.error)}`,
      });
    }
    const body = parsed.data;

    // Validate source config if changing
    if (body.sourceType !== undefined || body.sourceConfig !== undefined) {
      const configCheck = validateSourceConfig(
        body.sourceType ?? existing.sourceType,
        body.sourceConfig ?? existing.sourceConfig,
      );
      if (!configCheck.ok) {
        const errMsg = configCheck.error;
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: `Invalid source config: ${errMsg}`,
        });
      }
    }

    // Handle enabled flip: stop/start source accordingly
    const enabledChanging = body.enabled !== undefined && body.enabled !== existing.enabled;
    if (enabledChanging && existing.enabled) {
      stopEventDefSource(id, existing.sourceType);
    }

    const updated = updateEventDef(id, {
      name: body.name,
      sourceType: body.sourceType as "webhook" | "manual" | "cron" | "directory_watch" | undefined,
      sourceConfig: body.sourceConfig,
      enabled: body.enabled,
      description: body.description,
    });

    if (enabledChanging && updated && updated.enabled) {
      startEventDefSource(updated);
    }

    return reply.send(updated);
  });

  // DELETE /event-defs/:id
  fastify.delete("/event-defs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID_REGEX.test(id)) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: "Invalid UUID" });
    }
    const existing = getEventDef(id);
    if (!existing) {
      return reply.status(404).send({ code: "NOT_FOUND", message: `Event def '${id}' not found` });
    }
    stopEventDefSource(id, existing.sourceType);
    deleteEventDef(id);
    return reply.status(204).send();
  });

  // POST /event-defs/:id/fire
  fastify.post("/event-defs/:id/fire", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID_REGEX.test(id)) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: "Invalid UUID" });
    }
    const def = getEventDef(id);
    if (!def) {
      return reply.status(404).send({ code: "NOT_FOUND", message: `Event def '${id}' not found` });
    }

    const { test } = request.query as { test?: string };
    const isTestMode = test === "true";

    // Non-manual defs require test mode
    if (def.sourceType !== "manual" && !isTestMode) {
      return reply.status(400).send({
        code: "WRONG_SOURCE",
        message: `Can only fire manual event defs directly; this def has source type '${def.sourceType}'. Use ?test=true to dry-run.`,
      });
    }

    const parsed = fireManualSchema.safeParse(request.body);
    const payload = parsed.success ? parsed.data.payload : undefined;
    try {
      const result = isTestMode
        ? fireTestEvent(def, payload)
        : fireManualEvent(def, payload);
      return reply.status(201).send({ event_id: result.eventId, test: isTestMode });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ code: "ERROR", message });
    }
  });

  // GET /event-defs/:id/firings
  fastify.get("/event-defs/:id/firings", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID_REGEX.test(id)) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: "Invalid UUID" });
    }
    const def = getEventDef(id);
    if (!def) {
      return reply.status(404).send({ code: "NOT_FOUND", message: `Event def '${id}' not found` });
    }
    const { since, limit } = request.query as { since?: string; limit?: string };
    const events = queryEvents({
      eventDefId: id,
      since: since ?? undefined,
      limit: limit ? Math.min(parseInt(limit, 10), 500) : 50,
    });
    return reply.send(events);
  });

  // GET /event-defs/:id/dispatches: list template executions triggered by this event def
  fastify.get("/event-defs/:id/dispatches", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID_REGEX.test(id)) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: "Invalid UUID" });
    }
    const def = getEventDef(id);
    if (!def) {
      return reply.status(404).send({ code: "NOT_FOUND", message: `Event def '${id}' not found` });
    }
    const { limit, offset } = request.query as { limit?: string; offset?: string };
    const dispatches = listDispatchesByEventDef(
      id,
      limit ? Math.min(parseInt(limit, 10), 200) : 20,
      offset ? Math.max(parseInt(offset, 10), 0) : 0,
    );
    return reply.send(dispatches);
  });
}
