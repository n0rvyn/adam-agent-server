/**
 * Tests for DeliveryEngine plan approval routing to source channel.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));

vi.mock("../../config/index.js", () => ({
  getDefaults: () => ({
    plugins: [], allowedTools: [], disallowedTools: [],
    approvalRequired: [], maxBudgetUsd: 5.0,
  }),
}));

vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), child: vi.fn().mockReturnThis(), level: "info",
  }),
}));

const mockSendApproval = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../channels/approval-handler.js", () => ({
  sendApprovalToChannel: mockSendApproval,
  formatPlanForChannel: (plan: unknown) => `[formatted plan]`,
}));

vi.mock("../../server/routes/channels.js", () => ({
  getChannelManager: vi.fn().mockReturnValue({
    sendMessage: vi.fn().mockResolvedValue("msg-1"),
  }),
}));

import { createTask } from "../../store/tasks.js";
import { createSession } from "../../chat/session-manager.js";
import { _resetForTest } from "../../chat/session-manager.js";
import { createMessage } from "../../store/messages.js";
import { DeliveryEngine } from "../../delivery/engine.js";
import { serverBus } from "../../server/events/server-bus.js";

afterAll(() => { _resetForTest(); cleanup(); });
beforeEach(() => { clearTestDb(); vi.clearAllMocks(); _resetForTest(); });

describe("DeliveryEngine approval routing", () => {
  it("routes plan approval to source channel when task originated from channel", async () => {
    // Create a session from a channel
    const session = createSession({ type: "channel", channelId: "ch-wechat", chatId: "wx-user-1" });

    // Create a task linked to a message in that session
    const taskId = "task-approval-1";
    createTask({
      id: taskId, status: "pending", prompt: "do something risky",
      createdAt: Date.now(),
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 } as any,
    });
    createMessage({
      id: "msg-1", sessionId: session.id, role: "user", content: "do something risky",
      source: { type: "channel", channelId: "ch-wechat", chatId: "wx-user-1" },
      createdAt: Date.now(), taskId,
    });

    // Initialize DeliveryEngine (subscribes to serverBus)
    const _engine = new DeliveryEngine();

    // Emit plan_approval_request
    serverBus.emit({
      type: "plan_approval_request",
      taskId,
      planId: "plan-1",
      plan: { steps: [{ description: "risky op" }], overallRisk: "high" } as any,
    });

    // Wait for async handler
    await new Promise((r) => setTimeout(r, 50));

    // Verify sendApprovalToChannel was called
    expect(mockSendApproval).toHaveBeenCalledWith(
      "ch-wechat", "wx-user-1", "plan-1", taskId,
      expect.any(String),
    );
  });

  it("falls back to delivery rules when task has no source channel", async () => {
    // Create a task from web (no channel source)
    const session = createSession({ type: "web" });
    const taskId = "task-web-1";
    createTask({
      id: taskId, status: "pending", prompt: "web task",
      createdAt: Date.now(),
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 } as any,
    });
    createMessage({
      id: "msg-web-1", sessionId: session.id, role: "user", content: "web task",
      source: { type: "web" },
      createdAt: Date.now(), taskId,
    });

    const _engine = new DeliveryEngine();

    serverBus.emit({
      type: "plan_approval_request",
      taskId,
      planId: "plan-web-1",
      plan: { steps: [], overallRisk: "low" } as any,
    });

    await new Promise((r) => setTimeout(r, 50));

    // sendApprovalToChannel should NOT be called (web origin, no channel)
    expect(mockSendApproval).not.toHaveBeenCalled();
  });
});
