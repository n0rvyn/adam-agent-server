import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { auditDeliveryClaims } from "../../audit/delivery-claim-auditor.js";
import { auditAssistantCommitment } from "../../audit/commitment-auditor.js";
import {
  createDeliveryCommitment,
  markDeliveryCommitmentFailed,
  markDeliveryCommitmentFulfilled,
} from "../../store/assistant-delivery-commitments.js";
import { createDeliveryLog } from "../../store/delivery-log.js";
import { recordUserVisibleDeliveryEvent } from "../../store/user-visible-events.js";
import { recordRuntimeEffect } from "../../store/runtime-effects.js";
import { initRuntimeConfig } from "../../config/runtime.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { ServerConfig } from "../../shared/types.js";
import { getBlockedFutureDeliveryText } from "../../chat/commitment-replacement-text.js";
import { getUnsupportedFailureText, getUnsupportedSuccessText } from "../../chat/commitment-replacement-text.js";

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
});

describe("audit/delivery-claim-auditor", () => {
  it("blocks failure claims without failed evidence", () => {
    // Task 2 enrichment: when taskId is provided but no delivery_log row matches,
    // the enriched builder returns a "no record" message instead of the stock template.
    const result = auditDeliveryClaims({ text: "图片已生成，但发送失败", traceId: "trace-none", taskId: "task-none" });
    expect(result.status).toBe("blocked");
    expect(result.replacementText).toBe("图片已生成，但没有发送动作的记录。");
  });

  it("blocks success claims without delivered evidence", () => {
    const result = auditDeliveryClaims({ text: "图片已发到微信", traceId: "trace-none", taskId: "task-none" });
    expect(result.status).toBe("blocked");
    expect(result.replacementText).toBe("图片已生成，但没有发送动作的记录。");
  });

  it("falls back to stock template when no taskId/traceId provided", () => {
    // Task 2 guard: without query context, we cannot query delivery_log meaningfully,
    // so fall back to the stock template (preserves pre-enrichment behavior).
    const result = auditDeliveryClaims({ text: "图片已生成，但发送失败" });
    expect(result.status).toBe("blocked");
    expect(result.replacementText).toBe(getUnsupportedFailureText("zh"));
  });

  it("passes generic success claims with matching delivered delivery log evidence", () => {
    createDeliveryLog({
      id: "log-1",
      taskId: "task-1",
      status: "delivered",
      target: { type: "channel", channelId: "wechat-1", chatId: "chat-1" },
      content: "done",
      attempts: 1,
      createdAt: Date.now(),
      deliveredAt: Date.now(),
      expiresAt: Date.now() + 1000,
      source: "direct",
      messageType: "reply",
      traceId: "trace-1",
    });

    expect(auditDeliveryClaims({ text: "已发送", traceId: "trace-1", taskId: "task-1" }).status).toBe("passed");
  });

  it("does not let failed delivery_log alone authorize count-specific artifact failure claims", () => {
    createDeliveryLog({
      id: "log-2",
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

    expect(auditDeliveryClaims({ text: "3 张图发送失败", traceId: "trace-2", taskId: "task-2" }).status).toBe("blocked");
  });

  it("passes count-specific failure claims with failed commitment evidence", () => {
    const commitment = createDeliveryCommitment({
      traceId: "trace-3",
      sessionId: "session-3",
      taskId: "task-3",
      target: { type: "channel", channelId: "wechat-1", chatId: "chat-1" },
      artifactExpectation: { kind: "image", count: 3 },
    });
    markDeliveryCommitmentFailed(commitment.id, "adapter_failed", [
      { status: "failed", filename: "1.png" },
      { status: "failed", filename: "2.png" },
      { status: "failed", filename: "3.png" },
    ]);

    expect(auditDeliveryClaims({
      text: "3 张图发送失败",
      traceId: "trace-3",
      sessionId: "session-3",
      taskId: "task-3",
    }).status).toBe("passed");
  });

  it("passes count-specific success claims with user-visible attachment event evidence", () => {
    recordUserVisibleDeliveryEvent({
      eventKey: "event-1",
      sourceType: "task",
      sourceId: "task-4",
      taskId: "task-4",
      messageType: "result_delivery",
      viewerKey: "channel:wechat-1:chat-1",
      contentPreview: "done",
      attachments: [
        { filename: "1.png", mimeType: "image/png" },
        { filename: "2.png", mimeType: "image/png" },
        { filename: "3.png", mimeType: "image/png" },
      ],
      traceId: "trace-4",
    });

    expect(auditDeliveryClaims({ text: "3 张图已发送", traceId: "trace-4", taskId: "task-4" }).status).toBe("passed");
  });

  it("keeps existing mutation-claim audit behavior intact", () => {
    recordRuntimeEffect({
      traceId: "trace-template",
      effectType: "update",
      effectCategory: "template_update",
      entityType: "task_template",
      entityId: "tmpl-1",
      fieldPath: "steps.audio.config.backgroundMusicVolume",
    });

    expect(auditAssistantCommitment({
      text: "背景音乐已记录",
      traceId: "trace-template",
    }).status).toBe("passed");
  });

  it("passes count-specific success claims with fulfilled commitment evidence", () => {
    const commitment = createDeliveryCommitment({
      traceId: "trace-5",
      sessionId: "session-5",
      taskId: "task-5",
      target: { type: "channel", channelId: "wechat-1", chatId: "chat-1" },
      artifactExpectation: { kind: "image", count: 3 },
    });
    markDeliveryCommitmentFulfilled(commitment.id, [
      { status: "delivered", filename: "1.png" },
      { status: "delivered", filename: "2.png" },
      { status: "delivered", filename: "3.png" },
    ]);

    expect(auditDeliveryClaims({
      text: "3 张图已发送",
      traceId: "trace-5",
      sessionId: "session-5",
      taskId: "task-5",
    }).status).toBe("passed");
  });
});

describe("audit/delivery-claim-auditor — EN", () => {
  it("blocks EN failure claim without evidence (enriched)", () => {
    // Task 2 enrichment: "report" isn't mapped to image/audio/video/file,
    // so artifactKindLabel falls back to "result".
    const result = auditDeliveryClaims({
      text: "Failed to send the report.",
      traceId: "trace-en-fail",
      taskId: "task-en-fail",
    });
    expect(result.status).toBe("blocked");
    expect(result.replacementText).toBe("result is ready, but no delivery attempt was recorded.");
  });

  it("blocks EN success claim without evidence (enriched)", () => {
    const result = auditDeliveryClaims({
      text: "I've sent all 3 images to your WeChat.",
      traceId: "trace-en-succ",
      taskId: "task-en-succ",
    });
    expect(result.status).toBe("blocked");
    expect(result.replacementText).toBe("image is ready, but no delivery attempt was recorded.");
  });

  it("falls back to EN stock template when no taskId/traceId provided", () => {
    const result = auditDeliveryClaims({ text: "Failed to send the report." });
    expect(result.status).toBe("blocked");
    expect(result.replacementText).toBe(getUnsupportedFailureText("en"));
  });

  it("passes EN success claim with matching delivery_log evidence", () => {
    createDeliveryLog({
      id: "log-en-1",
      taskId: "task-en-1",
      status: "delivered",
      target: { type: "channel", channelId: "wechat-1", chatId: "chat-1" },
      content: "done",
      attempts: 1,
      createdAt: Date.now(),
      deliveredAt: Date.now(),
      expiresAt: Date.now() + 1000,
      source: "direct",
      messageType: "reply",
      traceId: "trace-en-1",
    });

    // Use generic claim (no artifact keyword) so resolver consults delivery_log evidence.
    // Specific claims with artifact kind only consult commitment / user_visible_events evidence.
    expect(auditDeliveryClaims({
      text: "I've sent.",
      traceId: "trace-en-1",
      taskId: "task-en-1",
    }).status).toBe("passed");
  });
});
