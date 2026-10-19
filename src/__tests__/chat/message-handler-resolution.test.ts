import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";
import type { ChatManager } from "../../manager/chat-manager.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
}));

vi.mock("../../config/index.js", () => ({
  getChatConfig: () => ({
    sessionTimeoutMinutes: 30,
    maxSessionTurns: 20,
    autoTitle: false,
    archiveExtractMemory: false,
  }),
  getDefaults: () => ({
    timeout: 600,
    approvalRequired: [],
    approvalTimeout: 300,
    allowedTools: [],
    disallowedTools: [],
    maxTurns: 100,
    maxBudgetUsd: 5.0,
    model: "",
    effort: "high",
    settingSources: ["project"],
    env: {},
  }),
  DEFAULT_CONFIG: { chat: { sessionTimeoutMinutes: 30, maxSessionTurns: 20, autoTitle: false, archiveExtractMemory: false } },
}));

vi.mock("../../agent/memory-service.js", () => ({
  queryMemory: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../lib/llm-eval.js", () => ({
  callClaudeForEvaluation: vi.fn().mockResolvedValue("title"),
}));

// Mock ChatManager — follow the exact pattern from message-handler.test.ts
const mockChatManagerInstance = {
  handleMessage: vi.fn().mockResolvedValue("LLM response"),
};
vi.mock("../../manager/chat-manager.js", () => ({
  ChatManager: vi.fn(() => mockChatManagerInstance),
}));

// Mock cross-channel sync
vi.mock("../../chat/cross-channel-sync.js", () => ({
  syncResolvedPrompt: vi.fn(),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
}));

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

import { handleChatMessage, setChatManager, _resetListenerForTest } from "../../chat/message-handler.js";
import { syncResolvedPrompt } from "../../chat/cross-channel-sync.js";
import { _resetForTest as resetSessionManager } from "../../chat/session-manager.js";
import {
  createMessage,
  findEnvelopeByPlatformMessageId,
  getMessagesBySession,
} from "../../store/messages.js";
import { createPendingPrompt, getPendingPrompt } from "../../store/pending-prompts.js";
import * as sessionManager from "../../store/sessions.js";
import type { ChatSource } from "../../shared/types.js";

function makeSession(id = "s-test", source: ChatSource = { type: "web" }) {
  const existing = sessionManager.getSession(id);
  if (existing) return existing;
  sessionManager.createSession({
    id,
    status: "active",
    source,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    messageCount: 0,
  });
  return sessionManager.getSession(id)!;
}

// Create an approval_prompt chat_messages row with platform_message_id
function makeApprovalPromptEnvelope(opts: {
  id: string;
  sessionId: string;
  platformMessageId: string;
  promptId: string;
  content?: string;
  channelId?: string;
  chatId?: string;
}) {
  createMessage({
    id: opts.id,
    sessionId: opts.sessionId,
    role: "assistant",
    content: opts.content ?? "请确认操作 A",
    source: opts.channelId
      ? { type: "channel", channelId: opts.channelId, chatId: opts.chatId ?? "default" }
      : { type: "web" },
    kind: "approval_prompt",
    promptId: opts.promptId,
    platformMessageId: opts.platformMessageId,
    createdAt: Date.now(),
  });
}

// Create an open pending_prompt
function makePendingPrompt(opts: {
  id: string;
  sessionId: string;
  messageId: string;
  taskId?: string;
  shape?: string;
}) {
  createPendingPrompt({
    id: opts.id,
    sessionId: opts.sessionId,
    messageId: opts.messageId,
    shape: (opts.shape ?? "yes_no") as import("../../shared/types.js").ApprovalShape,
    taskId: opts.taskId,
    askedAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });
}

