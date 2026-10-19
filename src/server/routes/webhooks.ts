import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import { getTaskTemplate } from "../../store/task-templates.js";
import type { BreeEngine } from "../../scheduler/bree-engine.js";
import { responses } from "../response-schemas.js";

const paramsSchema = z.object({
  name: z.string().min(1),
});

/**
 * Webhook routes — allow external systems to trigger PKOS task templates.
 * Security: API key in X-API-Key header, validated by the global onRequest hook
 * (src/server/app.ts). No route-level auth check needed.
 */
export async function webhookRoutes(
  fastify: FastifyInstance,
  breeEngine: BreeEngine,
): Promise<void> {
  // POST /webhooks/:name — trigger a task template by name or ID
  fastify.post(
    "/webhooks/:name",
    {
      schema: {
        tags: ["Webhooks"],
        summary: "Trigger a webhook",
        description: "Trigger a task template execution by name or ID. Requires X-API-Key header.",
        security: [{ apiKey: [] }],
        params: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", description: "Template name or ID" },
          },
        },
        response: responses.webhookTriggered,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = paramsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply
          .status(400)
          .send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }

      const { name } = parseResult.data;

      // Find template by ID first, then by name
      let template = getTaskTemplate(name);
      if (!template) {
        // Search by name — list all templates and find matching name
        const { listTaskTemplates } = await import("../../store/task-templates.js");
        const allTemplates = listTaskTemplates(false);
        template = allTemplates.find((t) => t.name === name || t.id === name);
      }

      if (!template) {
        return reply
          .status(404)
          .send({ code: "NOT_FOUND", message: `Template '${name}' not found` });
      }

      if (!template.enabled) {
        return reply
          .status(409)
          .send({ code: "DISABLED", message: `Template '${name}' is disabled` });
      }

      // Trigger the template
      try {
        const executionId = await breeEngine.runNow(template.id);
        return reply.status(202).send({
          code: "ACCEPTED",
          message: `Template '${template.name}' triggered`,
          executionId,
          templateId: template.id,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply
          .status(500)
          .send({ code: "EXECUTION_ERROR", message });
      }
    },
  );

  // GET /webhooks — list available webhook endpoints
  fastify.get("/webhooks", {
    schema: {
      tags: ["Webhooks"],
      summary: "List available webhooks",
      description: "List all enabled task templates that can be triggered via webhook, along with auth requirements.",
      response: responses.webhookList,
    },
  }, async () => {
    const { listTaskTemplates } = await import("../../store/task-templates.js");
    const templates = listTaskTemplates(true); // enabled only
    return {
      webhooks: templates.map((t) => ({
        name: t.id,
        displayName: t.name,
        description: t.description,
        tags: t.tags,
        trigger: `POST /webhooks/${t.id}`,
      })),
      auth: "X-API-Key header required",
    };
  });
}
