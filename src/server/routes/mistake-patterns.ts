import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import {
  createMistakePattern,
  listMistakePatterns,
  getMistakePattern,
  updateMistakePatternStatus,
} from "../../store/mistake-patterns.js";
import type { MistakePatternStatus } from "../../shared/types.js";

const statusUpdateSchema = z.object({
  status: z.enum(["new", "acknowledged", "dismissed"]),
});

/** Plain JSON-Schema equivalent for Fastify (zod/v4 body schema incompatible with Fastify 5). */
const statusUpdateJsonSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["new", "acknowledged", "dismissed"] },
  },
  required: ["status"],
};

export async function mistakePatternsRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /mistake-patterns — list all mistake patterns with optional status filter
  fastify.get(
    "/mistake-patterns",
    {
      schema: {
        tags: ["Mistake Patterns"],
        summary: "List mistake patterns",
        description: "Returns mistake patterns ordered by last_seen DESC with pagination.",
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["new", "acknowledged", "dismissed"] },
            limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Querystring?: { status?: string; limit?: number; offset?: number };
      }>,
    ) => {
      const { status, limit = 100, offset = 0 } = request.query ?? {};
      const patterns = listMistakePatterns(
        status as MistakePatternStatus | undefined,
        limit,
        offset,
      );
      return { mistakePatterns: patterns };
    },
  );

  // GET /mistake-patterns/:id — get a single mistake pattern
  fastify.get(
    "/mistake-patterns/:id",
    {
      schema: {
        tags: ["Mistake Patterns"],
        summary: "Get a mistake pattern by ID",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const pattern = getMistakePattern(request.params.id);
      if (!pattern) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Mistake pattern not found" });
      }
      return { mistakePattern: pattern };
    },
  );

  // PATCH /mistake-patterns/:id — update status (DP-4.11: body-based, not subpath)
  fastify.patch(
    "/mistake-patterns/:id",
    {
      schema: {
        tags: ["Mistake Patterns"],
        summary: "Update mistake pattern status",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: statusUpdateJsonSchema,
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: z.infer<typeof statusUpdateSchema>;
      }>,
      reply: FastifyReply,
    ) => {
      const parseResult = statusUpdateSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(parseResult.error),
        });
      }
      const existing = getMistakePattern(request.params.id);
      if (!existing) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Mistake pattern not found" });
      }
      updateMistakePatternStatus(request.params.id, parseResult.data.status);
      return { ok: true, id: request.params.id, status: parseResult.data.status };
    },
  );
}
