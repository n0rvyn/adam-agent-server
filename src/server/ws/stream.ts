import type { WebSocket } from "ws";
import type { WsEvent, WsEventType } from "../../shared/types.js";

const MAX_BUFFER_SIZE = 100;

export class StreamManager {
  private connections = new Map<string, Set<WebSocket>>();
  private eventBuffers = new Map<string, WsEvent[]>();
  private eventIndices = new Map<string, number>();

  addConnection(taskId: string, socket: WebSocket): void {
    if (!this.connections.has(taskId)) {
      this.connections.set(taskId, new Set());
    }
    this.connections.get(taskId)!.add(socket);

    // Send buffered events to new connection
    const buffered = this.getBufferedEvents(taskId);
    for (const event of buffered) {
      if (socket.readyState === 1 /* OPEN */) {
        socket.send(JSON.stringify(event));
      }
    }

    socket.on("close", () => {
      this.removeConnection(taskId, socket);
    });
  }

  removeConnection(taskId: string, socket: WebSocket): void {
    const conns = this.connections.get(taskId);
    if (conns) {
      conns.delete(socket);
      if (conns.size === 0) {
        this.connections.delete(taskId);
      }
    }
  }

  broadcast(taskId: string, event: WsEvent): void {
    // Add to buffer
    this.addToBuffer(taskId, event);

    // Send to all connections
    const conns = this.connections.get(taskId);
    if (!conns || conns.size === 0) return;

    const payload = JSON.stringify(event);
    for (const socket of conns) {
      if (socket.readyState === 1 /* WebSocket.OPEN */) {
        socket.send(payload);
      }
    }
  }

  private addToBuffer(taskId: string, event: WsEvent): void {
    let buffer = this.eventBuffers.get(taskId);
    if (!buffer) {
      buffer = [];
      this.eventBuffers.set(taskId, buffer);
    }

    buffer.push(event);
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.shift();
    }

    this.eventIndices.set(taskId, event.index);
  }

  getBufferedEvents(taskId: string): WsEvent[] {
    return this.eventBuffers.get(taskId) ?? [];
  }

  getNextIndex(taskId: string): number {
    const current = this.eventIndices.get(taskId) ?? 0;
    const next = current + 1;
    this.eventIndices.set(taskId, next);
    return next;
  }
}

export const streamManager = new StreamManager();

/**
 * Transform Agent SDK events into normalized WsEvents for the TUI/CLI.
 *
 * Agent SDK event types (outer):
 *   - { type: "system", subtype: "init", ... }
 *   - { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } }
 *   - { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } } }
 *   - { type: "assistant", message: { content: [...] } }
 *   - { type: "result", subtype: "success", result, total_cost_usd, ... }
 *
 * Normalized WsEvent data:
 *   - reasoning:    { content: string }
 *   - tool_call:    { toolName: string, input: unknown }
 *   - tool_result:  { content: string }
 *   - complete:     (sent separately by scheduler)
 */
export function transformToWsEvent(
  taskId: string,
  index: number,
  sdkEvent: unknown,
): WsEvent | null {
  if (!sdkEvent || typeof sdkEvent !== "object") return null;

  const ev = sdkEvent as Record<string, unknown>;
  const outerType = ev["type"] as string | undefined;
  if (!outerType) return null;

  let wsType: WsEventType;
  let data: Record<string, unknown>;

  switch (outerType) {
    case "stream_event": {
      // Unwrap the inner API event
      const inner = ev["event"] as Record<string, unknown> | undefined;
      if (!inner) return null;

      const innerType = inner["type"] as string | undefined;

      if (innerType === "content_block_delta") {
        const delta = inner["delta"] as Record<string, unknown> | undefined;
        const deltaType = delta?.["type"] as string | undefined;

        if (deltaType === "text_delta") {
          wsType = "reasoning";
          data = { content: delta?.["text"] ?? "" };
        } else if (deltaType === "thinking_delta") {
          // Skip thinking deltas; TUI doesn't display internal reasoning
          return null;
        } else {
          return null; // signature_delta, etc.
        }
      } else if (innerType === "content_block_start") {
        const block = inner["content_block"] as Record<string, unknown> | undefined;
        if (block?.["type"] === "tool_use") {
          wsType = "tool_call";
          data = { toolName: block["name"] ?? "unknown", input: block["input"] ?? {} };
        } else {
          return null; // text/thinking block starts
        }
      } else {
        return null; // message_start, message_delta, message_stop, content_block_stop
      }
      break;
    }

    case "assistant": {
      // Accumulated message snapshot; extract tool results if present
      const message = ev["message"] as Record<string, unknown> | undefined;
      const content = message?.["content"] as Array<Record<string, unknown>> | undefined;
      if (!content) return null;

      // Look for tool_result blocks
      const toolResult = content.find((c) => c["type"] === "tool_result");
      if (toolResult) {
        wsType = "tool_result";
        const resultContent = toolResult["content"];
        data = { content: typeof resultContent === "string" ? resultContent : JSON.stringify(resultContent ?? "") };
        break;
      }

      return null; // Other assistant messages (text accumulation) already streamed via deltas
    }

    case "result":
      // Final result; "complete" is sent separately by the scheduler
      return null;

    case "system":
      // Init event; skip
      return null;

    default:
      return null;
  }

  return {
    taskId,
    index,
    type: wsType,
    timestamp: Date.now(),
    data,
  };
}
