import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { auditDeliveryClaims } from "../../audit/delivery-claim-auditor.js";
import {
  createDeliveryCommitment,
  markDeliveryCommitmentFailed,
} from "../../store/assistant-delivery-commitments.js";
import { createDeliveryLog } from "../../store/delivery-log.js";
import { recordUserVisibleDeliveryEvent } from "../../store/user-visible-events.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

describe("delivery evidence resolution", () => {
  it("authorizes sent claims with delivered attachment event evidence", () => {
    recordUserVisibleDeliveryEvent({
      eventKey: "event-attachments",
      sourceType: "task",
      sourceId: "task-1",
      taskId: "task-1",
      messageType: "result_delivery",
      viewerKey: "channel:wechat-1:chat-1",
      contentPreview: "sent",
      attachments: [{ filename: "1.png", mimeType: "image/png" }],
      traceId: "trace-1",
    });

    expect(auditDeliveryClaims({ text: "图片已发送", traceId: "trace-1", taskId: "task-1" }).status).toBe("passed");
  });

  it("authorizes generic failure wording with failed delivery log evidence", () => {
    createDeliveryLog({
      id: "log-failed",
      taskId: "task-2",
      status: "failed",
      target: { type: "channel", channelId: "wechat-1", chatId: "chat-1" },
      content: "done",
      attempts: 1,
      error: "adapter failed",
      createdAt: Date.now(),
      expiresAt: Date.now() + 1000,
      source: "direct",
      messageType: "result_delivery",
      traceId: "trace-2",
    });

    expect(auditDeliveryClaims({ text: "发送失败", traceId: "trace-2", taskId: "task-2" }).status).toBe("passed");
  });

  it("does not authorize count-specific failure wording with delivery log alone", () => {
    createDeliveryLog({
      id: "log-failed-count",
      taskId: "task-3",
      status: "failed",
      target: { type: "channel", channelId: "wechat-1", chatId: "chat-1" },
      content: "done",
      attempts: 1,
      error: "adapter failed",
      createdAt: Date.now(),
      expiresAt: Date.now() + 1000,
      source: "direct",
      messageType: "result_delivery",
      traceId: "trace-3",
    });

    expect(auditDeliveryClaims({ text: "3 张图发送失败", traceId: "trace-3", taskId: "task-3" }).status).toBe("blocked");
  });

  it("authorizes count-specific failure wording with failed commitment evidence", () => {
    const commitment = createDeliveryCommitment({
      traceId: "trace-4",
      sessionId: "session-4",
      taskId: "task-4",
      target: { type: "channel", channelId: "wechat-1", chatId: "chat-1" },
      artifactExpectation: { kind: "image", count: 3 },
    });
    markDeliveryCommitmentFailed(commitment.id, "adapter_failed", [
      { status: "failed", filename: "1.png", attachmentIndex: 0 },
      { status: "failed", filename: "2.png", attachmentIndex: 1 },
      { status: "failed", filename: "3.png", attachmentIndex: 2 },
    ]);

    expect(auditDeliveryClaims({
      text: "3 张图发送失败",
      traceId: "trace-4",
      sessionId: "session-4",
      taskId: "task-4",
    }).status).toBe("passed");
  });

  it("does not authorize claims from unrelated delivered messages", () => {
    recordUserVisibleDeliveryEvent({
      eventKey: "event-unrelated",
      sourceType: "task",
      sourceId: "task-other",
      taskId: "task-other",
      messageType: "result_delivery",
      viewerKey: "channel:wechat-1:chat-1",
      contentPreview: "sent",
      attachments: [{ filename: "1.png", mimeType: "image/png" }],
      traceId: "trace-other",
    });

    expect(auditDeliveryClaims({ text: "图片已发送", traceId: "trace-5", taskId: "task-5" }).status).toBe("blocked");
  });
});
