/**
 * LiveSession — one long-lived streaming Claude Code process per active chat session.
 *
 * Architecture (活法二):
 * - `query({prompt: AsyncIterable<SDKUserMessage>})` runs once for the lifetime of the session.
 * - `push(content, opts)` enqueues an SDKUserMessage into the input stream.
 *   When `shouldQuery !== false` (default), push returns a Promise that resolves with the
 *   next SDKResultMessage fields ({text, cost, numTurns, sdkSessionId}).
 * - A single reader loop consumes SDK messages and routes each SDKResultMessage to the
 *   pending turn promise (serialized: one in-flight turn at a time).
 * - Per-turn 6-min inactivity guard: if no result arrives within INACTIVITY_MS, the turn
 *   promise is rejected. The timeout handle is cleared on every SDK event to avoid leaks
 *   (per project_adam_inactivity_loop_timer_leak lesson).
 * - `end()` closes the input stream and rejects any pending turn.
 */

import type { SDKUserMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { getLogger } from "../lib/logger.js";
import { recomputeCost, type CostRecompute, type ModelUsageEntry } from "../lib/cost-pricing.js";
import { getRuntimeConfig } from "../config/runtime.js";
import type { ChatSource, CapturedDispatch } from "../shared/types.js";
import type { createAdamTools } from "./adam-tools.js";
import type { buildSessionHooks } from "./hooks.js";

const log = getLogger("chat-manager");

const INACTIVITY_MS = 360_000; // 6 minutes (matches execution-manager.ts constant)

export interface LiveSessionResult {
  text: string;
  cost?: CostRecompute;
  numTurns?: number;
  sdkSessionId?: string;
}

export type QueryFn = (prompt: AsyncIterable<SDKUserMessage>) => AsyncIterable<SDKMessage>;

export interface LiveSessionOptions {
  /** The SDK `query` function (or a mock in tests). */
  query: QueryFn;
  /** Optional callback fired when the session ends (error or close). */
  onEnd?: (err?: Error) => void;
  /**
   * AbortController wired into the SDK `query()` so a wedged subprocess can be killed.
   * On an inactivity timeout the session aborts this, which tears down the streaming
   * subprocess (the 100%-CPU spinner) and unblocks the reader loop. Owners pass the SAME
   * controller they passed into `query({ options: { abortController } })`.
   */
  abortController?: AbortController;
  /**
   * Per-session context binding (Task 4-impl).
   * Each LiveSession is bound to exactly one chat session for its entire life,
   * so these are CONSTANT — no per-turn threading needed.
   */
  chatSessionId?: string;
  source?: ChatSource;
  /**
   * Per-session adam-tools instance whose closures capture the constant
   * chatSessionId/source above (not a shared mutable field on ChatManager).
   */
  adamToolsInstance?: ReturnType<typeof createAdamTools>;
  /**
   * Per-session hooks built at LiveSession construction time.
   */
  cachedHooks?: ReturnType<typeof buildSessionHooks>;
  /**
   * Per-session dispatches array. Populated by onTaskDispatched closure in adamToolsInstance.
   * Exposed to ChatManager so it can read dispatches after each turn.
   */
  dispatches?: CapturedDispatch[];
  /**
   * Shared holder object whose `.id` field dispatchTurn writes with the in-flight turn's
   * traceId. The same object reference must be passed to `createAdamTools` and
   * `buildSessionHooks` so the traced-tool-wrapper and PostToolUse hook read it.
   */
  turnTraceHolder?: { id: string | undefined };
}

/**
 * A pushable async iterable (internal queue + single resolver) used as the `prompt`
 * argument to `query()`.
 */
function makePushableIterable() {
  const queue: SDKUserMessage[] = [];
  let pendingResolve: (() => void) | undefined;
  let closed = false;

  async function* gen(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (closed) return;
      await new Promise<void>((r) => { pendingResolve = r; });
      pendingResolve = undefined;
    }
  }

  function push(msg: SDKUserMessage): void {
    if (closed) return;
    queue.push(msg);
    pendingResolve?.();
  }

  function close(): void {
    closed = true;
    pendingResolve?.();
  }

  return { gen, push, close };
}

