import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getLogger } from "../lib/logger.js";
import { RUNTIME_DIR } from "../shared/constants.js";

const log = getLogger("ws");

const ADAM_DIR = join(homedir(), ".adam");
const PORT_FILE = join(ADAM_DIR, "adam.port");
const KEY_FILE = join(RUNTIME_DIR, "adam.key");

export function readApiKey(): string | undefined {
  const envKey = process.env.ADAM_API_KEY;
  if (envKey) return envKey;
  if (existsSync(KEY_FILE)) {
    return readFileSync(KEY_FILE, "utf-8").trim() || undefined;
  }
  return undefined;
}

function readPort(): number | null {
  if (!existsSync(PORT_FILE)) return null;
  const port = parseInt(readFileSync(PORT_FILE, "utf-8").trim(), 10);
  return isNaN(port) ? null : port;
}

function getBaseUrl(): string {
  const port = readPort();
  if (!port) {
    throw new Error("Server not running. Run: adam server start");
  }
  return `http://localhost:${port}`;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path}`;

  const apiKey = readApiKey();
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    throw new ApiError(response.status, text);
  }

  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    return response.json() as Promise<T>;
  }

  return response.text() as unknown as T;
}

export function getHealth(): Promise<{ status: string }> {
  return request<{ status: string }>("/healthz");
}

export type EventCallback = (data: unknown) => void;

export class EventSocket {
  private ws: WebSocket | null = null;
  private callbacks: Map<string, Set<EventCallback>> = new Map();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;

  constructor(path: string = "/events") {
    const port = readPort();
    if (!port) {
      throw new Error("Server not running. Run: adam server start");
    }
    const apiKey = readApiKey();
    const wsUrl = new URL(`ws://localhost:${port}${path}`);
    if (apiKey) wsUrl.searchParams.set("api_key", apiKey);
    this.url = wsUrl.toString();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          this.reconnectAttempts = 0;
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data as string);
            const { type, data: innerData, ...rest } = data;
            const cbs = this.callbacks.get(type);
            if (cbs) {
              cbs.forEach((cb) => cb(innerData ?? rest));
            }
          } catch (err) {
            log.error({ error: err }, "Failed to parse WebSocket message");
          }
        };

        this.ws.onclose = () => {
          this.scheduleReconnect();
        };

        this.ws.onerror = (err) => {
          reject(err);
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  private scheduleReconnect(): void {
    const delays = [1000, 2000, 4000, 8000, 15000];
    const delay = delays[Math.min(this.reconnectAttempts, delays.length - 1)];
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        // Will retry again via onclose
      });
    }, delay);
  }

  on(event: string, callback: EventCallback): void {
    if (!this.callbacks.has(event)) {
      this.callbacks.set(event, new Set());
    }
    this.callbacks.get(event)!.add(callback);
  }

  off(event: string, callback: EventCallback): void {
    this.callbacks.get(event)?.delete(callback);
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.ws?.close();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export class TaskStreamSocket {
  private ws: WebSocket | null = null;
  private callbacks: Map<string, Set<EventCallback>> = new Map();
  private url: string;

  constructor(taskId: string) {
    const port = readPort();
    if (!port) {
      throw new Error("Server not running. Run: adam server start");
    }
    const apiKey = readApiKey();
    const wsUrl = new URL(`ws://localhost:${port}/tasks/${taskId}/stream`);
    if (apiKey) wsUrl.searchParams.set("api_key", apiKey);
    this.url = wsUrl.toString();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data as string);
            const { type, data: innerData, ...rest } = data;
            const cbs = this.callbacks.get(type);
            if (cbs) {
              cbs.forEach((cb) => cb(innerData ?? rest));
            }
            const anyCbs = this.callbacks.get("*");
            if (anyCbs) {
              anyCbs.forEach((cb) => cb(data));
            }
          } catch (err) {
            log.error({ error: err }, "Failed to parse task stream message");
          }
        };

        this.ws.onerror = (err) => {
          reject(err);
        };

        this.ws.onclose = () => {
          // Task stream closes when task completes
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  on(event: string, callback: EventCallback): void {
    if (!this.callbacks.has(event)) {
      this.callbacks.set(event, new Set());
    }
    this.callbacks.get(event)!.add(callback);
  }

  off(event: string, callback: EventCallback): void {
    this.callbacks.get(event)?.delete(callback);
  }

  close(): void {
    this.ws?.close();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
