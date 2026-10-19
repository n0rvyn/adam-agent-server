/**
 * Task 6-tests: buildSessionContext seed/delta split tests.
 *
 * Expected initial state (before Task 6-impl):
 * FAILS because `mode:'seed'` and `mode:'delta'` are not yet implemented —
 * the function currently ignores the `mode` field and always emits the full
 * conversation dump regardless.
 *
 * After Task 6-impl + the resume-continuity fix:
 * - seed mode: emits a [前情提要] marker + a BOUNDED REPLAY of the prior conversation +
 *   [Relevant memories] + [Open prompts]. The replay is required because streaming-mode SDK
 *   sessions are not resumable from disk — replaying chat_messages into the first turn is the
 *   only way a cold-started subprocess recovers continuity after a restart/eviction.
 * - delta mode: emits [Open prompts] + recent deliveries + [Relevant memories] but does NOT
 *   include the [Free conversation] or [Session metadata] transcript dump (the live in-memory
 *   SDK transcript already holds it within a session's lifetime).
 *
 * Contract:
 * - Seed = [前情提要] marker + bounded conversation replay + top-K memories + open prompts.
 * - Delta is "non-transcript context only" — deliberately EXCLUDES the verbatim conversation
 *   lines that the live in-memory SDK transcript already contains within one session lifetime.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockQueryMemoryByTier, mockApplyTruncation } = vi.hoisted(() => ({
  mockQueryMemoryByTier: vi.fn(),
  mockApplyTruncation: vi.fn(),
}));

vi.mock("../../store/messages.js", () => ({
  getAllMessagesBySession: vi.fn(() => []),
  getRecentMessages: vi.fn(() => []),
  getMessage: vi.fn(),
}));

vi.mock("../../store/pending-prompts.js", () => ({
  listOpenPromptsBySession: vi.fn(() => [
    {
      id: "prompt-001",
      shape: "confirm",
      messageId: "msg-001",
      askedAt: Date.now() - 60_000,
      sessionId: "test-session",
    },
  ]),
  getPendingPrompt: vi.fn(),
}));

vi.mock("../../agent/memory-service.js", () => ({
  queryMemoryByTier: mockQueryMemoryByTier,
}));

vi.mock("../../config/index.js", () => ({
  getChatConfig: vi.fn(() => ({
    contextBudgetTokens: 20000,
    maxSessionTurns: 20,
    sessionTimeoutMinutes: 30,
  })),
}));

vi.mock("../../chat/context-thread-grouper.js", () => ({
  groupEnvelopesByThread: vi.fn(() => ({ freeConversation: [], threads: [] })),
}));

vi.mock("../../chat/context-truncation.js", async (orig) => {
  const actual = await orig<typeof import("../../chat/context-truncation.js")>();
  return {
    ...actual,
    applyTruncation: mockApplyTruncation,
  };
});

vi.mock("../../chat/recent-delivery-context.js", () => ({
  getRecentDeliveryContextItems: vi.fn(() => [
    { id: "del-001", content: "播客已发布" },
  ]),
  renderRecentDeliveryContext: vi.fn((_items: unknown[], _count: number) =>
    _items && (_items as unknown[]).length > 0 ? "[Recent deliveries]\n- 播客已发布" : ""
  ),
}));

vi.mock("../../chat/context-compact.js", () => ({
  triggerAppCompact: vi.fn(),
}));

vi.mock("../../chat/context-attachment-resolver.js", () => ({
  resolveAttachmentExcerpt: vi.fn(async () => undefined),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildSessionContext — seed/delta mode split (Task 6-tests)", () => {
  const SESSION_ID = "test-session-001";
  const CURRENT_MESSAGE = "What happened today?";

  beforeEach(() => {
    vi.clearAllMocks();

    // Default truncation mock: some free conversation + no dropped threads
    mockApplyTruncation.mockReturnValue({
      freeConversation: [
        {
          id: "msg-001",
          sessionId: SESSION_ID,
          role: "user",
          content: "Hello from yesterday",
          source: { type: "web" },
          createdAt: Date.now() - 86_400_000,
        },
        {
          id: "msg-002",
          sessionId: SESSION_ID,
          role: "assistant",
          content: "Hi! I remember our chat about Swift models.",
          source: { type: "web" },
          createdAt: Date.now() - 86_300_000,
        },
      ],
      threads: [],
      droppedThreads: [],
      recentDeliveries: [{ id: "del-001", content: "播客已发布" }],
      omittedRecentDeliveryCount: 0,
    });

    mockQueryMemoryByTier.mockResolvedValue([
      {
        id: "mem-001",
        content: "User prefers early morning summaries",
        importance: 0.8,
        tier: "semantic",
      },
      {
        id: "mem-002",
        content: "Current project: Adam Personal OS",
        importance: 0.9,
        tier: "working",
      },
    ]);
  });

  /**
   * Seed mode: MUST include a [前情提要] / [Session recap] marker.
   * This is the compact "impression" — the live session needs to know prior context
   * without having the full conversation re-dumped into it.
   *
   * FAILS pre-impl: current code ignores mode, outputs full [Free conversation] instead of recap.
   */
  it("seed mode: includes [前情提要] recap marker (not verbatim free conversation)", async () => {
    const { buildSessionContext } = await import("../../chat/context-builder.js");

    const result = await buildSessionContext(SESSION_ID, CURRENT_MESSAGE, {
      mode: "seed",
    });

    // Seed MUST include a recap marker — either Chinese or English form
    const hasRecapMarker =
      result.includes("[前情提要]") ||
      result.includes("[Session recap]") ||
      result.includes("[Prior context recap]") ||
      result.includes("[Session Summary]");

    // FAILS pre-impl: the current code doesn't emit a recap marker
    expect(hasRecapMarker).toBe(true);
  });

  /**
   * Seed mode: MUST include [Relevant memories] (top-K recall, per DP-002=A).
   *
   * FAILS pre-impl: this assertion may pass since the current code already queries memories,
   * but combined with the recap marker assertion above the overall test is red.
   */
  it("seed mode: includes top-K [Relevant memories] section", async () => {
    const { buildSessionContext } = await import("../../chat/context-builder.js");

    const result = await buildSessionContext(SESSION_ID, CURRENT_MESSAGE, {
      mode: "seed",
    });

    expect(result).toContain("[Relevant memories");
    expect(result).toContain("User prefers early morning summaries");
  });

  /**
   * Seed mode: MUST include [Open prompts] (per DP-002=A — open prompts carry continuity).
   */
  it("seed mode: includes [Open prompts] section", async () => {
    const { buildSessionContext } = await import("../../chat/context-builder.js");

    const result = await buildSessionContext(SESSION_ID, CURRENT_MESSAGE, {
      mode: "seed",
    });

    expect(result).toContain("[Open prompts]");
  });

  /**
   * Seed mode: MUST replay the prior conversation turn-by-turn (resume-continuity fix).
   * Streaming-mode SDK sessions are not resumable from disk, so a cold-started subprocess
   * has NO memory of earlier turns — the seed replay is the only thing that restores it.
   */
  it("seed mode: replays the prior conversation turns (resume-continuity)", async () => {
    const { getAllMessagesBySession } = await import("../../store/messages.js");
    // Make the session have prior history so the replay branch triggers.
    (getAllMessagesBySession as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "msg-001", sessionId: SESSION_ID, role: "user", content: "Hello from yesterday", source: { type: "web" }, createdAt: Date.now() - 86_400_000 },
      { id: "msg-002", sessionId: SESSION_ID, role: "assistant", content: "Hi! I remember our chat about Swift models.", source: { type: "web" }, createdAt: Date.now() - 86_300_000 },
    ]);

    const { buildSessionContext } = await import("../../chat/context-builder.js");
    const result = await buildSessionContext(SESSION_ID, CURRENT_MESSAGE, { mode: "seed" });

    // The prior turns ARE replayed verbatim (bounded by the token budget via applyTruncation).
    expect(result).toContain("Hello from yesterday");
    expect(result).toContain("Hi! I remember our chat about Swift models");
    // Under the [前情提要] marker, not the legacy [Free conversation] / [Session metadata] header.
    expect(result).toContain("[前情提要]");
    expect(result).not.toContain("[Session metadata]");
  });

  /**
   * Delta mode: MUST include [Open prompts] (needed per turn so model tracks open decisions).
   */
  it("delta mode: includes [Open prompts] section", async () => {
    const { buildSessionContext } = await import("../../chat/context-builder.js");

    const result = await buildSessionContext(SESSION_ID, CURRENT_MESSAGE, {
      mode: "delta",
    });

    expect(result).toContain("[Open prompts]");
  });

  /**
   * Delta mode: MUST include recent deliveries if present.
   */
  it("delta mode: includes [Recent deliveries] when available", async () => {
    const { buildSessionContext } = await import("../../chat/context-builder.js");

    const result = await buildSessionContext(SESSION_ID, CURRENT_MESSAGE, {
      mode: "delta",
    });

    expect(result).toContain("[Recent deliveries]");
  });

  /**
   * Delta mode: MUST include [Relevant memories] (fresh per-turn recall).
   */
  it("delta mode: includes [Relevant memories] section", async () => {
    const { buildSessionContext } = await import("../../chat/context-builder.js");

    const result = await buildSessionContext(SESSION_ID, CURRENT_MESSAGE, {
      mode: "delta",
    });

    expect(result).toContain("[Relevant memories");
  });

  /**
   * Delta mode: MUST NOT include the verbatim [Free conversation] block.
   * The live SDK process already has the in-memory transcript; repeating it inflates context.
   *
   * FAILS pre-impl: current code emits [Free conversation] unconditionally.
   */
  it("delta mode: does NOT include [Free conversation] transcript dump", async () => {
    const { buildSessionContext } = await import("../../chat/context-builder.js");

    const result = await buildSessionContext(SESSION_ID, CURRENT_MESSAGE, {
      mode: "delta",
    });

    // FAILS pre-impl: current code outputs [Free conversation] regardless of mode
    expect(result).not.toContain("[Free conversation]");
    expect(result).not.toContain("Hello from yesterday");
  });

  /**
   * Delta mode: MUST NOT include [Session metadata] conversation-window header.
   * The session window stat is only meaningful for seed (a fresh process needs orientation).
   *
   * FAILS pre-impl: current code emits [Session metadata] unconditionally.
   */
  it("delta mode: does NOT include [Session metadata] block", async () => {
    const { buildSessionContext } = await import("../../chat/context-builder.js");

    const result = await buildSessionContext(SESSION_ID, CURRENT_MESSAGE, {
      mode: "delta",
    });

    // FAILS pre-impl
    expect(result).not.toContain("[Session metadata]");
  });

  /**
   * Default (no mode): legacy behavior unchanged — still emits [Session metadata] + [Free conversation].
   * This is the regression shield for existing callers (context-builder.test.ts, etc.).
   */
  it("default (no mode): still emits [Session metadata] and [Free conversation] (regression shield)", async () => {
    // Set up freeConversation to be non-empty so [Free conversation] renders
    mockApplyTruncation.mockReturnValueOnce({
      freeConversation: [
        {
          id: "msg-x",
          sessionId: SESSION_ID,
          role: "user",
          content: "legacy message",
          source: { type: "web" },
          createdAt: Date.now() - 1000,
        },
      ],
      threads: [],
      droppedThreads: [],
      recentDeliveries: [],
      omittedRecentDeliveryCount: 0,
    });

    const { buildSessionContext } = await import("../../chat/context-builder.js");

    const result = await buildSessionContext(SESSION_ID, CURRENT_MESSAGE);

    // Legacy default behavior — these sections always present
    expect(result).toContain("[Session metadata]");
    expect(result).toContain("[Free conversation]");
  });
});