export class LiveSession {
  private inputStream = makePushableIterable();
  private pendingTurnResolve: ((result: LiveSessionResult) => void) | undefined;
  private pendingTurnReject: ((err: Error) => void) | undefined;
  /** Queue of turns awaiting the in-flight turn to finish. */
  private turnQueue: Array<{
    content: string;
    traceId?: string;
    resolve: (result: LiveSessionResult) => void;
    reject: (err: Error) => void;
  }> = [];
  /** The traceId of the currently in-flight turn. Cleared when the turn finishes. */
  private currentTurnTraceId?: string;
  private inFlightTurn = false;
  private ended = false;
  /** Why this session ended (set wherever `ended` becomes true); surfaced in the push() error. */
  private endReason: string | undefined;
  /** Wall-clock timestamp when the current in-flight turn was dispatched. Undefined when idle. */
  private turnStartedAt: number | undefined = undefined;

  /** Returns true when a turn is currently in flight (awaiting a model response). */
  get isInFlight(): boolean { return this.inFlightTurn; }

  /**
   * Returns true when a turn is in flight AND has been in flight for longer than staleMs.
   * Used by the watchdog to identify stuck sessions (Task 8-impl).
   * A fresh in-flight turn is NOT stale — avoid restarting active users mid-response.
   */
  isStale(staleMs: number): boolean {
    return this.inFlightTurn && this.turnStartedAt !== undefined && Date.now() - this.turnStartedAt > staleMs;
  }
  private inactivityHandle: ReturnType<typeof setTimeout> | undefined;
  private readonly onEnd?: (err?: Error) => void;
  private readonly abortController?: AbortController;
  /** Guards onEnd against double-firing (timeout teardown + reader-loop exit). */
  private endNotified = false;
  /**
   * The live SDK message iterator. Captured so teardown can call `.return()` to force the
   * reader loop to exit — abort alone is not guaranteed to unblock a `for await`/`next()`
   * pending on a wedged subprocess (mirrors execution-manager.ts force-close).
   */
  private pendingIterator?: AsyncIterator<SDKMessage>;
  /**
   * One-shot session seed (recap/context) folded into the FIRST dispatched turn's prompt.
   * The streaming SDK answers every input user-message as a real turn, so a seed pushed as
   * a separate message produced a phantom empty `result` that desynced turn↔reply
   * correlation (#265). Staging it here and prepending to the first turn keeps the seed
   * out of the SDK's turn stream.
   */
  private pendingSeed: string | undefined;

  /**
   * Optional holder object written by dispatchTurn so the per-session adam-tools
   * traced wrapper and PostToolUse hook can read the in-flight turn's traceId.
   * The holder is shared between LiveSession and the tool/hook instances built
   * alongside it; a plain object reference avoids closure capture issues.
   */
  private readonly turnTraceHolder?: { id: string | undefined };

  /**
   * Per-session constant context binding (Task 4-impl).
   * These are bound at construction and never change — a LiveSession maps
   * 1-to-1 with a chat session for its entire lifetime.
   */
  readonly chatSessionId?: string;
  readonly source?: ChatSource;
  readonly adamToolsInstance?: ReturnType<typeof createAdamTools>;
  readonly cachedHooks?: ReturnType<typeof buildSessionHooks>;
  /** Per-session dispatches: populated by the onTaskDispatched closure in adamToolsInstance. */
  readonly dispatches: CapturedDispatch[];

  constructor(opts: LiveSessionOptions) {
    this.onEnd = opts.onEnd;
    this.abortController = opts.abortController;
    this.chatSessionId = opts.chatSessionId;
    this.source = opts.source;
    this.adamToolsInstance = opts.adamToolsInstance;
    this.cachedHooks = opts.cachedHooks;
    this.dispatches = opts.dispatches ?? [];
    this.turnTraceHolder = opts.turnTraceHolder;
    // Start the reader loop asynchronously.
    // Errors are routed to the pending turn promise inside startReaderLoop;
    // we suppress the top-level unhandled rejection here.
    this.startReaderLoop(opts.query).catch(() => {});
  }

  /** Returns the traceId of the currently in-flight turn, or undefined when idle. */
  getCurrentTurnTraceId(): string | undefined {
    return this.currentTurnTraceId;
  }

