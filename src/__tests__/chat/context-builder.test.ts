import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
}));

vi.mock("../../config/index.js", () => ({
  getChatConfig: () => ({
    sessionTimeoutMinutes: 30,
    maxSessionTurns: 20,
    autoTitle: true,
    archiveExtractMemory: true,
    contextBudgetTokens: 20000,
  }),
  getDefaults: () => ({}),
  DEFAULT_CONFIG: { chat: { sessionTimeoutMinutes: 30, maxSessionTurns: 20, autoTitle: true, archiveExtractMemory: true, contextBudgetTokens: 20000 } },
}));

vi.mock("../../agent/memory-service.js", () => ({
  queryMemory: vi.fn().mockResolvedValue([]),
  queryMemoryByTier: vi.fn().mockResolvedValue([]),
}));

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

import { buildSessionContext, getSessionContextOnly, getMemoryContextOnly } from "../../chat/context-builder.js";
import { createSession } from "../../chat/session-manager.js";
import { _resetForTest } from "../../chat/session-manager.js";
import { createMessage } from "../../store/messages.js";
import { createTask } from "../../store/tasks.js";
import { createRole } from "../../store/roles.js";
import { createPendingPrompt } from "../../store/pending-prompts.js";
import { queryMemory } from "../../agent/memory-service.js";
import type { ChatMessage } from "../../shared/types.js";

