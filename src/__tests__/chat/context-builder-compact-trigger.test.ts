/**
 * Unit tests for buildSessionContext app-compact trigger wiring (Task 6).
 * Verifies triggerAppCompact fires iff applyTruncation produced droppedThreads.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockTrigger, mockApplyTruncation } = vi.hoisted(() => ({
  mockTrigger: vi.fn(),
  mockApplyTruncation: vi.fn(),
}));

vi.mock("../../chat/context-compact.js", () => ({
  triggerAppCompact: mockTrigger,
}));

vi.mock("../../chat/context-truncation.js", async (orig) => {
  const actual = await orig<typeof import("../../chat/context-truncation.js")>();
  return { ...actual, applyTruncation: mockApplyTruncation };
});

vi.mock("../../store/messages.js", () => ({
  getAllMessagesBySession: vi.fn(() => []),
  getRecentMessages: vi.fn(() => []),
  getMessage: vi.fn(),
}));

vi.mock("../../store/pending-prompts.js", () => ({
  listOpenPromptsBySession: vi.fn(() => []),
  getPendingPrompt: vi.fn(),
}));

vi.mock("../../agent/memory-service.js", () => ({
  queryMemoryByTier: vi.fn(async () => []),
}));

vi.mock("../../config/index.js", () => ({
  getChatConfig: vi.fn(() => ({ contextBudgetTokens: 20000, maxSessionTurns: 20 })),
}));

vi.mock("../../chat/context-thread-grouper.js", () => ({
  groupEnvelopesByThread: vi.fn(() => ({ freeConversation: [], threads: [] })),
}));

vi.mock("../../chat/recent-delivery-context.ts", () => ({
  getRecentDeliveryContextItems: vi.fn(() => []),
  renderRecentDeliveryContext: vi.fn(() => ""),
}));

vi.mock("../../chat/context-attachment-resolver.js", () => ({
  resolveAttachmentExcerpt: vi.fn(async () => undefined),
}));

describe("buildSessionContext → app-compact trigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires triggerAppCompact when applyTruncation drops threads", async () => {
    mockApplyTruncation.mockReturnValue({
      freeConversation: [],
      threads: [],
      droppedThreads: [
        { kind: "thread-drop", taskShortId: "abc123", closedAt: "10:00", resultSummary: "X done" },
      ],
      recentDeliveries: [],
      omittedRecentDeliveryCount: 0,
    });

    const { buildSessionContext } = await import("../../chat/context-builder.js");
    await buildSessionContext("session-1", "hello");

    expect(mockTrigger).toHaveBeenCalledOnce();
    expect(mockTrigger).toHaveBeenCalledWith("session-1", expect.arrayContaining([
      expect.objectContaining({ taskShortId: "abc123" }),
    ]));
  });

  it("does NOT fire when droppedThreads is empty", async () => {
    mockApplyTruncation.mockReturnValue({
      freeConversation: [],
      threads: [],
      droppedThreads: [],
      recentDeliveries: [],
      omittedRecentDeliveryCount: 0,
    });

    const { buildSessionContext } = await import("../../chat/context-builder.js");
    await buildSessionContext("session-1", "hello");

    expect(mockTrigger).not.toHaveBeenCalled();
  });
});
