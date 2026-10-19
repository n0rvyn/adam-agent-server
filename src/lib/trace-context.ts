/**
 * Trace context — propagates a single trace_id across the async call chain.
 *
 * Generated at chat-message ingress (handleChatMessage), persisted on every
 * downstream row (tasks/step_logs/delivery_log/evolution_audit/chat_messages),
 * and recoverable from anywhere in the call chain via `getCurrentTraceId()`.
 *
 * Uses Node's AsyncLocalStorage (in-process; survives `await` and Promise chains;
 * does NOT cross IPC or worker boundaries).
 *
 * Fallback: if no context is set (e.g., scheduled task created outside chat),
 * `getCurrentTraceId()` returns undefined and the row's trace_id stays NULL.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { v4 as uuidv4 } from "uuid";

interface TraceStore {
  traceId: string;
  /** Where the trace originated — chat | webhook | template | manual */
  origin: "chat" | "webhook" | "template" | "manual" | "unknown";
}

const traceStorage = new AsyncLocalStorage<TraceStore>();

/** Generate a fresh trace ID and run `fn` inside its context. */
export function withNewTrace<T>(origin: TraceStore["origin"], fn: () => T): T {
  return traceStorage.run({ traceId: uuidv4(), origin }, fn);
}

/** Run `fn` inside an explicitly-provided trace context (for resume / cross-process). */
export function withTrace<T>(traceId: string, origin: TraceStore["origin"], fn: () => T): T {
  return traceStorage.run({ traceId, origin }, fn);
}

/** Get the current trace ID if any. Returns undefined when called outside any trace context. */
export function getCurrentTraceId(): string | undefined {
  return traceStorage.getStore()?.traceId;
}

/** Get the full trace store (for logging origin alongside id). */
export function getTraceStore(): TraceStore | undefined {
  return traceStorage.getStore();
}
