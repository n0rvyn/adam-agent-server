import { WebSocket } from "ws";
import type { ChannelAdapter, ChannelStatus, InboundMessage, OutboundMessage } from "../adapter.js";
import { getLogger } from "../../lib/logger.js";

const log = getLogger("channels");

interface OpenClawConfig {
  gatewayUrl: string;  // ws://127.0.0.1:18789
  token?: string;
}

interface OpenClawFrame {
  type: "req" | "res" | "event";
  id?: string;
  method?: string;
  params?: unknown;
  event?: string;
  payload?: unknown;
  ok?: boolean;
  error?: string;
}

type MessageHandler = (msg: InboundMessage) => void;

let reqCounter = 0;

export class OpenClawAdapter implements ChannelAdapter {
  readonly platform = "openclaw" as const;
  readonly id: string;

  private config: OpenClawConfig;
  private status: ChannelStatus = "disconnected";
  private messageHandler: MessageHandler | null = null;
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private maxReconnectAttempts = 10;
  private pendingResponses = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(id: string, config: OpenClawConfig) {
    this.id = id;
    this.config = config;
  }

  async connect(): Promise<void> {
    this.status = "connecting";

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.gatewayUrl);

        this.ws.on("open", () => {
          // Send connect frame
          this.sendFrame({
            type: "req",
            id: this.nextId(),
            method: "connect",
            params: {
              role: "node",
              name: "adam",
              capabilities: ["agent", "chat"],
              token: this.config.token,
            },
          });
          this.status = "connected";
          this.reconnectAttempts = 0;
          log.info({ channelId: this.id }, "OpenClaw gateway connected");
          resolve();
        });

        this.ws.on("message", (data) => {
          try {
            const frame = JSON.parse(data.toString()) as OpenClawFrame;
            this.handleFrame(frame);
          } catch (err) {
            log.error({ error: err }, "Failed to parse OpenClaw frame");
          }
        });

        this.ws.on("close", () => {
          this.status = "disconnected";
          this.scheduleReconnect();
        });

        this.ws.on("error", (err) => {
          this.status = "error";
          log.error({ channelId: this.id, error: err }, "OpenClaw WebSocket error");
          if (this.reconnectAttempts === 0) reject(err);
        });
      } catch (err) {
        this.status = "error";
        reject(err);
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.status = "disconnected";
    this.reconnectAttempts = 0;
    this.pendingResponses.clear();
  }

  getStatus(): ChannelStatus {
    return this.status;
  }

  getCapabilities(): import("../../shared/types.js").ChannelCapabilities {
    return {
      canEdit: false,
      canQuote: true,
      canParseQuote: true,
      canInlineButtons: false,
      maxTextLength: 4000,
      supportsAttachments: true,
    };
  }

  async sendMessage(chatId: string, message: OutboundMessage): Promise<string> {
    const id = this.nextId();
    this.sendFrame({
      type: "req",
      id,
      method: "chat.send",
      params: {
        chatId,
        content: message.content,
        replyTo: message.replyToMessageId,
      },
    });

    // Wait for response
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(id);
        reject(new Error("OpenClaw send timeout"));
      }, 10_000);

      this.pendingResponses.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(String(result ?? id));
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  // Frame handling

  private handleFrame(frame: OpenClawFrame): void {
    if (frame.type === "res" && frame.id) {
      const pending = this.pendingResponses.get(frame.id);
      if (pending) {
        this.pendingResponses.delete(frame.id);
        if (frame.ok) {
          pending.resolve(frame.payload);
        } else {
          pending.reject(new Error(frame.error ?? "Unknown error"));
        }
      }
      return;
    }

    if (frame.type === "event" && frame.event === "chat") {
      this.handleChatEvent(frame.payload);
      return;
    }
  }

  private handleChatEvent(payload: unknown): void {
    if (!this.messageHandler || !payload) return;
    const data = payload as Record<string, unknown>;

    const msg: InboundMessage = {
      channelId: this.id,
      platform: (data.platform as string) ?? "openclaw",
      chatId: String(data.chatId ?? ""),
      senderId: String(data.senderId ?? ""),
      senderName: data.senderName as string | undefined,
      content: String(data.content ?? ""),
      mediaUrl: data.mediaUrl as string | undefined,
      mediaType: data.mediaType as InboundMessage["mediaType"],
      replyToMessageId: data.replyTo as string | undefined,
      isGroup: Boolean(data.isGroup),
      timestamp: (data.timestamp as number) ?? Date.now(),
      raw: payload,
    };

    this.messageHandler(msg);
  }

  // WebSocket utilities

  private sendFrame(frame: OpenClawFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private nextId(): string {
    return `adam-${++reqCounter}`;
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error({ channelId: this.id }, "Max reconnect attempts reached");
      this.status = "error";
      return;
    }

    const delays = [1000, 2000, 4000, 8000, 15000, 30000];
    const delay = delays[Math.min(this.reconnectAttempts, delays.length - 1)];
    this.reconnectAttempts++;

    log.info({ channelId: this.id, attempt: this.reconnectAttempts, delay }, "Scheduling OpenClaw reconnect");

    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch(() => {
        // Will retry via onclose
      });
    }, delay);
  }
}
