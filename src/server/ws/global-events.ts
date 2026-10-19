import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { timingSafeEqual } from "node:crypto";
import { serverBus, type GlobalEvent } from "../events/server-bus.js";
import { getLogger } from "../../lib/logger.js";
import { findMessageByTaskId } from "../../store/messages.js";
import { getSession } from "../../store/sessions.js";
import { getAuthKeyBuffer } from "../auth-key.js";

const log = getLogger("ws");
const clients = new Set<WebSocket>();

export function registerGlobalEvents(fastify: FastifyInstance): void {
  fastify.get("/events", { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    if (!validateWsAuth(request)) {
      socket.close(4401, "Unauthorized");
      return;
    }

    clients.add(socket);

    socket.on("close", () => {
      clients.delete(socket);
    });

    socket.on("error", (err) => {
      log.error({ error: err }, "WebSocket error");
      clients.delete(socket);
    });
  });

  // Subscribe to serverBus events and broadcast to all clients
  serverBus.on("task_status_change", (data) => {
    broadcastGlobalEvent(data);
  });
  serverBus.on("approval_request", (data) => {
    broadcastGlobalEvent(data);
  });
  serverBus.on("stats_update", (data) => {
    broadcastGlobalEvent(data);
  });
  serverBus.on("log_event", (data) => {
    broadcastGlobalEvent(data);
  });
  serverBus.on("config_changed", (data) => {
    broadcastGlobalEvent(data);
  });
  // Plan approval events (D-010) — suppress broadcast for channel-originated tasks (Phase 5)
  serverBus.on("plan_approval_request", (data) => {
    const hasSourceChannel = (() => {
      try {
        const message = findMessageByTaskId(data.taskId);
        if (!message) return false;
        const session = getSession(message.sessionId);
        if (!session) return false;
        return session.source.type === "channel" && !!session.source.channelId;
      } catch {
        return false;
      }
    })();
    if (!hasSourceChannel) {
      broadcastGlobalEvent(data);
    }
  });
  serverBus.on("plan_approval_decision", (data) => {
    broadcastGlobalEvent(data);
  });
  // Execution pool events (Phase 1: ChatManager + ExecutionPool split)
  serverBus.on("task_created", (data) => {
    broadcastGlobalEvent(data);
  });
  serverBus.on("execution_slot_change", (data) => {
    broadcastGlobalEvent(data);
  });
  serverBus.on("execution_task_start", (data) => {
    broadcastGlobalEvent(data);
  });
  serverBus.on("execution_task_end", (data) => {
    broadcastGlobalEvent(data);
  });
  serverBus.on("delivery_status_change", (data) => {
    broadcastGlobalEvent(data);
  });
  // TemplateExecution events (Issue #154: multi-role template execution)
  serverBus.on("template_execution_status_change", (data) => {
    broadcastGlobalEvent(data);
  });
  serverBus.on("cron_no_target_warning", (data) => {
    broadcastGlobalEvent(data);
  });
}

function broadcastGlobalEvent(event: GlobalEvent): void {
  const payload = JSON.stringify(event);
  for (const socket of clients) {
    if (socket.readyState === 1) {
      socket.send(payload);
    }
  }
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
