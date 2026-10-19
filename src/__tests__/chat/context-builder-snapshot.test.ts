import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({ getDb: () => getTestDbRef() }));
vi.mock("../../config/index.js", () => ({
  getChatConfig: () => ({
    sessionTimeoutMinutes: 30,
    maxSessionTurns: 20,
    autoTitle: true,
    archiveExtractMemory: true,
    contextBudgetTokens: 20000,
  }),
  getDefaults: () => ({}),
  DEFAULT_CONFIG: {
    chat: {
      sessionTimeoutMinutes: 30,
      maxSessionTurns: 20,
      autoTitle: true,
      archiveExtractMemory: true,
      contextBudgetTokens: 20000,
    },
  },
}));
vi.mock("../../agent/memory-service.js", () => ({
  queryMemory: vi.fn().mockResolvedValue([]),
  queryMemoryByTier: vi.fn().mockResolvedValue([]),
}));

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

import { buildSessionContext } from "../../chat/context-builder.js";
import { createMessage } from "../../store/messages.js";
import { createTask } from "../../store/tasks.js";
import { createRole } from "../../store/roles.js";
import { createSession } from "../../chat/session-manager.js";
import { _resetForTest } from "../../chat/session-manager.js";
import { createPendingPrompt } from "../../store/pending-prompts.js";
import type { ChatMessage } from "../../shared/types.js";

describe("chat/context-builder snapshot — fixture session", () => {
  beforeAll(() => { dbRef = setupTestDb().db; });
  afterAll(() => { _resetForTest(); dbRef.close(); });
  beforeEach(() => { _resetForTest(); clearTestDb(); });

  it("ux-009-context-builder-thread-grouped-format: emits the documented thread-grouped format", async () => {
    const t0 = new Date(2026, 4, 6, 10, 30, 0).getTime();
    const session = createSession({ type: "web" });

    createRole({
      id: "r1", name: "审慎者", cagPrompt: "",
      preferences: {}, learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "stream-r1",
      status: "active", createdAt: t0,
    });
    createTask({
      id: "task-aaaaaaaa-1111", status: "completed", prompt: "评审 PR #123",
      config: { timeout: 60000 } as any, roleId: "r1", createdAt: t0 + 60_000,
    });

    // Set up an approval prompt (#A2K7) that the user resolved via token
    const promptMsgId = "msg-prmtp";  // last 6 = r-pmtp (avoid dash collision)
    createPendingPrompt({
      id: "A2K7", sessionId: session.id, taskId: "task-aaaaaaaa-1111",
      messageId: promptMsgId, shape: "yes_no", askedAt: t0 + 200_000, expiresAt: t0 + 86_400_000,
      resolvedAt: t0 + 250_000, resolvedByMessageId: "msg-usrre",
      resolvedVia: "token", resolvedValue: "批准",
    });

    const m1: ChatMessage = {
      id: "msg-uone1", sessionId: session.id, role: "user",  // last 6 = uone1
      content: "帮我审一下 PR #123", source: { type: "web" }, createdAt: t0,
    };
    const m2: ChatMessage = {
      id: "msg-aone1", sessionId: session.id, role: "assistant",  // last 6 = aone1
      content: "好，已分派给审慎者", source: { type: "web" }, createdAt: t0 + 30_000,
    };
    const m3: ChatMessage = {
      id: "msg-sone1", sessionId: session.id, role: "assistant",  // last 6 = sone1
      content: "running: cloning PR", source: { type: "web" },
      taskId: "task-aaaaaaaa-1111", kind: "status_report", createdAt: t0 + 120_000,
    };
    // Approval prompt envelope
    const mApr: ChatMessage = {
      id: promptMsgId, sessionId: session.id, role: "assistant",
      content: "申请 git push 权限", source: { type: "web" },
      taskId: "task-aaaaaaaa-1111", kind: "approval_prompt",
      promptId: "A2K7", approvalShape: "yes_no", createdAt: t0 + 200_000,
    };
    // User reply, resolved via token
    const mReply: ChatMessage = {
      id: "msg-usrre", sessionId: session.id, role: "user",  // last 6 = usrre
      content: "批准 #A2K7", source: { type: "web" },
      kind: "user_message", parentMessageId: promptMsgId, promptId: "A2K7",
      createdAt: t0 + 250_000,
    };
    const m4: ChatMessage = {
      id: "msg-rone1", sessionId: session.id, role: "assistant",  // last 6 = rone1
      content: "评审完成: 2 处 critical", source: { type: "web" },
      taskId: "task-aaaaaaaa-1111", kind: "result_delivery", createdAt: t0 + 600_000,
      attachments: [{
        artifactId: "a1", locator: "local:///tmp/review.md",
        filename: "review.md", mimeType: "text/markdown", size: 4200,
        purpose: "report", preview: { excerpt: "## Findings\n1. Race condition" },
      }],
      mirroredToTargets: [{ type: "channel", channelId: "wechat-bot", chatId: "u-x" }],
    };
    [m1, m2, m3, mApr, mReply, m4].forEach(createMessage);

    const out = await buildSessionContext(session.id, "下一步呢？");

    // [Session metadata]
    expect(out).toContain("[Session metadata]");
    expect(out).toContain(`session_id: ${session.id}`);
    expect(out).toContain("recent_window: last 6 envelopes within 20000 tokens");

    // [Free conversation] — m1 + m2 (no taskId, no parentMessageId)
    // mReply has parentMessageId pointing to the approval prompt, so it inherits
    // taskId via the thread-grouper and renders INSIDE the thread block
    expect(out).toContain("[Free conversation]");
    expect(out).toMatch(/- \d{2}:\d{2} \[user #Muone1\] 帮我审一下 PR #123/);
    expect(out).toMatch(/- \d{2}:\d{2} \[adam #Maone1\] 好，已分派给审慎者/);

    // [Thread T-task-aaa / 审慎者 / 评审 PR #123]
    expect(out).toContain("[Thread T-task-aaa / 审慎者 / 评审 PR #123]");
    expect(out).toMatch(/- \d{2}:\d{2} \[status #Msone1\] running: cloning PR/);
    expect(out).toMatch(/- \d{2}:\d{2} \[approval #Mprmtp prompt=A2K7 shape=yes_no\] 申请 git push 权限/);
    // User reply rendered IN-thread with binding metadata: reply→#Mprmtp prompt=A2K7 via=token
    expect(out).toMatch(/- \d{2}:\d{2} \[user #Musrre reply→#Mprmtp prompt=A2K7 via=token\] 批准 #A2K7/);

    // result_delivery: content line, then attachments block, then mirror suffix on its own line
    expect(out).toMatch(/- \d{2}:\d{2} \[result #Mrone1\] 评审完成: 2 处 critical/);
    expect(out).toContain("attachments:");
    expect(out).toContain("[file: review.md (purpose=report, 4.1KB, mime=text/markdown)]");
    expect(out).toContain('excerpt: "## Findings\\n1. Race condition"');
    // Mirror suffix on its OWN line (3-space indent), AFTER the attachments block — design lines 270-274
    expect(out).toMatch(/excerpt: .*\n   \(also delivered to: wechat-bot:u-x @ \d{2}:\d{2}\)/s);

    // [Open prompts] — A2K7 is resolved, so (none)
    expect(out).toContain("[Open prompts]\n(none)");

    // [Current message]
    expect(out).toContain("[Current message]\nUser: 下一步呢？");
  });
});