describe("chat/context-builder", () => {
  beforeAll(() => {
    const { db } = setupTestDb();
    dbRef = db;
  });

  afterAll(() => {
    _resetForTest();
    dbRef.close();
  });

  beforeEach(() => {
    _resetForTest();
    clearTestDb();
  });

  function addMessages(sessionId: string, messages: { role: "user" | "assistant"; content: string }[]) {
    const now = Date.now();
    messages.forEach((m, i) => {
      const msg: ChatMessage = {
        id: `msg-${i}`,
        sessionId,
        role: m.role,
        content: m.content,
        source: { type: "web" },
        createdAt: now + i * 100,
      };
      createMessage(msg);
    });
  }

  it("assembles thread-grouped session context with free conversation", async () => {
    const session = createSession({ type: "web" });
    addMessages(session.id, [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ]);

    const prompt = await buildSessionContext(session.id, "What can you do?");

    // New thread-grouped format
    expect(prompt).toContain("[Session metadata]");
    expect(prompt).toContain(`session_id: ${session.id}`);
    expect(prompt).toContain("recent_window:");
    expect(prompt).toContain("[Free conversation]");
    // New envelope bracket format — shortMessageRef takes last 6 chars, so
    // msg-0 → #Mmsg-0 (9-char ID with embedded dash in output is fine)
    expect(prompt).toMatch(/- \d{2}:\d{2} \[user #M[\w-]+\] Hello/);
    expect(prompt).toMatch(/- \d{2}:\d{2} \[adam #M[\w-]+\] Hi there!/);
    expect(prompt).toContain("[Open prompts]");
    expect(prompt).toContain("[Current message]");
    expect(prompt).toContain("User: What can you do?");
  });

  it("includes memory context when memories are available", async () => {
    const session = createSession({ type: "web" });
    // buildSessionContext now calls queryMemoryByTier (not queryMemory)
    const { queryMemoryByTier } = await import("../../agent/memory-service.js");
    vi.mocked(queryMemoryByTier).mockResolvedValueOnce([
      { id: "mem1", roleId: "a1", type: "event", content: "previous knowledge", embedding: undefined, keywords: [], importance: 4, sourceType: "task_complete", createdAt: 0, lastAccessed: 0, retrievedCount: 0, score: 0.9, tier: "semantic" as const },
    ]);

    const prompt = await buildSessionContext(session.id, "Tell me about it");

    expect(prompt).toContain("[Relevant memories");
    expect(prompt).toContain("Memory [semantic]: previous knowledge (importance: 4)");
  });

  it("handles empty session (no messages)", async () => {
    const session = createSession({ type: "web" });
    const prompt = await buildSessionContext(session.id, "First message");

    // Empty session: [Session metadata] + [Open prompts](none) + [Current message]; no free conversation
    expect(prompt).toContain("[Session metadata]");
    expect(prompt).toContain(`session_id: ${session.id}`);
    expect(prompt).toContain("[Open prompts]");
    expect(prompt).toContain("[Open prompts]\n(none)");
    expect(prompt).not.toContain("[Free conversation]");
    expect(prompt).toContain("[Current message]");
    expect(prompt).toContain("User: First message");
  });

  it("handles memory search failure gracefully", async () => {
    const session = createSession({ type: "web" });
    const { queryMemoryByTier } = await import("../../agent/memory-service.js");
    vi.mocked(queryMemoryByTier).mockRejectedValueOnce(new Error("embedding unavailable"));

    const prompt = await buildSessionContext(session.id, "test");

    expect(prompt).not.toContain("[System context]");
    expect(prompt).toContain("[Current message]");
    expect(prompt).not.toContain("[Relevant memories");
  });

  it("emits thread block for status_report + result_delivery envelopes", async () => {
    const t0 = new Date(2026, 4, 6, 10, 0, 0).getTime();
    const session = createSession({ type: "web" });

    createRole({
      id: "r1", name: "审慎者", cagPrompt: "",
      preferences: {}, learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "stream-r1",
      status: "active", createdAt: t0,
    });
    createTask({
      id: "task-free1-1111", status: "running", prompt: "Review PR #456",
      config: { timeout: 60000 } as any, roleId: "r1", createdAt: t0 + 60_000,
    });

    createMessage({
      id: "msg-statx1", sessionId: session.id, role: "assistant",
      content: "running: checking code", source: { type: "web" },
      taskId: "task-free1-1111", kind: "status_report", createdAt: t0 + 120_000,
    });
    createMessage({
      id: "msg-resulx1", sessionId: session.id, role: "assistant",
      content: "done: 1 issue found", source: { type: "web" },
      taskId: "task-free1-1111", kind: "result_delivery", createdAt: t0 + 300_000,
    });

    const prompt = await buildSessionContext(session.id, "next?");

    expect(prompt).toContain("[Thread T-task-fre / 审慎者 / Review PR #456]");
    // Use flexible assertion (shortMessageRef takes last 6 chars)
    expect(prompt).toMatch(/\[status #M[\w-]+\] running: checking code/);
    expect(prompt).toMatch(/\[result #M[\w-]+\] done: 1 issue found/);
  });

  it("renders mirror suffix on its own indented line after attachments block", async () => {
    const t0 = new Date(2026, 4, 6, 10, 0, 0).getTime();
    const session = createSession({ type: "web" });

    createMessage({
      id: "msg-res1", sessionId: session.id, role: "assistant",
      content: "report attached", source: { type: "web" },
      kind: "result_delivery", createdAt: t0,
      attachments: [{
        artifactId: "a1", locator: "local:///tmp/r.md",
        filename: "r.md", mimeType: "text/markdown", size: 500,
        purpose: "report",
      }],
      mirroredToTargets: [{ type: "channel", channelId: "wechat-bot", chatId: "u-x" }],
    });

    const prompt = await buildSessionContext(session.id, "show me");

    // Mirror suffix on its own 3-space-indented line, AFTER attachments
    expect(prompt).toMatch(/attachments:\s*\n\s+\[file: r\.md.*\]\s*\n   \(also delivered to: wechat-bot:u-x @ \d{2}:\d{2}\)/s);
  });

  it("user_message with parentMessageId + promptId renders inside parent's thread", async () => {
    const t0 = new Date(2026, 4, 6, 10, 0, 0).getTime();
    const session = createSession({ type: "web" });

    createRole({
      id: "r1", name: "审慎者", cagPrompt: "",
      preferences: {}, learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "stream-r1",
      status: "active", createdAt: t0,
    });
    createTask({
      id: "task-usrry-1111", status: "completed", prompt: "Run test",
      config: { timeout: 60000 } as any, roleId: "r1", createdAt: t0 + 60_000,
    });
    createPendingPrompt({
      id: "B3M9", sessionId: session.id, taskId: "task-usrry-1111",
      messageId: "msg-prmt1", shape: "yes_no", askedAt: t0 + 120_000,
      expiresAt: t0 + 86_400_000, resolvedAt: t0 + 200_000,
      resolvedByMessageId: "msg-usrre", resolvedVia: "token", resolvedValue: "批准",
    });

    // Approval prompt envelope
    createMessage({
      id: "msg-prmt1", sessionId: session.id, role: "assistant",
      content: "approve it?", source: { type: "web" },
      taskId: "task-usrry-1111", kind: "approval_prompt",
      promptId: "B3M9", approvalShape: "yes_no", createdAt: t0 + 120_000,
    });
    // User reply that resolved the prompt (has parentMessageId + promptId)
    createMessage({
      id: "msg-usrre", sessionId: session.id, role: "user",
      content: "批准", source: { type: "web" },
      kind: "user_message", parentMessageId: "msg-prmt1", promptId: "B3M9",
      createdAt: t0 + 200_000,
    });

    const prompt = await buildSessionContext(session.id, "ok?");

    // Both in the same thread block (task ID first 8 chars = "task-usr")
    expect(prompt).toContain("[Thread T-task-usr / 审慎者 / Run test]");
    // Approval bracket with prompt + shape
    expect(prompt).toMatch(/\[approval #M[\w-]+ prompt=B3M9 shape=yes_no\] approve it\?/);
    // User reply in-thread with binding metadata
    expect(prompt).toMatch(/\[user #M[\w-]+ reply→#M[\w-]+ prompt=B3M9 via=token\] 批准/);
    // Free conversation should be empty (all messages bound to thread)
    expect(prompt).not.toContain("[Free conversation]");
  });

  it("lists open prompts in [Open prompts] section", async () => {
    const t0 = new Date(2026, 4, 6, 10, 0, 0).getTime();
    const session = createSession({ type: "web" });

    createMessage({
      id: "msg-open1", sessionId: session.id, role: "assistant",
      content: "should I proceed?", source: { type: "web" }, createdAt: t0,
    });
    createPendingPrompt({
      id: "X7K2", sessionId: session.id, taskId: undefined,
      messageId: "msg-open1", shape: "yes_no", askedAt: t0,
      expiresAt: t0 + 86_400_000,
    });

    const prompt = await buildSessionContext(session.id, "waiting for answer");

    // sections are joined with \n\n; Open prompts should contain the listing
    expect(prompt).toMatch(/- #X7K2 \(yes_no\) — "should I proceed\?" \(\d+h ago\)/);
  });

  it("ux-011a-attachment-excerpt-text-class: renders attachment excerpt for text-class MIME with preview", async () => {
    const session = createSession({ type: "web" });

    createMessage({
      id: "msg-att1", sessionId: session.id, role: "assistant",
      content: "result", source: { type: "web" },
      kind: "result_delivery", createdAt: Date.now(),
      attachments: [{
        artifactId: "a1", locator: "local:///tmp/out.md",
        filename: "out.md", mimeType: "text/markdown", size: 2000,
        purpose: "report", preview: { excerpt: "## Summary\nAll tests passed" },
      }],
    });

    const prompt = await buildSessionContext(session.id, "?");

    expect(prompt).toContain("excerpt: \"## Summary\\nAll tests passed\"");
  });

  it("ux-011b-attachment-metadata-only-binary-class: renders metadata only for binary-class MIME", async () => {
    const session = createSession({ type: "web" });

    createMessage({
      id: "msg-bin1", sessionId: session.id, role: "assistant",
      content: "screenshot", source: { type: "web" },
      kind: "result_delivery", createdAt: Date.now(),
      attachments: [{
        artifactId: "a1", locator: "local:///tmp/screen.png",
        filename: "screen.png", mimeType: "image/png", size: 100_000,
        purpose: "data",
      }],
    });

    const prompt = await buildSessionContext(session.id, "?");

    expect(prompt).toContain("[file: screen.png (purpose=data,");
    expect(prompt).not.toContain("excerpt:");
  });

  it("getSessionContextOnly returns formatted turns", () => {
    const session = createSession({ type: "web" });
    addMessages(session.id, [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ]);

    const context = getSessionContextOnly(session.id);
    expect(context).toBe("User: question\nAssistant: answer");
  });

  it("getSessionContextOnly returns empty string for empty session", () => {
    const session = createSession({ type: "web" });
    const context = getSessionContextOnly(session.id);
    expect(context).toBe("");
  });

  it("getMemoryContextOnly returns formatted memories", async () => {
    vi.mocked(queryMemory).mockResolvedValueOnce([
      { id: "m1", roleId: "a1", type: "event", content: "fact 1", embedding: undefined, keywords: [], importance: 3, sourceType: "task_complete", createdAt: 0, lastAccessed: 0, retrievedCount: 0, score: 0.8, tier: "episodic" as const },
      { id: "m2", roleId: "a1", type: "thought", content: "fact 2", embedding: undefined, keywords: [], importance: 5, sourceType: "reflection", createdAt: 0, lastAccessed: 0, retrievedCount: 0, score: 0.7, tier: "semantic" as const },
    ]);

    const context = await getMemoryContextOnly("test query");
    expect(context).toContain("Memory [episodic]: fact 1 (importance: 3)");
    expect(context).toContain("Memory [semantic]: fact 2 (importance: 5)");
  });
});
