import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import { listMemoriesByRole, createMemory, updateMemory, deleteMemory, getMemory } from "../../store/memories.js";
import { queryMemory } from "../../agent/memory-service.js";
import { generateEmbedding } from "../../lib/embedding.js";
import { getRole } from "../../store/roles.js";
import { responses } from "../response-schemas.js";
import { v4 as uuidv4 } from "uuid";

const roleIdParamsSchema = z.object({
  roleId: z.string().min(1),
});

const queryBodySchema = z.object({
  roleId: z.string().min(1),
  prompt: z.string().min(1),
  topK: z.number().min(1).max(50).default(10),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

/**
 * Check that a role exists by ID.
 */
function roleOrAgentExists(id: string): boolean {
  return getRole(id) !== undefined;
}

export async function memoryRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /memories/:roleId — list memories for role
  fastify.get(
    "/memories/:roleId",
    {
      schema: {
        tags: ["Memories"],
        summary: "List role memories",
        description: "List all memories for a specific role with pagination. Embeddings are stripped from the response.",
        params: {
          type: "object",
          required: ["roleId"],
          properties: {
            roleId: { type: "string" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
        response: responses.memoryList,
      },
    },
    async (
      request: FastifyRequest<{
        Params: { roleId: string };
        Querystring?: { limit?: number; offset?: number };
      }>,
      reply: FastifyReply,
    ) => {
      const paramsParse = roleIdParamsSchema.safeParse(request.params);
      if (!paramsParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(paramsParse.error),
        });
      }

      const roleId = paramsParse.data.roleId;
      if (!roleOrAgentExists(roleId)) {
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: "Role or agent not found",
        });
      }

      const queryParse = listQuerySchema.safeParse(request.query);
      const { limit, offset } = queryParse.success
        ? queryParse.data
        : { limit: 50, offset: 0 };

      const memories = listMemoriesByRole(roleId, limit, offset);

      // Strip embeddings from response (too large)
      const sanitized = memories.map(({ embedding: _embedding, ...rest }) => rest);

      return { memories: sanitized, count: sanitized.length };
    },
  );

  // POST /memories/query — query memories with hybrid search + Smallville scoring
  fastify.post(
    "/memories/query",
    {
      schema: {
        tags: ["Memories"],
        summary: "Query role memories",
        description: "Query a role's memories using hybrid search (FTS5 + vector similarity) with Smallville-style scoring (recency, importance, relevance).",
        body: {
          type: "object",
          required: ["roleId", "prompt"],
          properties: {
            roleId: { type: "string", minLength: 1, description: "The role whose memories to query" },
            prompt: { type: "string", minLength: 1, description: "The search query" },
            topK: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "Number of results to return" },
          },
        },
        response: responses.memoryQuery,
      },
    },
    async (
      request: FastifyRequest<{
        Body: { roleId: string; prompt: string; topK?: number };
      }>,
      reply: FastifyReply,
    ) => {
      const bodyParse = queryBodySchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: z.prettifyError(bodyParse.error),
        });
      }

      const { roleId, prompt, topK } = bodyParse.data;

      if (!roleOrAgentExists(roleId)) {
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: "Role or agent not found",
        });
      }

      const results = await queryMemory(roleId, prompt, { topK });

      // Strip embeddings, include scores
      const sanitized = results.map(({ embedding, ...rest }) => rest);

      return { memories: sanitized, count: sanitized.length };
    },
  );

  // POST /memories — create a new memory
  const createBodySchema = z.object({
    roleId: z.string().min(1),
    content: z.string().min(1),
    type: z.enum(["event", "thought", "reflection"]).default("thought"),
    keywords: z.array(z.string()).default([]),
    importance: z.number().min(1).max(5).default(3),
    tier: z.enum(["working", "episodic", "semantic"]).default("episodic"),
  });

  fastify.post(
    "/memories",
    {
      schema: {
        tags: ["Memories"],
        summary: "Create memory",
        description: "Create a new memory for a role. Embedding is auto-generated from content.",
        body: {
          type: "object",
          required: ["roleId", "content"],
          properties: {
            roleId: { type: "string", minLength: 1 },
            content: { type: "string", minLength: 1 },
            type: { type: "string", enum: ["event", "thought", "reflection"], default: "thought" },
            keywords: { type: "array", items: { type: "string" }, default: [] },
            importance: { type: "integer", minimum: 1, maximum: 5, default: 3 },
            tier: { type: "string", enum: ["working", "episodic", "semantic"], default: "episodic" },
          },
        },
        response: responses.memoryCreated,
      },
    },
    async (
      request: FastifyRequest<{
        Body: { roleId: string; content: string; type?: string; keywords?: string[]; importance?: number; tier?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const bodyParse = createBodySchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(bodyParse.error) });
      }

      const { roleId, content, type, keywords, importance, tier } = bodyParse.data;
      if (!roleOrAgentExists(roleId)) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Role or agent not found" });
      }

      let embedding: Float32Array | undefined;
      try {
        embedding = await generateEmbedding(content);
      } catch {
        // Proceed without embedding
      }

      const id = `mem-${uuidv4().slice(0, 8)}`;
      const now = Date.now();
      createMemory({
        id,
        roleId,
        type: type as "event" | "thought" | "reflection",
        content,
        embedding,
        keywords,
        importance,
        sourceType: "manual",
        createdAt: now,
        lastAccessed: now,
        retrievedCount: 0,
        tier: (tier ?? "episodic") as "working" | "episodic" | "semantic",
      });

      const created = getMemory(id);
      const { embedding: _e, ...sanitized } = created!;
      return reply.status(201).send({ memory: sanitized });
    },
  );

  // PATCH /memories/:id — update a memory
  const updateBodySchema = z.object({
    content: z.string().min(1).optional(),
    type: z.enum(["event", "thought", "reflection"]).optional(),
    keywords: z.array(z.string()).optional(),
    importance: z.number().min(1).max(5).optional(),
  });

  fastify.patch(
    "/memories/:id",
    {
      schema: {
        tags: ["Memories"],
        summary: "Update memory",
        description: "Update a memory's content, type, keywords, or importance. Embedding is regenerated if content changes.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          properties: {
            content: { type: "string", minLength: 1 },
            type: { type: "string", enum: ["event", "thought", "reflection"] },
            keywords: { type: "array", items: { type: "string" } },
            importance: { type: "integer", minimum: 1, maximum: 5 },
          },
        },
        response: responses.memoryUpdated,
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { content?: string; type?: string; keywords?: string[]; importance?: number };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const existing = getMemory(id);
      if (!existing) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Memory not found" });
      }

      const bodyParse = updateBodySchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(bodyParse.error) });
      }

      const updates = bodyParse.data;
      let embedding: Float32Array | undefined;
      let embeddingUpdated = true;
      if (updates.content) {
        try {
          embedding = await generateEmbedding(updates.content);
        } catch {
          embeddingUpdated = false;
        }
      }

      const updated = updateMemory(id, {
        content: updates.content,
        embedding,
        keywords: updates.keywords,
        importance: updates.importance,
        type: updates.type as "event" | "thought" | "reflection" | undefined,
      });

      return { memoryId: id, updated, embeddingUpdated };
    },
  );

  // DELETE /memories/:id — delete a memory
  fastify.delete(
    "/memories/:id",
    {
      schema: {
        tags: ["Memories"],
        summary: "Delete memory",
        description: "Delete a memory by ID.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: responses.memoryDeleted,
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const existing = getMemory(id);
      if (!existing) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Memory not found" });
      }

      deleteMemory(id);
      return { memoryId: id, deleted: true };
    },
  );
}
