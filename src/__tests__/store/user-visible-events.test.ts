import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  getUserVisibleEventByEventKey,
  listUserVisibleEventsForContext,
  recordUserVisibleDeliveryEvent,
} from "../../store/user-visible-events.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

describe("store/user-visible-events", () => {
  it("upserts by event key and merges targets plus attachments", () => {
    recordUserVisibleDeliveryEvent({
      eventKey: "owner|exec-1|result_delivery|hash-a",
      sourceType: "template_execution",
      sourceId: "exec-1",
      taskId: "exec-1",
      templateId: "tmpl-1",
      templateName: "Daily podcast",
      messageType: "result_delivery",
      viewerKey: "owner",
      contentPreview: "AI weekly briefing",
      targets: [{ type: "channel", channelId: "email-1", chatId: "a@example.com" }],
      attachments: [{ artifactId: "art-1", filename: "podcast.mp3", mimeType: "audio/mpeg", sizeBytes: 42 }],
      deliveredAt: 1000,
    });

    recordUserVisibleDeliveryEvent({
      eventKey: "owner|exec-1|result_delivery|hash-a",
      sourceType: "template_execution",
      sourceId: "exec-1",
      taskId: "exec-1",
      messageType: "result_delivery",
      viewerKey: "owner",
      contentPreview: "AI weekly briefing",
      targets: [
        { type: "channel", channelId: "email-1", chatId: "a@example.com" },
        { type: "channel", channelId: "wechat-1", chatId: "wx-1" },
      ],
      attachments: [
        { artifactId: "art-1", filename: "podcast-final.mp3", mimeType: "audio/mpeg", sizeBytes: 42 },
        { filename: "brief.md", mimeType: "text/markdown", sizeBytes: 12 },
      ],
      deliveredAt: 2000,
    });

    const event = getUserVisibleEventByEventKey("owner|exec-1|result_delivery|hash-a");
    expect(event?.firstDeliveredAt).toBe(1000);
    expect(event?.lastDeliveredAt).toBe(2000);
    expect(event?.targets).toHaveLength(2);
    expect(event?.attachments).toHaveLength(2);
    expect(event?.attachments.find((item) => item.artifactId === "art-1")?.filename).toBe("podcast-final.mp3");
  });

  it("lists rows only for the matching viewer and time window", () => {
    recordUserVisibleDeliveryEvent({
      eventKey: "owner|task-1|result_delivery|hash-a",
      sourceType: "task",
      sourceId: "task-1",
      taskId: "task-1",
      messageType: "result_delivery",
      viewerKey: "owner",
      contentPreview: "owner delivery",
      deliveredAt: 1000,
    });
    recordUserVisibleDeliveryEvent({
      eventKey: "other|task-2|result_delivery|hash-b",
      sourceType: "task",
      sourceId: "task-2",
      taskId: "task-2",
      messageType: "result_delivery",
      viewerKey: "other",
      contentPreview: "other delivery",
      deliveredAt: 1100,
    });
    recordUserVisibleDeliveryEvent({
      eventKey: "owner|task-3|result_delivery|hash-c",
      sourceType: "task",
      sourceId: "task-3",
      taskId: "task-3",
      messageType: "result_delivery",
      viewerKey: "owner",
      contentPreview: "already in session",
      deliveredAt: 1200,
    });

    const rows = listUserVisibleEventsForContext({
      viewerKey: "owner",
      since: 900,
      until: 1300,
      excludeSourceIds: ["task-3"],
    });

    expect(rows.map((row) => row.sourceId)).toEqual(["task-1"]);
  });

  it("requires an explicit viewer key", () => {
    expect(() => recordUserVisibleDeliveryEvent({
      eventKey: "bad",
      sourceType: "task",
      sourceId: "task-1",
      messageType: "result_delivery",
      viewerKey: "",
      contentPreview: "bad",
    })).toThrow("viewerKey");
  });
});
