import { WebSocket } from "ws";
import type { WsEvent } from "../../shared/types.js";

/**
 * Test WebSocket client for connecting to task stream endpoints.
 */
export class TestWsClient {
  private ws: WebSocket;
  private messages: WsEvent[] = [];
  private openPromise: Promise<void>;
  private closePromise: Promise<{ code: number; reason: string }>;
  private _closeCode?: number;
  private _closeReason?: string;

  constructor(url: string) {
    this.ws = new WebSocket(url);

    this.openPromise = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", (err) => reject(err));
    });

    this.closePromise = new Promise((resolve) => {
      this.ws.on("close", (code: number, reason: Buffer) => {
        this._closeCode = code;
        this._closeReason = reason.toString();
        resolve({ code, reason: reason.toString() });
      });
    });

    this.ws.on("message", (data: Buffer) => {
      try {
        this.messages.push(JSON.parse(data.toString()));
      } catch {
        // Ignore non-JSON messages
      }
    });
  }

  async waitForOpen(): Promise<void> {
    return this.openPromise;
  }

  async waitForClose(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    return Promise.race([
      this.closePromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("WS close timeout")), timeoutMs),
      ),
    ]);
  }

  async waitForMessages(count: number, timeoutMs = 5000): Promise<WsEvent[]> {
    const start = Date.now();
    while (this.messages.length < count) {
      if (Date.now() - start > timeoutMs) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.messages;
  }

  getMessages(): WsEvent[] {
    return [...this.messages];
  }

  getMessagesByType(type: string): WsEvent[] {
    return this.messages.filter((m) => m.type === type);
  }

  get closeCode(): number | undefined {
    return this._closeCode;
  }

  get closeReason(): string | undefined {
    return this._closeReason;
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}