  /**
   * Push a user message into the live session's input stream and await the model's reply.
   *
   * Returns a Promise that resolves with the next SDKResultMessage fields when the model
   * responds. Turns are serialized: while one turn is in flight, subsequent pushes queue
   * behind it (one result event per user turn — see #265 for why seed/context injection
   * must NOT go through a separate push but be folded via {@link prependSeedToFirstTurn}).
   */
  push(content: string, traceId?: string): Promise<LiveSessionResult> {
    return new Promise<LiveSessionResult>((resolve, reject) => {
      if (this.ended) {
        reject(new Error(`LiveSession has ended (reason=${this.endReason ?? "unknown"})`));
        return;
      }

      if (this.inFlightTurn) {
        // Serialize: queue behind the current in-flight turn
        this.turnQueue.push({ content, traceId, resolve, reject });
        return;
      }

      this.dispatchTurn(content, resolve, reject, traceId);
    });
  }

  /**
   * Stage a one-shot seed (recap / context) to be prepended to the FIRST dispatched turn's
   * prompt. This replaces the old `push(seed, {shouldQuery:false})`, which the streaming SDK
   * answered as a real turn — emitting a phantom empty `result` that desynced turn↔reply
   * correlation (#265). The seed rides the first user turn's prompt instead, so the SDK sees
   * exactly one input message per turn. No-op for empty/blank seeds. Idempotent until consumed.
   */
  prependSeedToFirstTurn(seed: string): void {
    if (seed && seed.trim()) this.pendingSeed = seed;
  }