describe("message-handler resolution pipeline (Task 10)", () => {
  beforeAll(() => {
    const { db } = setupTestDb();
    dbRef = db;
  });

  afterAll(async () => {
    await _resetListenerForTest();
    dbRef.close();
  });

  beforeEach(async () => {
    clearTestDb();
    resetSessionManager();
    await _resetListenerForTest();
    mockChatManagerInstance.handleMessage.mockClear().mockResolvedValue("LLM response");
    vi.mocked(syncResolvedPrompt).mockClear();
    // Set up the ChatManager mock — message-handler checks this before dispatching to LLM
    setChatManager(mockChatManagerInstance as unknown as ChatManager);
  });

  // =======================================================================
  // Step 1: native_quote
  // =======================================================================
  describe("Step 1: native_quote", () => {
    it("resolves approval_prompt via quoted platform message id", async () => {
      const session = makeSession("s1", { type: "web" });

      // Fixture: approval_prompt envelope with platform_message_id="PM-QUOTE-1" + open pending_prompt
      makeApprovalPromptEnvelope({
        id: "env-1", sessionId: session.id, platformMessageId: "PM-QUOTE-1", promptId: "A2K7",
      });
      makePendingPrompt({ id: "A2K7", sessionId: session.id, messageId: "env-1" });

      const result = await handleChatMessage(
        "批准",
        { type: "web" },
        undefined,
        session.id,
        { quotedPlatformMessageId: "PM-QUOTE-1" },
      );

      // pending_prompts row resolved
      const prompt = getPendingPrompt("A2K7");
      expect(prompt?.resolvedVia).toBe("native_quote");
      expect(prompt?.resolvedValue).toBe("批准");

      // user_message bound to prompt
      const userMsg = getMessagesBySession(session.id).find((m) => m.role === "user");
      expect(userMsg?.promptId).toBe("A2K7");

      // No LLM dispatch
      expect(mockChatManagerInstance.handleMessage).not.toHaveBeenCalled();
    });
  });

  // =======================================================================
  // Step 2: token
  // =======================================================================
  describe("Step 2: token", () => {
    it("resolves via #XXXX token in message content", async () => {
      const session = makeSession("s2", { type: "web" });

      makeApprovalPromptEnvelope({
        id: "env-2", sessionId: session.id, platformMessageId: "PM-2", promptId: "B3M9",
        content: "确认操作 B",
      });
      makePendingPrompt({ id: "B3M9", sessionId: session.id, messageId: "env-2" });

      const result = await handleChatMessage(
        "批准 #B3M9",
        { type: "web" },
        undefined,
        session.id,
      );

      const prompt = getPendingPrompt("B3M9");
      expect(prompt?.resolvedVia).toBe("token");
      expect(prompt?.resolvedValue).toBe("批准 #B3M9");

      // No LLM dispatch
      expect(mockChatManagerInstance.handleMessage).not.toHaveBeenCalled();
    });

    it("does not match token not in open prompts list", async () => {
      const session = makeSession("s2b", { type: "web" });

      makeApprovalPromptEnvelope({
        id: "env-2b", sessionId: session.id, platformMessageId: "PM-2b", promptId: "ONLY",
      });
      makePendingPrompt({ id: "ONLY", sessionId: session.id, messageId: "env-2b" });

      // "NOTIN" is not an open prompt — should fall through to disambiguation (2 prompts open)
      const result = await handleChatMessage(
        "批准 #NOTIN",
        { type: "web" },
        undefined,
        session.id,
      );

      // The token is stale (not in open prompts), but LLM is also not called
      // because there's only 1 open prompt and the stale token doesn't count as "multiple"
      // Step 2 in helper returns null for stale token, step 4 (auto_unique) applies
      expect(mockChatManagerInstance.handleMessage).not.toHaveBeenCalled();
    });
  });

  // =======================================================================
  // Step 3: button
  // =======================================================================
  describe("Step 3: button", () => {
    it("resolves via buttonPayload.promptId", async () => {
      const session = makeSession("s3", { type: "web" });

      makeApprovalPromptEnvelope({
        id: "env-3", sessionId: session.id, platformMessageId: "PM-3", promptId: "C4M1",
      });
      makePendingPrompt({ id: "C4M1", sessionId: session.id, messageId: "env-3" });

      const result = await handleChatMessage(
        "approved",
        { type: "web" },
        undefined,
        session.id,
        { buttonPayload: { promptId: "C4M1", rawValue: "approved" } },
      );

      const prompt = getPendingPrompt("C4M1");
      expect(prompt?.resolvedVia).toBe("button");
      expect(prompt?.resolvedValue).toBe("approved");
      expect(mockChatManagerInstance.handleMessage).not.toHaveBeenCalled();
    });
  });

  // =======================================================================
  // Step 4: auto_unique
  // =======================================================================
  describe("Step 4: auto_unique", () => {
    it("auto-binds when exactly one open prompt exists", async () => {
      const session = makeSession("s4", { type: "web" });

      makeApprovalPromptEnvelope({
        id: "env-4", sessionId: session.id, platformMessageId: "PM-4", promptId: "D5N2",
        content: "单一确认项",
      });
      makePendingPrompt({ id: "D5N2", sessionId: session.id, messageId: "env-4" });

      const result = await handleChatMessage(
        "ok",
        { type: "web" },
        undefined,
        session.id,
      );

      const prompt = getPendingPrompt("D5N2");
      expect(prompt?.resolvedVia).toBe("auto_unique");
      expect(mockChatManagerInstance.handleMessage).not.toHaveBeenCalled();

      // system_note emitted
      const systemNotes = getMessagesBySession(session.id).filter((m) => m.kind === "system_note");
      expect(systemNotes.length).toBeGreaterThan(0);
      expect(systemNotes[0].content).toContain("已自动绑定到 #D5N2");
    });
  });

  // =======================================================================
  // Step 5: disambiguation
  // =======================================================================
  describe("Step 5: disambiguation", () => {
    it("ux-004-disambiguation-no-llm: emits system_note listing all open prompts and skips LLM", async () => {
      const session = makeSession("s5", { type: "web" });

      makeApprovalPromptEnvelope({
        id: "env-5a", sessionId: session.id, platformMessageId: "PM-5a", promptId: "P1AA",
        content: "第一个确认项",
      });
      makePendingPrompt({ id: "P1AA", sessionId: session.id, messageId: "env-5a" });

      makeApprovalPromptEnvelope({
        id: "env-5b", sessionId: session.id, platformMessageId: "PM-5b", promptId: "P2BB",
        content: "第二个确认项",
      });
      makePendingPrompt({ id: "P2BB", sessionId: session.id, messageId: "env-5b" });

      const result = await handleChatMessage(
        "好的",
        { type: "web" },
        undefined,
        session.id,
      );

      // No LLM dispatch
      expect(mockChatManagerInstance.handleMessage).not.toHaveBeenCalled();

      // system_note with disambiguation
      const systemNotes = getMessagesBySession(session.id).filter((m) => m.kind === "system_note");
      expect(systemNotes.length).toBe(1);
      expect(systemNotes[0].content).toContain("2 个待决策项");
      expect(systemNotes[0].content).toContain("#P1AA");
      expect(systemNotes[0].content).toContain("#P2BB");

      // user_message NOT bound to any prompt
      const userMsg = getMessagesBySession(session.id).find((m) => m.role === "user");
      expect(userMsg?.promptId).toBeUndefined();
    });
  });

  // =======================================================================
  // Stale prompt handling
  // =======================================================================
  describe("stale prompt handling", () => {
    it("emits 'decision already processed' for resolved prompt via native_quote", async () => {
      const session = makeSession("s6a", { type: "web" });

      makeApprovalPromptEnvelope({
        id: "env-6a", sessionId: session.id, platformMessageId: "PM-6a", promptId: "RESOLVED",
      });
      // Create a resolved prompt (no open pending_prompts row, only the envelope)
      createPendingPrompt({
        id: "RESOLVED",
        sessionId: session.id,
        messageId: "env-6a",
        shape: "yes_no",
        askedAt: Date.now() - 1000,
        expiresAt: Date.now() + 1000,
        resolvedAt: Date.now(),
        resolvedByMessageId: "old-msg",
        resolvedVia: "button",
        resolvedValue: "yes",
      });

      await handleChatMessage(
        "批准",
        { type: "web" },
        undefined,
        session.id,
        { quotedPlatformMessageId: "PM-6a" },
      );

      const systemNotes = getMessagesBySession(session.id).filter((m) => m.kind === "system_note");
      expect(systemNotes[0].content).toContain("已处理");
      expect(systemNotes[0].content).toContain("#RESOLVED");
      expect(mockChatManagerInstance.handleMessage).not.toHaveBeenCalled();
    });

    it("emits 'decision window expired' for expired prompt via native_quote", async () => {
      const session = makeSession("s6b", { type: "web" });

      makeApprovalPromptEnvelope({
        id: "env-6b", sessionId: session.id, platformMessageId: "PM-6b", promptId: "EXPIRED",
      });
      createPendingPrompt({
        id: "EXPIRED",
        sessionId: session.id,
        messageId: "env-6b",
        shape: "yes_no",
        askedAt: Date.now() - 1000,
        expiresAt: Date.now() - 100,
        expiredReason: "timeout",
      });

      await handleChatMessage(
        "批准",
        { type: "web" },
        undefined,
        session.id,
        { quotedPlatformMessageId: "PM-6b" },
      );

      const systemNotes = getMessagesBySession(session.id).filter((m) => m.kind === "system_note");
      expect(systemNotes[0].content).toContain("已过期");
      expect(systemNotes[0].content).toContain("#EXPIRED");
      expect(mockChatManagerInstance.handleMessage).not.toHaveBeenCalled();
    });

    it("emits 'decision window expired' for stale button payload", async () => {
      const session = makeSession("s6c", { type: "web" });

      // No open prompt for "STALEBTN" — button payload is stale
      await handleChatMessage(
        "clicked",
        { type: "web" },
        undefined,
        session.id,
        { buttonPayload: { promptId: "STALEBTN", rawValue: "clicked" } },
      );

      const systemNotes = getMessagesBySession(session.id).filter((m) => m.kind === "system_note");
      expect(systemNotes[0].content).toContain("STALEBTN");
      expect(mockChatManagerInstance.handleMessage).not.toHaveBeenCalled();
    });
  });

  // =======================================================================
  // No open prompts → LLM dispatch
  // =======================================================================
  describe("no open prompts fallthrough", () => {
    it("calls ChatManager.handleMessage when no open prompts exist", async () => {
      const session = makeSession("s7", { type: "web" });
      // No pending_prompts — no open prompts

      await handleChatMessage(
        "hello world",
        { type: "web" },
        undefined,
        session.id,
      );

      // LLM dispatch called once
      expect(mockChatManagerInstance.handleMessage).toHaveBeenCalledTimes(1);
      expect(mockChatManagerInstance.handleMessage).toHaveBeenCalledWith(
        "hello world",
        expect.any(String),
        expect.any(Object),
      );
    });
  });

  // =======================================================================
  // cross-channel sync triggered
  // =======================================================================
  describe("cross-channel sync triggered on resolution", () => {
    it("calls syncResolvedPrompt after resolution", async () => {
      const session = makeSession("s8", { type: "web" });

      makeApprovalPromptEnvelope({
        id: "env-8", sessionId: session.id, platformMessageId: "PM-8", promptId: "SYNC01",
      });
      makePendingPrompt({ id: "SYNC01", sessionId: session.id, messageId: "env-8" });

      await handleChatMessage(
        "批准",
        { type: "web" },
        undefined,
        session.id,
        { buttonPayload: { promptId: "SYNC01", rawValue: "批准" } },
      );

      expect(vi.mocked(syncResolvedPrompt)).toHaveBeenCalledTimes(1);
      const syncArgs = vi.mocked(syncResolvedPrompt).mock.calls[0][0];
      expect(syncArgs.promptId).toBe("SYNC01");
      expect(syncArgs.verdict).toBe("批准");
      expect(syncArgs.skipSource).toEqual({ type: "web" });
    });
  });
});
