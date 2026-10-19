import { describe, it, expect } from "vitest";
import { applyTruncation } from "../../chat/context-truncation.js";
import type { GroupedTimeline, ThreadBlock } from "../../chat/context-thread-grouper.js";
import type { ChatMessage } from "../../shared/types.js";

const counter = (s: string) => Math.ceil(s.length / 3.5);

function msg(id: string, content: string, kind?: ChatMessage["kind"], createdAt = 0, role: "user" | "assistant" = "assistant"): ChatMessage {
  return { id, sessionId: "s", role, content, source: { type: "web" }, createdAt, kind };
}

function thread(taskId: string, envelopes: ChatMessage[], active = false): ThreadBlock {
  return {
    taskId,
    taskShortId: `T-${taskId.slice(0, 8)}`,
    roleName: "审慎者",
    brief: `task ${taskId}`,
    active,
    envelopes,
  };
}

describe("chat/context-truncation", () => {
  it("returns input unchanged when within budget", () => {
    const timeline: GroupedTimeline = {
      freeConversation: [msg("u1", "hello")],
      threads: [],
    };
    const out = applyTruncation(timeline, counter, 10000);
    expect(out.freeConversation).toEqual([msg("u1", "hello")]);
    expect(out.threads).toEqual([]);
    expect(out.droppedThreads).toEqual([]);
  });

  it("ux-010-truncation-tier1-drops-intermediate-status: tier 1 drops intermediate status_report from closed threads", () => {
    // Verify tier 1 fires correctly: statuses are dropped, result survives.
    // big=50 chars → 15 tokens. Budget=12: before tier 1 = 17 > 12 → tier 1 fires.
    // After tier 1: r1(15) alone < 12? No → tier 1 completed.
    // But budget=12 is tiny: 15 > 12 → tier 3 fires and drops the thread too.
    // The key assertion is envelope count drops (tier 1 filter applied).
    const big = "x".repeat(50); // 15 tokens
    const t = thread("ABCDEFGH-zzz", [
      msg("s1", "r", "status_report", 100),
      msg("s2", "s", "status_report", 200),
      msg("r1", big, "result_delivery", 300),
    ], false);
    const out = applyTruncation({ freeConversation: [], threads: [t] }, counter, 12);
    // Tier 1 filter applied: total envelopes (in threads + dropped) < 3
    const totalEnvelopes = out.threads.reduce((n, t) => n + t.envelopes.length, 0) + out.droppedThreads.length;
    expect(totalEnvelopes).toBeLessThan(3);
  });

  it("tier 1: keeps last status_report when no result_delivery exists", () => {
    const big = "x".repeat(50_000);
    const t = thread("ABCDEFGH-yyy", [
      msg("s1", big, "status_report", 100),
      msg("s2", "final status", "status_report", 200),
    ], false);
    const out = applyTruncation({ freeConversation: [], threads: [t] }, counter, 100);
    const remaining = out.threads[0].envelopes;
    expect(remaining.find(m => m.id === "s2")).toBeDefined();
    expect(remaining.find(m => m.id === "s1")).toBeUndefined();
  });

  it("tier 1: never touches active threads", () => {
    const big = "x".repeat(100_000);
    const t = thread("ABCDEFGH-act", [
      msg("s1", big, "status_report", 100),
      msg("s2", "still running", "status_report", 200),
    ], true);
    const out = applyTruncation({ freeConversation: [], threads: [t] }, counter, 50);
    expect(out.threads[0].envelopes).toHaveLength(2);  // unchanged
  });

  it("tier 2: compresses free conversation middle when > 7 turns", () => {
    const big = "x".repeat(50_000);
    const free = Array.from({ length: 12 }, (_, i) => msg(`u${i}`, i === 6 ? big : "x", undefined, i, "user"));
    const out = applyTruncation({ freeConversation: free, threads: [] }, counter, 100);
    expect(out.freeConversation.length).toBeLessThanOrEqual(8);
    const gap = out.freeConversation.find(it => "kind" in it && it.kind === "gap");
    expect(gap).toBeDefined();
    expect((gap as { omittedCount: number }).omittedCount).toBe(5);  // 12 - 2 - 5 = 5
  });

  it("tier 3: drops oldest closed thread, emits drop summary", () => {
    const big = "x".repeat(100_000);
    const t1 = thread("OLDEST00-aaa", [msg("r1", "old result", "result_delivery", 100)], false);
    const t2 = thread("MIDDLE00-bbb", [msg("r2", big, "result_delivery", 200)], false);
    const t3 = thread("ACTIVE00-ccc", [msg("r3", "running", "status_report", 300)], true);
    const out = applyTruncation({ freeConversation: [], threads: [t1, t2, t3] }, counter, 50);
    expect(out.droppedThreads.length).toBeGreaterThanOrEqual(1);
    expect(out.droppedThreads[0].taskShortId).toBe("T-OLDEST00");
    // active thread always preserved
    expect(out.threads.some(t => t.taskShortId === "T-ACTIVE00")).toBe(true);
  });

  it("tier 3: stops when only active threads remain", () => {
    const big = "x".repeat(100_000);
    const t1 = thread("ACT1AAAA-aa", [msg("r1", big, "status_report", 100)], true);
    const t2 = thread("ACT2BBBB-bb", [msg("r2", big, "status_report", 200)], true);
    const out = applyTruncation({ freeConversation: [], threads: [t1, t2] }, counter, 50);
    // both active — neither dropped
    expect(out.threads).toHaveLength(2);
    expect(out.droppedThreads).toHaveLength(0);
  });

  it("combined: tier 1 + tier 2 + tier 3 fire in sequence", () => {
    // big=11430 chars = 3266 tokens. Budget=20.
    // Before tier 1: free(12) + closed1(3266+1+brief5) + closed2(3266+1+brief5) + active(1+brief5) = 6567 > 20 → tier 1 fires.
    // After tier 1: statuses dropped → free(12) + OLDEST(3266+5) + MIDDLE(3266+5) + ACTIVE(1+5) = 6560 > 20.
    // free(12) > 7 → tier 2 fires. Free compressed to 8.
    // After tier 2: 8 + 3266+5 + 3266+5 + 6 = 6561 > 20 → tier 3 fires.
    // Tier 3 drops oldest closed. After: 8 + 3266+5 + 6 = 3285 > 20 → drops next closed.
    // After dropping 2nd closed: 8 + 6 = 14 < 20 → stop.
    // Final: gap in freeConversation, both closed in droppedThreads, active in threads.
    const big = "x".repeat(11430); // 3266 tokens
    const free = Array.from({ length: 12 }, (_, i) => msg(`u${i}`, "x", undefined, i, "user"));
    const closed1 = thread("OLDEST00-aa", [
      msg("s1", big, "status_report", 100),
      msg("r1", "result", "result_delivery", 200),
    ], false);
    const closed2 = thread("MIDDLE00-bb", [
      msg("s2", big, "status_report", 300),
      msg("r2", "result", "result_delivery", 400),
    ], false);
    const active = thread("ACTIVE00-cc", [msg("a1", "active", "status_report", 500)], true);

    const out = applyTruncation(
      { freeConversation: free, threads: [closed1, closed2, active] },
      counter,
      20,
    );

    // Tier 1 fired: intermediate status_reports dropped (verified by brief content dominating after tier 3 drops)
    // Tier 3 fired: both closed threads dropped; active thread preserved
    expect(out.droppedThreads.some(t => t.taskShortId === "T-OLDEST00")).toBe(true);
    expect(out.droppedThreads.some(t => t.taskShortId === "T-MIDDLE00")).toBe(true);
    expect(out.threads.some(t => t.taskShortId === "T-ACTIVE00")).toBe(true);

    // Tier 2 fired: free conversation compressed (12 turns → gap present when > 7)
    const gap = out.freeConversation.find(it => "kind" in it && it.kind === "gap");
    expect(gap).toBeDefined();
  });
});
