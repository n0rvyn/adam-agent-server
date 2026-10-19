import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import { streamManager } from "./stream.js";
import { getTask } from "../../store/tasks.js";
import { getAuthKeyBuffer } from "../auth-key.js";

const streamParamsSchema = z.object({
  id: z.string().uuid(),
});

export async function streamRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { id: string } }>(
    "/tasks/:id/stream",
    { websocket: true },
    (socket: WebSocket, request: FastifyRequest<{ Params: { id: string } }>) => {
      if (!validateWsAuth(request)) {
        socket.close(4401, "Unauthorized");
        return;
      }

      const parseResult = streamParamsSchema.safeParse(request.params);
      if (!parseResult.success) {
        socket.close(1008, "Invalid task ID");
        return;
      }

      const { id: taskId } = parseResult.data;
      const task = getTask(taskId);

      if (!task) {
        socket.close(1008, "Task not found");
        return;
      }

      streamManager.addConnection(taskId, socket);
    },
  );
}

function validateWsAuth(request: FastifyRequest): boolean {
  const keyBuffer = getAuthKeyBuffer();
  const headerKey = request.headers["x-api-key"] as string | undefined;
  if (headerKey) {
    try {
      const aBuf = Buffer.from(headerKey);
      if (aBuf.length === keyBuffer.length && timingSafeEqual(aBuf, keyBuffer)) return true;
    } catch {
      // treat timing-safe failure as no match
    }
  }
  const query = request.query as Record<string, string>;
  const queryKey = query["api_key"] || query["x-api-key"];
  if (queryKey) {
    try {
      const aBuf = Buffer.from(queryKey);
      if (aBuf.length === keyBuffer.length && timingSafeEqual(aBuf, keyBuffer)) return true;
    } catch {
      // treat timing-safe failure as no match
    }
  }
  return false;
}
