import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import * as sessionManager from "../../chat/session-manager.js";
import { getMessagesBySession } from "../../store/messages.js";
import { handleChatMessage } from "../../chat/message-handler.js";
import type { ChatSource, ChatSessionStatus } from "../../shared/types.js";

const VALID_STATUSES = ["active", "archived"] as const;

const createSessionBodySchema = z.object({
  source: z.object({
    type: z.enum(["tui", "web", "api", "channel"]),
    channelId: z.string().optional(),
    chatId: z.string().optional(),
  }),
  roleId: z.string().optional(),
});

const sessionParamsSchema = z.object({
  id: z.string().uuid(),
});

const listSessionsQuerySchema = z.object({
  status: z.enum(VALID_STATUSES).optional(),
  limit: z.coerce.number().min(1).max(100).default(100),
  offset: z.coerce.number().min(0).default(0),
});

const messagesQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

export async function chatRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /chat/sessions — create a new session
  fastify.post(
    "/chat/sessions",
    {
      schema: {
        tags: ["Chat"],
        summary: "Create a chat session",
        body: {
          type: "object",
          required: ["source"],
          properties: {
            source: {
              type: "object",
              required: ["type"],
              properties: {
                type: { type: "string", enum: ["tui", "web", "api", "channel"] },
                channelId: { type: "string" },
                chatId: { type: "string" },
              },
            },
            roleId: { type: "string" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: { source: ChatSource; roleId?: string } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = createSessionBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }

      const { source, roleId } = parseResult.data;
      const session = sessionManager.createSession(source as ChatSource, roleId);
      return reply.status(201).send({ session });
    },
  );

  // GET /chat/sessions — list sessions
  fastify.get(
    "/chat/sessions",
    {
      schema: {
        tags: ["Chat"],
        summary: "List chat sessions",
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["active", "archived"] },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Querystring: { status?: ChatSessionStatus; limit?: number; offset?: number } }>,
      _reply: FastifyReply,
    ) => {
      const parseResult = listSessionsQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return _reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }
      const { status } = parseResult.data;
      const sessions = sessionManager.listSessions(status as ChatSessionStatus | undefined);
      return { sessions };
    },
  );

  // GET /chat/sessions/:id — get session with messages
  fastify.get(
    "/chat/sessions/:id",
    {
      schema: {
        tags: ["Chat"],
        summary: "Get chat session with messages",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = sessionParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }

      const session = sessionManager.getSession(parseResult.data.id);
      if (!session) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Session not found" });
      }

      const messages = getMessagesBySession(session.id);
      return { session, messages };
    },
  );

  // POST /chat/sessions/:id/archive — archive session
  fastify.post(
    "/chat/sessions/:id/archive",
    {
      schema: {
        tags: ["Chat"],
        summary: "Archive a chat session",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = sessionParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }

      const session = sessionManager.getSession(parseResult.data.id);
      if (!session) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Session not found" });
      }

      sessionManager.archiveSession(session.id);
      return { sessionId: session.id, status: "archived" };
    },
  );

  // POST /chat/sessions/:id/restore — restore archived session
  fastify.post(
    "/chat/sessions/:id/restore",
    {
      schema: {
        tags: ["Chat"],
        summary: "Restore an archived session",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = sessionParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }

      const restored = sessionManager.restoreSession(parseResult.data.id);
      if (!restored) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Session not found" });
      }

      return { session: restored };
    },
  );

  // DELETE /chat/sessions/:id — delete session and messages
  fastify.delete(
    "/chat/sessions/:id",
    {
      schema: {
        tags: ["Chat"],
        summary: "Delete a chat session",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = sessionParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }

      const session = sessionManager.getSession(parseResult.data.id);
      if (!session) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Session not found" });
      }

      sessionManager.deleteSession(session.id);
      return reply.status(204).send();
    },
  );

  // GET /chat/sessions/:id/messages — get messages for session
  fastify.get(
    "/chat/sessions/:id/messages",
    {
      schema: {
        tags: ["Chat"],
        summary: "Get messages for a session",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Querystring: { limit?: number; offset?: number } }>,
      reply: FastifyReply,
    ) => {
      const parseResult = sessionParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }

      const session = sessionManager.getSession(parseResult.data.id);
      if (!session) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Session not found" });
      }

      const queryParse = messagesQuerySchema.safeParse(request.query);
      const { limit = 50, offset = 0 } = queryParse.success ? queryParse.data : {};
      const messages = getMessagesBySession(session.id, limit, offset);
      return { messages };
    },
  );

  // POST /chat/messages — send a message (creates session if needed)
  const sendMessageBodySchema = z.object({
    content: z.string().min(1, "content is required"),
    source: z.object({
      type: z.enum(["tui", "web", "api", "channel"]),
      channelId: z.string().optional(),
      chatId: z.string().optional(),
    }),
    roleId: z.string().optional(),
    sessionId: z.string().uuid().optional(),
    buttonPayload: z
      .object({
        promptId: z.string().min(1),
        value: z.string().min(1),
      })
      .optional(),
  });

  fastify.post(
    "/chat/messages",
    {
      schema: {
        tags: ["Chat"],
        summary: "Send a chat message",
        description: "Send a message. Creates a session if no active session exists for the source. Returns sessionId, messageId, and response.",
        body: {
          type: "object",
          required: ["content", "source"],
          properties: {
            content: { type: "string", minLength: 1 },
            source: {
              type: "object",
              required: ["type"],
              properties: {
                type: { type: "string", enum: ["tui", "web", "api", "channel"] },
                channelId: { type: "string" },
                chatId: { type: "string" },
              },
            },
            roleId: { type: "string" },
            sessionId: { type: "string" },
            buttonPayload: {
              type: "object",
              required: ["promptId", "value"],
              properties: {
                promptId: { type: "string", minLength: 1 },
                value: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Body: {
          content: string;
          source: ChatSource;
          roleId?: string;
          sessionId?: string;
          buttonPayload?: { promptId: string; value: string };
        };
      }>,
      reply: FastifyReply,
    ) => {
      const parseResult = sendMessageBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
      }

      const { content, source, roleId, sessionId, buttonPayload } = parseResult.data;
      const inboundMeta = buttonPayload
        ? { buttonPayload: { promptId: buttonPayload.promptId, rawValue: buttonPayload.value } }
        : undefined;
      const result = await handleChatMessage(content, source as ChatSource, roleId, sessionId, inboundMeta);
      return reply.status(201).send(result);
    },
  );
}
