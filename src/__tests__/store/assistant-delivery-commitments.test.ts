import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  createDeliveryCommitment,
  findPendingDeliveryCommitmentsForTask,
  findRecentDeliveryEvidence,
  getDeliveryCommitment,
  markDeliveryCommitmentBlocked,
  markDeliveryCommitmentFailed,
  markDeliveryCommitmentFulfilled,
} from "../../store/assistant-delivery-commitments.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

describe("store/assistant-delivery-commitments", () => {
  it("creates and lists pending future delivery commitments by task", () => {
    const row = createDeliveryCommitment({
      traceId: "trace-1",
      sessionId: "session-1",
      sourceMessageId: "assistant-1",
      taskId: "task-1",
      target: { type: "channel", channelId: "wechat-1", chatId: "chat-1" },
      artifactExpectation: { kind: "image", count: 3 },
    });

    expect(row.status).toBe("pending");
    expect(row.sourceMessageId).toBe("assistant-1");
    expect(row.target).toEqual({ type: "channel", channelId: "wechat-1", chatId: "chat-1" });
    expect(row.artifactExpectation).toEqual({ kind: "image", count: 3 });

    expect(findPendingDeliveryCommitmentsForTask("task-1")).toHaveLength(1);
    expect(findPendingDeliveryCommitmentsForTask("other-task")).toEqual([]);
  });

  it("marks commitments fulfilled with structured evidence", () => {
    const row = createDeliveryCommitment({
      traceId: "trace-2",
      sessionId: "session-2",
      taskId: "task-2",
      target: { type: "session", sessionId: "session-2" },
      artifactExpectation: { kind: "file" },
    });

    markDeliveryCommitmentFulfilled(row.id, [{
      deliveryLogId: "log-1",
      filename: "result.png",
      mimeType: "image/png",
      status: "delivered",
    }]);

    const updated = getDeliveryCommitment(row.id)!;
    expect(updated.status).toBe("fulfilled");
    expect(updated.fulfilledAt).toBeDefined();
    expect(updated.evidence).toEqual([expect.objectContaining({ deliveryLogId: "log-1", status: "delivered" })]);
    expect(findRecentDeliveryEvidence({ taskId: "task-2", status: "fulfilled" })).toHaveLength(1);
  });

  it("marks commitments failed and blocked without deleting the row", () => {
    const failed = createDeliveryCommitment({
      sessionId: "session-3",
      taskId: "task-3",
      target: { type: "session", sessionId: "session-3" },
      artifactExpectation: { kind: "image" },
    });
    const blocked = createDeliveryCommitment({
      sessionId: "session-4",
      taskId: "task-4",
      target: { type: "session", sessionId: "session-4" },
    });

    markDeliveryCommitmentFailed(failed.id, "no_deliverable_artifacts", [{ status: "failed", error: "missing file" }]);
    markDeliveryCommitmentBlocked(blocked.id, "ambiguous_dispatch");

    expect(getDeliveryCommitment(failed.id)).toEqual(expect.objectContaining({
      status: "failed",
      failureReason: "no_deliverable_artifacts",
    }));
    expect(getDeliveryCommitment(blocked.id)).toEqual(expect.objectContaining({
      status: "blocked",
      failureReason: "ambiguous_dispatch",
    }));
    expect(findRecentDeliveryEvidence({ status: "failed" }).map((item) => item.id)).toEqual([failed.id]);
  });
});
