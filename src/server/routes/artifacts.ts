/**
 * Artifacts REST routes — Phase 3
 *
 * Handlers added incrementally:
 *   Task 1-impl: GET /artifacts, GET /artifacts/:id, GET /tasks/:taskId/artifacts (alias)
 *   Task 2-impl: GET /artifacts/:id/blob
 *   Task 3-impl: DELETE /artifacts/:id
 *   Task 4-impl: POST /artifacts/:id/redeliver
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import { existsSync, createReadStream } from "node:fs";
import {
  getArtifactById,
  listArtifacts,
  deleteArtifactById,
  type ListArtifactsFilter,
} from "../../store/artifacts.js";
import { getDeliveryLogByTask } from "../../store/delivery-log.js";
import { filenameForArtifact, mediaTypeForArtifact } from "../../lib/artifact-attachments.js";
import { unlinkBlob } from "../../lib/artifact-storage.js";
import { getDangerClass } from "../../lib/artifact-danger-class.js";
import { getChannel } from "../../store/channels.js";
import { getOutboundGateway } from "../../delivery/outbound-gateway.js";
import { getLogger } from "../../lib/logger.js";

const log = getLogger("manager"); // "artifact" not in LogComponent union; fallback to "manager"

// ─── Shared param / query schemas ────────────────────────────────────────────

const idParamsSchema = z.object({
  id: z.string().min(1).max(64),
});

const taskIdParamsSchema = z.object({
  taskId: z.string().min(1).max(64),
});

const listQuerySchema = z.object({
  source_kind: z.enum(["template_step", "task_published", "chat_sent"]).optional(),
  mime_prefix: z
    .string()
    .max(64)
    .regex(/^[a-zA-Z0-9./+\-]+$/, "invalid mime_prefix")
    .optional(),
  role_id: z.string().max(64).optional(),
  task_id: z.string().max(64).optional(),
  execution_id: z.string().max(64).optional(),
  chat_session_id: z.string().max(64).optional(),
  delivery_status: z.enum(["delivered", "pending", "failed", "expired"]).optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

// ─── Route registration ───────────────────────────────────────────────────────

export async function artifactRoutes(fastify: FastifyInstance): Promise<void> {
  // ── GET /artifacts ────────────────────────────────────────────────────────
  fastify.get(
    "/artifacts",
    { schema: { tags: ["Artifacts"], summary: "List artifacts" } },
    async (request, reply) => {
      const qParse = listQuerySchema.safeParse(request.query);
      if (!qParse.success) {
        return reply
          .status(400)
          .send({ code: "VALIDATION_ERROR", message: z.prettifyError(qParse.error) });
      }
      const q = qParse.data;
      const filter: ListArtifactsFilter = {
        sourceKind: q.source_kind,
        mimePrefix: q.mime_prefix,
        roleId: q.role_id,
        taskId: q.task_id,
        executionId: q.execution_id,
        chatSessionId: q.chat_session_id,
        deliveryStatus: q.delivery_status,
        from: q.from,
        to: q.to,
      };
      const result = listArtifacts(filter, { limit: q.limit, offset: q.offset });
      return result;
    },
  );

  // ── GET /artifacts/:id ────────────────────────────────────────────────────
  fastify.get(
    "/artifacts/:id",
    { schema: { tags: ["Artifacts"], summary: "Get artifact detail" } },
    async (request, reply) => {
      const pParse = idParamsSchema.safeParse(request.params);
      if (!pParse.success) {
        return reply
          .status(400)
          .send({ code: "VALIDATION_ERROR", message: z.prettifyError(pParse.error) });
      }
      const artifact = getArtifactById(pParse.data.id);
      if (!artifact) {
        return reply
          .status(404)
          .send({ code: "NOT_FOUND", message: "Artifact not found" });
      }

      // delivery_log JOIN: skip for chat_sent (no task context).
      // For other sources, query by both taskId and executionId (compat for task_id=execution_id hack).
      let deliveryLog: ReturnType<typeof getDeliveryLogByTask> = [];
      if (artifact.sourceKind !== "chat_sent") {
        const taskIds = [artifact.taskId, artifact.executionId].filter(
          (id): id is string => !!id,
        );
        for (const tid of taskIds) {
          deliveryLog = deliveryLog.concat(getDeliveryLogByTask(tid, 50));
        }
      }

      return { artifact, deliveryLog };
    },
  );

  // ── GET /tasks/:taskId/artifacts (alias) ──────────────────────────────────
  fastify.get(
    "/tasks/:taskId/artifacts",
    { schema: { tags: ["Artifacts"], summary: "List artifacts for a task (alias)" } },
    async (request, reply) => {
      const pParse = taskIdParamsSchema.safeParse(request.params);
      if (!pParse.success) {
        return reply
          .status(400)
          .send({ code: "VALIDATION_ERROR", message: z.prettifyError(pParse.error) });
      }
      // Forward to list with task_id injected; limit/offset from query
      const qParse = listQuerySchema.safeParse({
        ...(request.query as Record<string, unknown>),
        task_id: pParse.data.taskId,
      });
      if (!qParse.success) {
        return reply
          .status(400)
          .send({ code: "VALIDATION_ERROR", message: z.prettifyError(qParse.error) });
      }
      const result = listArtifacts(
        { taskId: pParse.data.taskId },
        { limit: qParse.data.limit, offset: qParse.data.offset },
      );
      return result;
    },
  );

  // ── GET /artifacts/:id/blob ───────────────────────────────────────────────
  fastify.get(
    "/artifacts/:id/blob",
    { schema: { tags: ["Artifacts"], summary: "Download artifact blob" } },
    async (request, reply) => {
      const pParse = idParamsSchema.safeParse(request.params);
      if (!pParse.success) {
        return reply
          .status(400)
          .send({ code: "VALIDATION_ERROR", message: z.prettifyError(pParse.error) });
      }
      const artifact = getArtifactById(pParse.data.id);
      if (!artifact) {
        return reply
          .status(404)
          .send({ code: "NOT_FOUND", message: "Artifact not found" });
      }
      if (!artifact.blobPath || !existsSync(artifact.blobPath)) {
        log.warn({ artifactId: artifact.id, blobPath: artifact.blobPath }, "blob missing on disk");
        return reply
          .status(500)
          .send({ code: "INTERNAL_ERROR", message: "blob missing on disk" });
      }

      const filename = filenameForArtifact(artifact);
      // Sanitize header — strip CR/LF/quote/backslash to defeat CRLF header injection.
      // `originalFilename` comes from publish-time basename which can be LLM-controlled.
      const safeFilename = filename.replace(/[\r\n"\\]/g, "_");
      reply.header("Content-Type", artifact.mime ?? "application/octet-stream");
      reply.header("Content-Disposition", `attachment; filename="${safeFilename}"`);
      reply.header("Content-Length", artifact.sizeBytes);

      const stream = createReadStream(artifact.blobPath);
      return reply.send(stream);
    },
  );

  // ── DELETE /artifacts/:id ─────────────────────────────────────────────────
  const deleteQuerySchema = z.object({
    confirm: z.string().optional(),
  });

  fastify.delete(
    "/artifacts/:id",
    { schema: { tags: ["Artifacts"], summary: "Delete artifact" } },
    async (request, reply) => {
      const pParse = idParamsSchema.safeParse(request.params);
      if (!pParse.success) {
        return reply
          .status(400)
          .send({ code: "VALIDATION_ERROR", message: z.prettifyError(pParse.error) });
      }
      const qParse = deleteQuerySchema.safeParse(request.query);
      if (!qParse.success) {
        return reply
          .status(400)
          .send({ code: "VALIDATION_ERROR", message: z.prettifyError(qParse.error) });
      }
      const artifact = getArtifactById(pParse.data.id);
      if (!artifact) {
        return reply
          .status(404)
          .send({ code: "NOT_FOUND", message: "Artifact not found" });
      }

      const dangerClass = getDangerClass(artifact.mime);
      const confirmed = qParse.data.confirm === "true" || qParse.data.confirm === "1";
      if (dangerClass && !confirmed) {
        return reply.status(412).send({
          error: "danger-class-requires-confirm",
          mime: artifact.mime,
          danger_class: dangerClass,
        });
      }

      if (artifact.blobPath) {
        try {
          unlinkBlob(artifact.blobPath);
        } catch {
          // best-effort — ENOENT or already deleted
        }
      }
      deleteArtifactById(artifact.id);
      log.info(
        { artifactId: artifact.id, mime: artifact.mime, dangerClass },
        "artifact deleted via DELETE /artifacts/:id",
      );

      return reply.status(204).send();
    },
  );

  // ── POST /artifacts/:id/redeliver ─────────────────────────────────────────
  const redeliverBodySchema = z.object({
    channelId: z.string().min(1).max(64),
    chatId: z.string().max(256).optional(),
  });

  fastify.post(
    "/artifacts/:id/redeliver",
    { schema: { tags: ["Artifacts"], summary: "Redeliver artifact to a channel" } },
    async (request, reply) => {
      const pParse = idParamsSchema.safeParse(request.params);
      if (!pParse.success) {
        return reply
          .status(400)
          .send({ code: "VALIDATION_ERROR", message: z.prettifyError(pParse.error) });
      }
      const bParse = redeliverBodySchema.safeParse(request.body);
      if (!bParse.success) {
        return reply
          .status(400)
          .send({ code: "VALIDATION_ERROR", message: z.prettifyError(bParse.error) });
      }
      const artifact = getArtifactById(pParse.data.id);
      if (!artifact) {
        return reply
          .status(404)
          .send({ code: "NOT_FOUND", message: "Artifact not found" });
      }
      const channel = getChannel(bParse.data.channelId);
      if (!channel) {
        return reply
          .status(404)
          .send({ code: "NOT_FOUND", message: `Channel not found: ${bParse.data.channelId}` });
      }

      const content = `Artifact: ${artifact.originalFilename ?? artifact.id} (${artifact.mime ?? "unknown"}, ${artifact.sizeBytes} bytes)`;
      const gateway = getOutboundGateway();
      // gateway.send creates delivery_log internally and returns logEntryId — do NOT pre-create.
      const result = await gateway.send({
        channelId: channel.id,
        chatId: bParse.data.chatId,
        content,
        messageType: "deliver",
        mediaUrl: artifact.blobPath,
        mediaType: mediaTypeForArtifact(artifact),
      });

      if (!result.success) {
        // Sync reject — gateway already wrote delivery_log with status=failed.
        // Surface "rejected" as response-layer label (distinct from async failure polled via delivery_log).
        return reply.send({
          deliveryLogId: result.logEntryId,
          status: "rejected" as const,
          reason: result.error ?? "unknown",
        });
      }
      return reply.send({ deliveryLogId: result.logEntryId, status: "pending" as const });
    },
  );

  log.debug("artifactRoutes registered");
}
