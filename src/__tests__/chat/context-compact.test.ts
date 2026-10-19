/**
 * Unit tests for triggerAppCompact (src/chat/context-compact.ts).
 * Coverage:
 * - empty droppedThreads → no-op (no SDK call, no memory write)
 * - debounced (recent app_compact memory exists) → no SDK call
 * - happy path → SDK called, memory written with correct shape
 * - SDK failure → no throw, no memory write
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { mockCallClaude } = vi.hoisted(() => ({
  mockCallClaude: vi.fn(),
}));

const { cleanup } = setupTestDb();

// CRITICAL: mock store/db.js to redirect getDb() to the in-memory test DB.
// Without this, triggerAppCompact → isDebounced → getDb() opens ~/.adam/adam.db (production).
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../lib/llm-eval.js", () => ({
  callClaudeForEvaluation: mockCallClaude,
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    defaults: { model: "claude-sonnet-4-6" },
    anthropic: { smallFastModel: "claude-haiku-4-5-20251001" },
  })),
}));

vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe("triggerAppCompact", () => {
  beforeEach(() => {
    clearTestDb();
    vi.clearAllMocks();
  });

  afterAll(() => cleanup());

  it("is a no-op when droppedThreads is empty", async () => {
    const { triggerAppCompact } = await import("../../chat/context-compact.js");
    await triggerAppCompact("session-1", []);
    expect(mockCallClaude).not.toHaveBeenCalled();

    const count = getTestDb().prepare("SELECT COUNT(*) AS n FROM memories WHERE source_type = 'app_compact'").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("writes memory with correct shape on happy path", async () => {
    mockCallClaude.mockResolvedValue("Test summary of dropped threads.");
    const { triggerAppCompact } = await import("../../chat/context-compact.js");

    await triggerAppCompact("session-1", [
      { kind: "thread-drop", taskShortId: "abc123", closedAt: "10:00", resultSummary: "task X done" },
    ]);

    expect(mockCallClaude).toHaveBeenCalledOnce();
    const row = getTestDb().prepare("SELECT * FROM memories WHERE source_type = 'app_compact'").get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.role_id).toBe("role-chat-manager");
    expect(row.type).toBe("thought");
    expect(row.tier).toBe("working");
    expect(row.importance).toBe(4);
    expect(row.content).toContain("Test summary");
    expect(JSON.parse(row.keywords as string)).toEqual(["compaction", "context", "decisions"]);
  });

  it("debounces within 30-min window: skips when recent app_compact exists", async () => {
    // Pre-insert an app_compact memory 5 minutes ago
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    getTestDb().prepare(`
      INSERT INTO memories (id, role_id, type, content, keywords, importance, source_type, created_at, last_accessed, retrieved_count, tier)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("app-compact-old", "role-chat-manager", "thought", "old summary", JSON.stringify(["compaction"]), 4, "app_compact", fiveMinAgo, fiveMinAgo, 0, "working");

    const { triggerAppCompact } = await import("../../chat/context-compact.js");
    await triggerAppCompact("session-1", [
      { kind: "thread-drop", taskShortId: "abc123", closedAt: "10:00", resultSummary: "task X done" },
    ]);

    expect(mockCallClaude).not.toHaveBeenCalled();
    const count = getTestDb().prepare("SELECT COUNT(*) AS n FROM memories WHERE source_type = 'app_compact'").get() as { n: number };
    expect(count.n).toBe(1); // only the pre-existing one
  });

  it("does NOT debounce when last app_compact is older than 30 min", async () => {
    const fortyMinAgo = Date.now() - 40 * 60 * 1000;
    getTestDb().prepare(`
      INSERT INTO memories (id, role_id, type, content, keywords, importance, source_type, created_at, last_accessed, retrieved_count, tier)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("app-compact-old", "role-chat-manager", "thought", "old summary", JSON.stringify(["compaction"]), 4, "app_compact", fortyMinAgo, fortyMinAgo, 0, "working");

    mockCallClaude.mockResolvedValue("Fresh summary.");
    const { triggerAppCompact } = await import("../../chat/context-compact.js");
    await triggerAppCompact("session-1", [
      { kind: "thread-drop", taskShortId: "abc123", closedAt: "10:00", resultSummary: "task X done" },
    ]);

    expect(mockCallClaude).toHaveBeenCalledOnce();
    const count = getTestDb().prepare("SELECT COUNT(*) AS n FROM memories WHERE source_type = 'app_compact'").get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("swallows SDK errors (non-fatal): no throw, no memory write", async () => {
    mockCallClaude.mockRejectedValue(new Error("SDK down"));
    const { triggerAppCompact } = await import("../../chat/context-compact.js");

    await expect(triggerAppCompact("session-1", [
      { kind: "thread-drop", taskShortId: "abc123", closedAt: "10:00", resultSummary: "task X done" },
    ])).resolves.not.toThrow();

    const count = getTestDb().prepare("SELECT COUNT(*) AS n FROM memories WHERE source_type = 'app_compact'").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("skips memory write when summarize returns empty string", async () => {
    mockCallClaude.mockResolvedValue("   ");
    const { triggerAppCompact } = await import("../../chat/context-compact.js");

    await triggerAppCompact("session-1", [
      { kind: "thread-drop", taskShortId: "abc123", closedAt: "10:00", resultSummary: "task X done" },
    ]);

    expect(mockCallClaude).toHaveBeenCalledOnce();
    const count = getTestDb().prepare("SELECT COUNT(*) AS n FROM memories WHERE source_type = 'app_compact'").get() as { n: number };
    expect(count.n).toBe(0);
  });
});
