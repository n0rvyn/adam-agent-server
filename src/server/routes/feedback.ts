import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import { recordUserFeedback } from "../../store/user-feedback.js";

const feedbackBodySchema = z.object({
  rating: z.enum(["good", "bad"]),
  stepId: z.string().optional(),
});

export async function feedbackRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /executions/:executionId/feedback
  fastify.post(
    "/executions/:executionId/feedback",
    {
      schema: {
        tags: ["Feedback"],
        summary: "Record user feedback for an execution",
        description: "Record a good/bad rating for a TemplateExecution, optionally for a specific step. The rating is stored and attributed to the active challenger belief with high weight.",
        params: {
          type: "object",
          required: ["executionId"],
          properties: {
            executionId: { type: "string" },
          },
        },
        body: {
          type: "object",
          required: ["rating"],
          properties: {
            rating: { type: "string", enum: ["good", "bad"] },
            stepId: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { executionId: string }; Body: unknown }>,
      reply: FastifyReply,
    ) => {
      const parseResult = feedbackBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: "Invalid body", details: parseResult.error.issues });
      }
      const { rating, stepId } = parseResult.data;
      const { executionId } = request.params;

      recordUserFeedback({ executionId, stepId, rating });

      return reply.send({ ok: true });
    },
  );
}
