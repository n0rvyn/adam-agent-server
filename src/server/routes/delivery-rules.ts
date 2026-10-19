import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import {
  createDeliveryRule,
  getDeliveryRule,
  listDeliveryRules,
  updateDeliveryRule,
  deleteDeliveryRule,
} from "../../store/delivery-rules.js";
import { getDeliveryLogByRule } from "../../store/delivery-log.js";
import type { DeliveryRule, DeliveryEventType } from "../../shared/types.js";

const ruleBodySchema = z.object({
  eventType: z.enum(["task_complete", "task_error", "plan_approval_request", "*"]),
  matchCriteria: z.object({
    templateId: z.string().optional(),
    roleId: z.string().optional(),
    promptPattern: z.string().max(500).optional(),
    excludePromptPatterns: z.array(z.string().max(200)).max(20).optional(),
    taskStatus: z.string().optional(),
  }).optional().default({}),
  target: z.object({
    type: z.enum(["channel", "webhook"]),
    channelId: z.string().optional(),
    chatId: z.string().optional(),
    webhookUrl: z.string().optional(),
  }),
  formatTemplate: z.string().optional(),
  maxPerMinute: z.number().int().min(1).max(60).optional().default(5),
  skipOriginChannel: z.boolean().optional().default(true),
  enabled: z.boolean().optional().default(true),
});

export default async function deliveryRulesRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /delivery-rules
  fastify.get("/delivery-rules", async (_request: FastifyRequest, _reply: FastifyReply) => {
    return listDeliveryRules();
  });

  // POST /delivery-rules
  fastify.post("/delivery-rules", async (request: FastifyRequest, reply: FastifyReply) => {
    const parse = ruleBodySchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parse.error) });
    }

    const data = parse.data;
    const rule: DeliveryRule = {
      id: uuidv4(),
      eventType: data.eventType as DeliveryEventType,
      matchCriteria: data.matchCriteria,
      target: data.target,
      formatTemplate: data.formatTemplate,
      maxPerMinute: data.maxPerMinute,
      skipOriginChannel: data.skipOriginChannel,
      enabled: data.enabled,
      createdAt: Date.now(),
    };

    createDeliveryRule(rule);
    return reply.status(201).send(rule);
  });

  // PUT /delivery-rules/:id
  fastify.put(
    "/delivery-rules/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const existing = getDeliveryRule(request.params.id);
      if (!existing) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Delivery rule not found" });
      }

      const updates = request.body as Partial<DeliveryRule>;
      updateDeliveryRule(request.params.id, updates);
      return { id: request.params.id, updated: true };
    },
  );

  // DELETE /delivery-rules/:id
  fastify.delete(
    "/delivery-rules/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const existing = getDeliveryRule(request.params.id);
      if (!existing) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Delivery rule not found" });
      }

      deleteDeliveryRule(request.params.id);
      return { id: request.params.id, deleted: true };
    },
  );

  // GET /delivery-rules/:id/log
  fastify.get(
    "/delivery-rules/:id/log",
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      return getDeliveryLogByRule(request.params.id);
    },
  );

  // POST /delivery-rules/:id/test — manual test delivery
  fastify.post(
    "/delivery-rules/:id/test",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const rule = getDeliveryRule(request.params.id);
      if (!rule) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Delivery rule not found" });
      }

      const { getDeliveryEngine } = await import("../../delivery/engine.js");
      const engine = getDeliveryEngine();
      if (!engine) {
        return reply.status(503).send({ code: "ENGINE_NOT_READY", message: "DeliveryEngine not initialized" });
      }

      const testContent = `[TEST] Delivery rule test at ${new Date().toISOString()}`;
      const { createDeliveryLog: createLog } = await import("../../store/delivery-log.js");
      const { v4: uuid } = await import("uuid");
      const { TTL_MS } = await import("../../store/delivery-log.js");

      const logEntry = {
        id: uuid(),
        ruleId: rule.id,
        status: "pending" as const,
        target: rule.target,
        content: testContent,
        attempts: 0,
        createdAt: Date.now(),
        expiresAt: Date.now() + TTL_MS,
      };
      createLog(logEntry);

      // Attempt delivery via engine's public method
      try {
        await engine.attemptDeliveryPublic(logEntry, rule);
        return { id: logEntry.id, ruleId: rule.id, status: "sent", content: testContent };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ code: "DELIVERY_FAILED", message: errorMsg, logId: logEntry.id });
      }
    },
  );
}
