/**
 * Structured logging with pino.
 * Global singleton with child loggers per component namespace.
 * DP-002: Global singleton pattern.
 * DP-004: Multistream for WebSocket broadcast.
 */

import pino from "pino";
import { Writable } from "node:stream";
import type { LogComponent } from "../shared/types.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const BASE_LEVEL = (process.env.ADAM_LOG_LEVEL as LogLevel) || "info";

// Log event listeners for WebSocket streaming (DP-004: multistream)
type LogEventListener = (entry: {
  time: number;
  level: string;
  component: string;
  msg: string;
  [key: string]: unknown;
}) => void;
const logEventListeners: LogEventListener[] = [];

export function onLogEvent(listener: LogEventListener): void {
  logEventListeners.push(listener);
}

// Custom writable stream that forwards parsed log entries to listeners
const broadcastStream = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    try {
      const entry = JSON.parse(chunk.toString());
      for (const listener of logEventListeners) {
        listener(entry);
      }
    } catch {
      /* ignore parse errors */
    }
    callback();
  },
});

const isDev = process.env.NODE_ENV !== "production";

// In dev mode, pipe through pino-pretty for human-readable output
function createStdoutStream(): NodeJS.WritableStream {
  if (isDev) {
    try {
      const pinoPretty = require("pino-pretty") as (opts: Record<string, unknown>) => NodeJS.WritableStream;
      return pinoPretty({ colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" });
    } catch {
      // pino-pretty not available, fall back to raw JSON
    }
  }
  return process.stdout;
}

export const logger = pino(
  {
    level: BASE_LEVEL,
    timestamp: pino.stdTimeFunctions.epochTime,
    formatters: {
      level: (label) => ({ level: label }),
      bindings: (bindings) => ({
        component: bindings.name,
      }),
    },
    serializers: {
      error: pino.stdSerializers.err,
    },
  },
  pino.multistream([
    { stream: createStdoutStream() },
    { stream: broadcastStream },
  ]),
);

// Create child loggers for each component
const components: Record<LogComponent, pino.Logger> = {
  adam: logger.child({ name: "adam" }),
  manager: logger.child({ name: "manager" }),
  scheduler: logger.child({ name: "scheduler" }),
  api: logger.child({ name: "api" }),
  ws: logger.child({ name: "ws" }),
  cli: logger.child({ name: "cli" }),
  store: logger.child({ name: "store" }),
  embedding: logger.child({ name: "embedding" }),
  admin: logger.child({ name: "admin" }),
  agent: logger.child({ name: "agent" }),
  channels: logger.child({ name: "channels" }),
  "plugin-sync": logger.child({ name: "plugin-sync" }),
  watchdog: logger.child({ name: "watchdog" }),
  "chat-manager": logger.child({ name: "chat-manager" }),
  execution: logger.child({ name: "execution" }),
  "execution-pool": logger.child({ name: "execution-pool" }),
  "message-handler": logger.child({ name: "message-handler" }),
  "goal-manager": logger.child({ name: "goal-manager" }),
  "sandbox-macos": logger.child({ name: "sandbox-macos" }),
  "sandbox-linux": logger.child({ name: "sandbox-linux" }),
  sandbox: logger.child({ name: "sandbox" }),
  audit: logger.child({ name: "audit" }),
  config: logger.child({ name: "config" }),
  "event-dispatcher": logger.child({ name: "event-dispatcher" }),
  "context-compact": logger.child({ name: "context-compact" }),
  "workspace-watcher": logger.child({ name: "workspace-watcher" }),
  "memory-service": logger.child({ name: "memory-service" }),
};

export function getLogger(component: LogComponent): pino.Logger {
  return components[component] || logger;
}

// Set log level at runtime
export function setLogLevel(level: LogLevel): void {
  logger.level = level;
  for (const child of Object.values(components)) {
    child.level = level;
  }
}

// Get current log level
export function getLogLevel(): LogLevel {
  return logger.level as LogLevel;
}

// Component filter for external consumers
let componentFilter: LogComponent | null = null;

export function setComponentFilter(component: LogComponent | null): void {
  componentFilter = component;
}

export function getComponentFilter(): LogComponent | null {
  return componentFilter;
}