  /** Close the live session: reject pending/queued turns, then tear down the subprocess. */
  end(): void {
    if (this.ended) return;
    // Same teardown pair the inactivity-timeout path uses: fail the in-flight turn (+ drain
    // the queue), then shut down (close input, abort + return the subprocess, notify owner).
    this.failTurn(new Error("LiveSession ended"));
    this.shutdown();
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private dispatchTurn(
    content: string,
    resolve: (result: LiveSessionResult) => void,
    reject: (err: Error) => void,
    traceId?: string,
  ): void {
    this.inFlightTurn = true;
    this.turnStartedAt = Date.now();
    this.pendingTurnResolve = resolve;
    this.pendingTurnReject = reject;

    // Record the per-turn trace so the traced-tool-wrapper and PostToolUse hook
    // can attribute tool calls and mutation receipts to this turn (not the frozen ctor-trace).
    this.currentTurnTraceId = traceId;
    if (this.turnTraceHolder) {
      this.turnTraceHolder.id = traceId;
    }

    // Fold a staged session seed into the FIRST dispatched turn's prompt (#265). The seed
    // rides this turn's content so the SDK sees one input message per turn — no phantom result.
    let promptContent = content;
    if (this.pendingSeed) {
      promptContent = `${this.pendingSeed}\n\n${content}`;
      this.pendingSeed = undefined;
    }

    // Push the user message into the input stream
    this.inputStream.push({
      type: "user",
      message: { role: "user", content: promptContent },
      parent_tool_use_id: null,
    });

    // Start per-turn inactivity guard
    this.resetInactivityTimer();
  }

  private finishTurn(result: LiveSessionResult): void {
    const resolve = this.pendingTurnResolve;
    this.pendingTurnResolve = undefined;
    this.pendingTurnReject = undefined;
    this.inFlightTurn = false;
    this.turnStartedAt = undefined;
    this.currentTurnTraceId = undefined;
    if (this.turnTraceHolder) this.turnTraceHolder.id = undefined;
    this.clearInactivityTimer();

    resolve?.(result);

    // Dispatch next queued turn if any
    const next = this.turnQueue.shift();
    if (next) {
      this.dispatchTurn(next.content, next.resolve, next.reject, next.traceId);
    }
  }

  private failTurn(err: Error): void {
    const reject = this.pendingTurnReject;
    this.pendingTurnResolve = undefined;
    this.pendingTurnReject = undefined;
    this.inFlightTurn = false;
    this.turnStartedAt = undefined;
    this.currentTurnTraceId = undefined;
    if (this.turnTraceHolder) this.turnTraceHolder.id = undefined;
    this.clearInactivityTimer();

    reject?.(err);

    // Drain the remaining queue
    for (const item of this.turnQueue) {
      item.reject(err);
    }
    this.turnQueue = [];
  }

  private resetInactivityTimer(): void {
    this.clearInactivityTimer();
    this.inactivityHandle = setTimeout(() => {
      this.inactivityHandle = undefined;
      log.warn({ inactivityMs: INACTIVITY_MS }, "LiveSession: per-turn inactivity timeout");
      const err = new Error("LiveSession inactivity timeout");
      // Self-heal: a 6-min silence means the streaming subprocess is wedged (no events
      // reset the timer). Rejecting the turn alone leaves the subprocess spinning at 100%
      // CPU and the session live in the owner's map, so every subsequent message reuses the
      // dead session and re-times-out for hours. Tear the whole session down instead: reject
      // the turn, abort the subprocess, close input, and notify the owner to evict us so the
      // next message spawns a fresh session.
      this.failTurn(err);
      this.shutdown(err);
    }, INACTIVITY_MS);
  }

  /**
   * Tear down the session: mark ended, abort the SDK subprocess, close the input stream,
   * and notify the owner exactly once. Safe to call multiple times and from either the
   * inactivity-timeout path or the reader-loop exit path.
   */
  private shutdown(err?: Error): void {
    this.endReason ??= `shutdown${err ? ":" + err.message : ""}`;
    this.ended = true;
    this.clearInactivityTimer();
    try { this.inputStream.close(); } catch { /* already closed */ }
    try { this.abortController?.abort(); } catch { /* already aborted */ }
    // Force the reader loop to exit even if abort does not propagate to the SDK iterator.
    // Fire-and-forget: awaiting .return() could itself block on the wedged subprocess.
    void this.pendingIterator?.return?.(undefined).catch(() => {});
    this.notifyEnd(err);
  }

  /** Fire onEnd at most once (timeout teardown and reader-loop exit can race). */
  private notifyEnd(err?: Error): void {
    if (this.endNotified) return;
    this.endNotified = true;
    this.onEnd?.(err);
  }

  private clearInactivityTimer(): void {
    if (this.inactivityHandle !== undefined) {
      clearTimeout(this.inactivityHandle);
      this.inactivityHandle = undefined;
    }
  }

  private async startReaderLoop(queryFn: QueryFn): Promise<void> {
    try {
      const msgStream = queryFn(this.inputStream.gen());
      const iterator = msgStream[Symbol.asyncIterator]();
      this.pendingIterator = iterator;

      while (true) {
        const { done, value: msg } = await iterator.next();
        if (done) break;
        // Reset inactivity timer on every event (only when a turn is in flight)
        if (this.inFlightTurn) {
          this.resetInactivityTimer();
        }

        if (msg.type === "result") {
          const resultMsg = msg as {
            type: "result";
            result?: string;
            session_id?: string;
            num_turns?: number;
            total_cost_usd?: number;
            modelUsage?: Record<string, ModelUsageEntry>;
            is_error?: boolean;
          };

          let cost: CostRecompute | undefined;
          if (resultMsg.modelUsage && Object.keys(resultMsg.modelUsage).length > 0) {
            try {
              const priceTable = getRuntimeConfig().pricing?.models ?? {};
              cost = recomputeCost(
                resultMsg.modelUsage,
                priceTable,
                typeof resultMsg.total_cost_usd === "number" ? resultMsg.total_cost_usd : undefined,
              );
            } catch {
              // getRuntimeConfig() throws if not initialized (e.g., in tests without initRuntimeConfig)
              // Fall back to a basic cost object using the SDK-reported value
              if (typeof resultMsg.total_cost_usd === "number") {
                cost = recomputeCost(resultMsg.modelUsage, {}, resultMsg.total_cost_usd);
              }
            }
          }

          this.finishTurn({
            text: resultMsg.result ?? "",
            cost,
            numTurns: typeof resultMsg.num_turns === "number" ? resultMsg.num_turns : undefined,
            sdkSessionId: resultMsg.session_id,
          });
        }
      }

      // Stream ended cleanly — if there's still a pending turn, fail it
      if (this.inFlightTurn) {
        this.failTurn(new Error("LiveSession stream ended without a result"));
      }

      // Mark as ended so getOrCreateLiveSession knows to create a new session
      this.endReason ??= "reader-clean-exit(done)";
      this.ended = true;
      this.clearInactivityTimer();
      this.notifyEnd();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.endReason ??= `reader-error:${error.message}`;
      log.debug({ err: error.message }, "LiveSession reader loop error");

      if (this.inFlightTurn) {
        this.failTurn(error);
      }

      // Drain queue
      for (const item of this.turnQueue) {
        item.reject(error);
      }
      this.turnQueue = [];

      this.ended = true;
      this.clearInactivityTimer();
      this.notifyEnd(error);
    }
  }
}
