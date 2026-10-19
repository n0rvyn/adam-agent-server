import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/index.js", () => ({
  getChatConfig: () => ({
    sessionTimeoutMinutes: 30,
    maxSessionTurns: 20,
    autoTitle: false,
    archiveExtractMemory: true,
  }),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
}));

const { mockGatewaySend } = vi.hoisted(() => ({
  mockGatewaySend: vi.fn().mockResolvedValue({ success: true, logEntryId: "log-test" }),
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined),
    send: mockGatewaySend,
  }),
}));

import { handleChatMessage, setChatManager, _resetListenerForTest } from "../../chat/message-handler.js";
import { _resetForTest as resetSessionManager } from "../../chat/session-manager.js";
import { getMessagesBySession } from "../../store/messages.js";
import { findPendingDeliveryCommitmentsForTask } from "../../store/assistant-delivery-commitments.js";
import type { ChatManagerResponse, ChatSource } from "../../shared/types.js";

afterAll(async () => {
  await _resetListenerForTest();
  resetSessionManager();
  cleanup();
});

beforeEach(async () => {
  await _resetListenerForTest();
  resetSessionManager();
  clearTestDb();
  mockGatewaySend.mockClear();
});

function installChatManager(responses: ChatManagerResponse[]) {
  const handleMessageWithDispatches = vi.fn(async () => responses.shift() ?? { text: "done", dispatches: [] });
  setChatManager({ handleMessageWithDispatches } as unknown as import("../../manager/chat-manager.js").ChatManager);
  return handleMessageWithDispatches;
}

async function waitForAssistant(sessionId: string, count = 1) {
  await vi.waitFor(() => {
    expect(getMessagesBySession(sessionId).filter((m) => m.role === "assistant")).toHaveLength(count);
  });
  return getMessagesBySession(sessionId).filter((m) => m.role === "assistant").at(-1)!;
}

describe("ChatManager delivery commitment binding", () => {
  const webSource: ChatSource = { type: "web" };

  it("binds single dispatch plus future delivery promise to a pending commitment", async () => {
    installChatManager([{
      text: "已派毕加索生成 3 张商品图，完成后发你。",
      traceId: "trace-bind",
      dispatches: [{ taskId: "task-1", toolName: "dispatch_to_role", traceId: "trace-bind" }],
    }]);

    const result = await handleChatMessage("生成商品图", webSource);
    const assistant = await waitForAssistant(result.sessionId);
    const commitments = findPendingDeliveryCommitmentsForTask("task-1");

    expect(commitments).toHaveLength(1);
    expect(commitments[0]).toEqual(expect.objectContaining({
      traceId: "trace-bind",
      sessionId: result.sessionId,
      sourceMessageId: assistant.id,
      artifactExpectation: { kind: "image", count: 3 },
      target: { type: "session", sessionId: result.sessionId },
    }));
  });

  it("replaces future delivery promise when no task was dispatched", async () => {
    installChatManager([{ text: "完成后发你。", traceId: "trace-none", dispatches: [] }]);

    const result = await handleChatMessage("生成商品图", webSource);
    const assistant = await waitForAssistant(result.sessionId);

    expect(assistant.content).toContain("完成后我会更新结果");
    expect(assistant.content).not.toContain("发你");
  });

  it("replaces ambiguous promise when two tasks were dispatched", async () => {
    installChatManager([{
      text: "两个任务都安排了，完成后发你。",
      traceId: "trace-two",
      dispatches: [
        { taskId: "task-a", toolName: "dispatch_to_role", traceId: "trace-two" },
        { taskId: "task-b", toolName: "dispatch_to_role", traceId: "trace-two" },
      ],
    }]);

    const result = await handleChatMessage("生成商品图", webSource);
    const assistant = await waitForAssistant(result.sessionId);

    expect(assistant.content).toContain("完成后我会更新结果");
    expect(findPendingDeliveryCommitmentsForTask("task-a")).toEqual([]);
    expect(findPendingDeliveryCommitmentsForTask("task-b")).toEqual([]);
  });

  it("delivers replacement text to channel, not the blocked promise", async () => {
    installChatManager([{ text: "完成后发你。", traceId: "trace-channel", dispatches: [] }]);

    await handleChatMessage("生成商品图", { type: "channel", channelId: "wechat-1", chatId: "chat-1" });

    await vi.waitFor(() => {
      expect(mockGatewaySend).toHaveBeenCalledWith(expect.objectContaining({
        channelId: "wechat-1",
        chatId: "chat-1",
        content: expect.stringContaining("完成后我会更新结果"),
      }));
    });
    expect(mockGatewaySend.mock.calls[0][0].content).not.toContain("发你");
  });

  it("does not bind dispatches from a previous ChatManager turn", async () => {
    installChatManager([
      { text: "任务已提交。", traceId: "trace-first", dispatches: [{ taskId: "task-old", toolName: "dispatch_to_role" }] },
      { text: "完成后发你。", traceId: "trace-second", dispatches: [] },
    ]);

    const first = await handleChatMessage("先开一个任务", webSource);
    await waitForAssistant(first.sessionId);
    const second = await handleChatMessage("再承诺发送", webSource);
    const assistant = await waitForAssistant(second.sessionId, 2);

    expect(assistant.content).toContain("完成后我会更新结果");
    expect(findPendingDeliveryCommitmentsForTask("task-old")).toEqual([]);
  });
});
