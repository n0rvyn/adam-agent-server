import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
}));

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

import { groupEnvelopesByThread } from "../../chat/context-thread-grouper.js";
import { createMessage } from "../../store/messages.js";
import { createTask } from "../../store/tasks.js";
import { createRole } from "../../store/roles.js";
import { createPendingPrompt } from "../../store/pending-prompts.js";
import type { ChatMessage } from "../../shared/types.js";

describe("chat/context-thread-grouper", () => {
  beforeAll(() => {
    const { db } = setupTestDb();
    dbRef = db;
  });
  afterAll(() => dbRef.close());
  beforeEach(() => clearTestDb());

  function makeMsg(id: string, taskId: string | undefined, createdAt: number, role: "user" | "assistant" = "user"): ChatMessage {
    return {
      id,
      sessionId: "s1",
      role,
      content: `m${id}`,
      source: { type: "web" },
      taskId,
      createdAt,
    };
  }

  it("splits free conversation from threads", () => {
    const msgs = [
      makeMsg("m1", undefined, 100),
      makeMsg("m2", undefined, 200, "assistant"),
    ];
    const result = groupEnvelopesByThread(msgs);
    expect(result.freeConversation).toHaveLength(2);
    expect(result.threads).toHaveLength(0);
  });

  it("groups envelopes by taskId", () => {
    const taskA = "task-aaaaaaaa-1111";
    const taskB = "task-bbbbbbbb-2222";
    createRole({
      id: "r1", name: "审慎者", cagPrompt: "",
      preferences: {}, learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "stream-r1",
      status: "active", createdAt: Date.now(),
    });
    createTask({ id: taskA, status: "completed", prompt: "评审 PR #123", config: { timeout: 60000 } as any, roleId: "r1", createdAt: 100 });
    createTask({ id: taskB, status: "running", prompt: "评审 PR #124", config: { timeout: 60000 } as any, roleId: "r1", createdAt: 110 });

    const msgs = [
      makeMsg("m1", undefined, 50),  // free
      makeMsg("m2", taskA, 200, "assistant"),
      makeMsg("m3", taskB, 220, "assistant"),
      makeMsg("m4", taskA, 300, "assistant"),
    ];

    const result = groupEnvelopesByThread(msgs);
    expect(result.freeConversation).toHaveLength(1);
    expect(result.threads).toHaveLength(2);

    const tA = result.threads.find(t => t.taskId === taskA)!;
    expect(tA.taskShortId).toBe(`T-${taskA.slice(0, 8)}`);
    expect(tA.roleName).toBe("审慎者");
    expect(tA.brief).toBe("评审 PR #123");
    expect(tA.active).toBe(false);  // completed + no open prompts
    expect(tA.envelopes.map(m => m.id)).toEqual(["m2", "m4"]);

    const tB = result.threads.find(t => t.taskId === taskB)!;
    expect(tB.active).toBe(true);  // running
  });

  it("marks thread active when task has open prompt", () => {
    const taskC = "task-ccccccccc-3333";
    createTask({ id: taskC, status: "completed", prompt: "X", config: { timeout: 60000 } as any, createdAt: 100 });
    // store the message that owns the prompt
    createMessage(makeMsg("m-prompt", taskC, 200, "assistant"));
    createPendingPrompt({
      id: "P1",
      sessionId: "s1",
      taskId: taskC,
      messageId: "m-prompt",
      shape: "yes_no",
      askedAt: 200,
      expiresAt: Date.now() + 60_000,
    });

    const result = groupEnvelopesByThread([makeMsg("m1", taskC, 200, "assistant")]);
    expect(result.threads[0].active).toBe(true);
  });

  it("threads sorted by first envelope createdAt", () => {
    const tA = "task-aaaaaaaa-1111";
    const tB = "task-bbbbbbbb-2222";
    createTask({ id: tA, status: "running", prompt: "A", config: { timeout: 60000 } as any, createdAt: 1 });
    createTask({ id: tB, status: "running", prompt: "B", config: { timeout: 60000 } as any, createdAt: 2 });
    const msgs = [makeMsg("mB", tB, 100, "assistant"), makeMsg("mA", tA, 200, "assistant")];
    const result = groupEnvelopesByThread(msgs);
    expect(result.threads[0].taskId).toBe(tB);
    expect(result.threads[1].taskId).toBe(tA);
  });

  it("handles missing task / role gracefully", () => {
    const taskX = "task-xxxxxxxx-9999";
    const msgs = [makeMsg("m1", taskX, 100, "assistant")];
    const result = groupEnvelopesByThread(msgs);
    expect(result.threads[0].roleName).toBe("?");
    expect(result.threads[0].brief).toBe("");
    expect(result.threads[0].active).toBe(false);  // no task → not active
  });

  it("user_message inherits parent's taskId via parentMessageId (binds to thread)", () => {
    const taskA = "task-aaaaaaaa-1111";
    createTask({ id: taskA, status: "completed", prompt: "评审 PR", config: { timeout: 60000 } as any, createdAt: 100 });
    const promptMsg: ChatMessage = {
      ...makeMsg("m-prompt", taskA, 200, "assistant"),
      kind: "approval_prompt",
    };
    const userReply: ChatMessage = {
      ...makeMsg("m-reply", undefined, 300, "user"),
      kind: "user_message",
      parentMessageId: "m-prompt",
      promptId: "A2K7",
    };
    const result = groupEnvelopesByThread([promptMsg, userReply]);
    // Both go into the thread (user reply bound via parentMessageId)
    expect(result.freeConversation).toHaveLength(0);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0].envelopes.map(m => m.id)).toEqual(["m-prompt", "m-reply"]);
  });
});
