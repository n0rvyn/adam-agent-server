import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import {
  createFeatureRequest,
  listFeatureRequests,
  getFeatureRequest,
  updateFeatureRequestStatus,
  type FeatureRequestStatus,
} from "../../store/feature-requests.js";

const featureRequestBodySchema = z.object({
  sourceSessionId: z.string().optional(),
  sourceMessageId: z.string().optional(),
  extractedByRoleId: z.string().optional(),
  content: z.string().min(1).max(5000),
  summary: z.string().max(500).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
  evidenceQuote: z.string().max(1000).optional(),
});

/** Plain JSON-Schema equivalent for Fastify (zod/v4 body schema is incompatible with Fastify 5). */
const featureRequestBodyJsonSchema = {
  type: "object",
  properties: {
    sourceSessionId: { type: "string" },
    sourceMessageId: { type: "string" },
    extractedByRoleId: { type: "string" },
    content: { type: "string", minLength: 1, maxLength: 5000 },
    summary: { type: "string", maxLength: 500 },
    tags: { type: "array", items: { type: "string", maxLength: 50 }, maxItems: 10 },
    evidenceQuote: { type: "string", maxLength: 1000 },
  },
  required: ["content"],
  additionalProperties: false,
};

const statusUpdateSchema = z.object({
  status: z.enum(["new", "reviewed", "dismissed", "converted"]),
});

/** Plain JSON-Schema equivalent for Fastify (zod/v4 body schema is incompatible with Fastify 5). */
const statusUpdateJsonSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["new", "reviewed", "dismissed", "converted"] },
  },
  required: ["status"],
};

export async function featureRequestRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /feature-requests — list all feature requests
  fastify.get(
    "/feature-requests",
    {
      schema: {
        tags: ["Feature Requests"],
        summary: "List feature requests",
        description: "Returns feature requests ordered by extracted_at DESC with pagination.",
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
            offset: { type: "integer", minimum: 0, default: 0 },
            status: { type: "string", enum: ["new", "reviewed", "dismissed", "converted"] },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Querystring?: { limit?: number; offset?: number; status?: string };
      }>,
    ) => {
      const { limit = 100, offset = 0, status } = request.query ?? {};
      // DP-005: SQL-level status filter for correct pagination.
      const featureRequests = listFeatureRequests(
        status as FeatureRequestStatus | undefined,
        limit,
        offset,
      );
      return { featureRequests };
    },
  );

  // GET /feature-requests/:id — get a single feature request
  fastify.get(
    "/feature-requests/:id",
    {
      schema: {
        tags: ["Feature Requests"],
        summary: "Get a feature request by ID",
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
      const req = getFeatureRequest(request.params.id);
      if (!req) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Feature request not found" });
      }
      return { featureRequest: req };
    },
  );

  // POST /feature-requests — create a feature request (internal use, typically via MCP)
  fastify.post(
    "/feature-requests",
    {
      schema: {
        tags: ["Feature Requests"],
        summary: "Create a feature request",
        body: featureRequestBodyJsonSchema,
      },
    },
    async (
      request: FastifyRequest<{ Body: z.infer<typeof featureRequestBodySchema> }>,
      reply: FastifyReply,
    ) => {
      const parseResult = featureRequestBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(parseResult.error),
        });
      }
      const now = Date.now();
      const id = `fr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const req = {
        id,
        ...parseResult.data,
        status: "new" as FeatureRequestStatus,
        extractedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      createFeatureRequest(req);
      return reply.status(201).send({ featureRequest: req });
    },
  );

  // PATCH /feature-requests/:id: update status (review flow).
  // DP-005: URL aligned with plan (was `/:id/status`); status now in body.
  fastify.patch(
    "/feature-requests/:id",
    {
      schema: {
        tags: ["Feature Requests"],
        summary: "Update feature request status",
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
      const existing = getFeatureRequest(request.params.id);
      if (!existing) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Feature request not found" });
      }
      updateFeatureRequestStatus(request.params.id, parseResult.data.status);
      return { ok: true, id: request.params.id, status: parseResult.data.status };
    },
  );
}
