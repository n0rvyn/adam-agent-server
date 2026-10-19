/**
 * Task 3-tests: LiveSession abstraction unit tests.
 *
 * These tests run BEFORE the implementation exists. Expected initial state:
 * FAILS with "Cannot find module '../../manager/live-session.js'" (red state).
 *
 * Contract verified:
 * 1. Single turn resolves with result text + cost fields from the result event.
 * 2. Two sequential turns over ONE query() call (query called exactly once).
 * 3. prependSeedToFirstTurn folds the seed into the FIRST turn's prompt (one input message
 *    per turn — no separate seed turn the SDK would answer with a phantom result, #265).
 * 4. end() closes the input stream and rejects any pending turn.
 * 5. Reader-loop error rejects the in-flight turn promise.
 * 6. Per-turn 6-min inactivity guard fires when no result arrives (fake timers).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// ─── Mock SDK query ───────────────────────────────────────────────────────────

/**
 * A controllable async iterable that lets tests push SDK messages.
 * Tests push messages via `push(msg)` and signal end via `end()` / `error(err)`.
 */
function makeControllableIterable() {
  const queue: (SDKMessage | { done: true } | { error: Error })[] = [];
  let resolve: (() => void) | undefined;

  async function* gen(): AsyncGenerator<SDKMessage> {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((r) => { resolve = r; });
        resolve = undefined;
      }
      const item = queue.shift()!;
      if ("done" in item) return;
      if ("error" in item) throw item.error;
      yield item;
    }
  }

  return {
    gen,
    push(msg: SDKMessage) {
      queue.push(msg);
      resolve?.();
    },
    end() {
      queue.push({ done: true });
      resolve?.();
    },
    error(err: Error) {
      queue.push({ error: err });
      resolve?.();
    },
  };
}

/** Build a minimal SDKResultSuccess-shaped event. */
function makeResultMsg(overrides: Partial<{
  result: string;
  session_id: string;
  num_turns: number;
  total_cost_usd: number;
  modelUsage: Record<string, unknown>;
}> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 100,
    duration_api_ms: 80,
    stop_reason: "end_turn",
    total_cost_usd: overrides.total_cost_usd ?? 0.001,
    num_turns: overrides.num_turns ?? 1,
    result: overrides.result ?? "hello",
    session_id: overrides.session_id ?? "sdk-sess-abc",
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use_input_tokens: 0 },
    modelUsage: overrides.modelUsage ?? { "claude-sonnet": { inputTokens: 10, outputTokens: 5 } },
    permission_denials: [],
    uuid: "00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
  } as unknown as SDKMessage;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// Import the module under test (will fail until impl exists).
import { LiveSession, type QueryFn } from "../../manager/live-session.js";

