import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { serverBus, type GlobalEvent } from "../events/server-bus.js";
import { getLogger } from "../../lib/logger.js";

const log = getLogger("ws");
const chatClients = new Set<WebSocket>();
const eventBuffer: GlobalEvent[] = [];
const MAX_BUFFER_SIZE = 50;

function bufferEvent(event: GlobalEvent): void {
  eventBuffer.push(event);
  if (eventBuffer.length > MAX_BUFFER_SIZE) {
    eventBuffer.shift();
  }
}

function broadcastChatEvent(event: GlobalEvent): void {
  bufferEvent(event);
  const payload = JSON.stringify(event);
  for (const socket of chatClients) {
    if (socket.readyState === 1) {
      socket.send(payload);
    }
  }
}

const CHAT_EVENT_TYPES = new Set([
  "session_created",
  "session_archived",
  "session_restored",
  "session_deleted",
  "chat_message",
]);

export function registerChatStream(fastify: FastifyInstance): void {
  fastify.get("/chat/stream", { websocket: true }, (socket: WebSocket, _request: FastifyRequest) => {
    chatClients.add(socket);

    // Replay buffered events on connection
    for (const event of eventBuffer) {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(event));
      }
    }

    socket.on("close", () => {
      chatClients.delete(socket);
    });

    socket.on("error", (err) => {
      log.error({ error: err }, "Chat WebSocket error");
      chatClients.delete(socket);
    });
  });

  // Subscribe to chat-related serverBus events
  serverBus.on("session_created", (data) => broadcastChatEvent(data));
  serverBus.on("session_archived", (data) => broadcastChatEvent(data));
  serverBus.on("session_restored", (data) => broadcastChatEvent(data));
  serverBus.on("session_deleted", (data) => broadcastChatEvent(data));
  serverBus.on("chat_message", (data) => broadcastChatEvent(data));
  serverBus.on("task_complete_event", (data) => broadcastChatEvent(data));
}

// For testing
export function _getClientCount(): number {
  return chatClients.size;
}

export function _getBufferSize(): number {
  return eventBuffer.length;
}

export function _clearBuffer(): void {
  eventBuffer.length = 0;
}