describe("LiveSession", () => {
  let querySpy: ReturnType<typeof vi.fn>;
  let iterable: ReturnType<typeof makeControllableIterable>;

  beforeEach(() => {
    iterable = makeControllableIterable();
    querySpy = vi.fn().mockReturnValue(iterable.gen());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── Case 1: single turn resolves with result text + cost ─────────────────

  it("single turn resolves with result text and cost fields", async () => {
    const session = new LiveSession({ query: querySpy as unknown as QueryFn });

    const pushPromise = session.push("hello there");

    // Give the reader loop microtasks time to start (advance just enough to process
    // async generator steps, but NOT the 6-min inactivity timer).
    await vi.advanceTimersByTimeAsync(10);

    // Emit result
    iterable.push(makeResultMsg({ result: "hi!", session_id: "sdk-sess-1", num_turns: 2, total_cost_usd: 0.005, modelUsage: { "claude": { inputTokens: 10, outputTokens: 5 } } }));
    iterable.end();

    await vi.advanceTimersByTimeAsync(10);

    const result = await pushPromise;

    expect(result.text).toBe("hi!");
    expect(result.sdkSessionId).toBe("sdk-sess-1");
    expect(result.numTurns).toBe(2);
    expect(result.cost).toBeDefined();
  });

  // ─── Case 2: two sequential turns reuse one query() call ─────────────────

  it("two sequential turns use ONE query() call (no re-spawn)", async () => {
    const iterable2 = makeControllableIterable();
    querySpy = vi.fn().mockReturnValue(iterable2.gen());
    const session = new LiveSession({ query: querySpy as unknown as QueryFn });

    // Turn 1
    const t1 = session.push("turn one");
    await vi.advanceTimersByTimeAsync(10);
    iterable2.push(makeResultMsg({ result: "resp one", session_id: "sess-x" }));
    await vi.advanceTimersByTimeAsync(10);

    const r1 = await t1;
    expect(r1.text).toBe("resp one");

    // Turn 2
    const t2 = session.push("turn two");
    await vi.advanceTimersByTimeAsync(10);
    iterable2.push(makeResultMsg({ result: "resp two", session_id: "sess-x" }));
    await vi.advanceTimersByTimeAsync(10);

    const r2 = await t2;
    expect(r2.text).toBe("resp two");

    // query() was called exactly once (one long-lived process)
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  // ─── Case 3: prependSeedToFirstTurn folds the seed into the first turn's prompt ───

  it("prependSeedToFirstTurn folds the seed into the FIRST turn's prompt, exactly once", async () => {
    const out = makeControllableIterable();
    const pushedContents: string[] = [];
    // The real SDK reads the prompt stream; capture each input message's content.
    const querySpyLocal = vi.fn((input: AsyncIterable<SDKUserMessage>) => {
      void (async () => {
        for await (const m of input) {
          pushedContents.push((m as unknown as { message: { content: string } }).message.content);
        }
      })();
      return out.gen();
    });
    const session = new LiveSession({ query: querySpyLocal as unknown as QueryFn });

    // Stage a seed BEFORE the first turn — it must ride the first turn's prompt, NOT a
    // separate input message (a separate message is a real SDK turn → phantom result, #265).
    session.prependSeedToFirstTurn("SEED-CONTEXT");

    // Turn 1
    const t1 = session.push("first question");
    await vi.advanceTimersByTimeAsync(10);
    out.push(makeResultMsg({ result: "answer one" }));
    await vi.advanceTimersByTimeAsync(10);
    expect((await t1).text).toBe("answer one");

    // Turn 2 (seed already consumed — must NOT reappear)
    const t2 = session.push("second question");
    await vi.advanceTimersByTimeAsync(10);
    out.push(makeResultMsg({ result: "answer two" }));
    await vi.advanceTimersByTimeAsync(10);
    expect((await t2).text).toBe("answer two");

    // Exactly one input message per turn — no separate seed message.
    expect(pushedContents).toHaveLength(2);
    // Seed folded into turn 1 only.
    expect(pushedContents[0]).toContain("SEED-CONTEXT");
    expect(pushedContents[0]).toContain("first question");
    expect(pushedContents[1]).toBe("second question");
    expect(pushedContents[1]).not.toContain("SEED-CONTEXT");
  });

  // ─── Case 3b: blank seed is a no-op (no accidental prefix) ─────────────────

  it("prependSeedToFirstTurn ignores an empty/blank seed", async () => {
    const out = makeControllableIterable();
    const pushedContents: string[] = [];
    const querySpyLocal = vi.fn((input: AsyncIterable<SDKUserMessage>) => {
      void (async () => {
        for await (const m of input) {
          pushedContents.push((m as unknown as { message: { content: string } }).message.content);
        }
      })();
      return out.gen();
    });
    const session = new LiveSession({ query: querySpyLocal as unknown as QueryFn });

    session.prependSeedToFirstTurn("   "); // blank → no-op

    const t1 = session.push("only question");
    await vi.advanceTimersByTimeAsync(10);
    out.push(makeResultMsg({ result: "ok" }));
    await vi.advanceTimersByTimeAsync(10);
    expect((await t1).text).toBe("ok");

    expect(pushedContents).toHaveLength(1);
    expect(pushedContents[0]).toBe("only question");
  });

  // ─── Case 4: end() closes input and rejects pending turn ─────────────────

  it("end() closes input and rejects any in-flight turn", async () => {
    const iterable4 = makeControllableIterable();
    querySpy = vi.fn().mockReturnValue(iterable4.gen());
    const session = new LiveSession({ query: querySpy as unknown as QueryFn });

    // Start a turn that will never get a result
    const pendingTurn = session.push("never answered");
    // Attach the rejection handler BEFORE triggering the reject (avoids an
    // unhandled-rejection window; in prod the caller awaits push() immediately).
    const assertion = expect(pendingTurn).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10);

    // End the session
    session.end();
    await vi.advanceTimersByTimeAsync(10);

    // The pending turn should reject
    await assertion;
  });

  // ─── Case 5: reader-loop error rejects in-flight turn ────────────────────

  it("reader-loop error rejects the in-flight turn promise", async () => {
    const iterable5 = makeControllableIterable();
    querySpy = vi.fn().mockReturnValue(iterable5.gen());
    const session = new LiveSession({ query: querySpy as unknown as QueryFn });

    const pendingTurn = session.push("will error");
    const assertion = expect(pendingTurn).rejects.toThrow("process died");
    await vi.advanceTimersByTimeAsync(10);

    // Inject an error into the iterator
    iterable5.error(new Error("process died"));
    await vi.advanceTimersByTimeAsync(10);

    await assertion;
  });

  // ─── Case 6: per-turn inactivity guard ───────────────────────────────────

  it("per-turn 6-min inactivity guard rejects when no result arrives", async () => {
    const iterable6 = makeControllableIterable();
    querySpy = vi.fn().mockReturnValue(iterable6.gen());
    const session = new LiveSession({ query: querySpy as unknown as QueryFn });

    const pendingTurn = session.push("will time out");
    // Handler attached before the inactivity timer fires (push() armed the timer synchronously).
    const assertion = expect(pendingTurn).rejects.toThrow(/inactivity|timeout/i);

    // Advance past 6 minutes to fire the inactivity guard.
    await vi.advanceTimersByTimeAsync(361_000);

    await assertion;
  });

  // ─── Case 7: inactivity timeout TEARS DOWN the session (self-heal) ────────────
  // Regression: a timed-out turn must abort the wedged subprocess, fire onEnd (so the
  // owner evicts the dead session), and mark the session ended — otherwise the same
  // poisoned LiveSession is reused for every subsequent message and chat stays dead
  // for hours. See fix-bug 2026-06-01.
  it("inactivity timeout aborts the query, returns the iterator, fires onEnd, and marks the session ended", async () => {
    const gen7 = makeControllableIterable().gen();
    // Spy on the iterator's return() — shutdown() must call it to force the reader loop to
    // exit even if abort does not propagate to the SDK iterator (zombie-loop prevention).
    const returnSpy = vi.spyOn(gen7, "return");
    querySpy = vi.fn().mockReturnValue(gen7);
    const abortController = new AbortController();
    const onEnd = vi.fn();
    const session = new LiveSession({
      query: querySpy as unknown as QueryFn,
      abortController,
      onEnd,
    });

    const pendingTurn = session.push("will wedge");
    const assertion = expect(pendingTurn).rejects.toThrow(/inactivity|timeout/i);

    // No event ever arrives → 6-min guard fires.
    await vi.advanceTimersByTimeAsync(361_000);
    await assertion;

    // Self-heal contract:
    // 1. the wedged subprocess is signalled to abort
    expect(abortController.signal.aborted).toBe(true);
    // 2. the reader loop is force-closed via iterator.return() (does not rely on abort
    //    propagating to the SDK async iterator)
    expect(returnSpy).toHaveBeenCalled();
    // 3. the owner is notified so it can drop the dead session from its map
    expect(onEnd).toHaveBeenCalledTimes(1);
    // 4. the session refuses further work (owner must recreate a fresh one)
    await expect(session.push("after timeout")).rejects.toThrow(/ended/i);
  });
});
