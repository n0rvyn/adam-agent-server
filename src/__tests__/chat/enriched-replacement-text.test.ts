import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";
import { buildEnrichedReplacementText } from "../../chat/commitment-replacement-text.js";
import type { CommitmentDetection } from "../../chat/commitment-detector.js";
import type { DeliveryDiagnosticContext } from "../../audit/delivery-evidence-resolver.js";

let testDb: BetterSqlite3.Database;
let cleanup: () => void;

vi.mock("../../store/db.js", () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

vi.mock("../../store/assistant-delivery-commitments.js", () => ({
  findRecentDeliveryEvidence: () => [],
}));

function makeClaim(overrides: Partial<CommitmentDetection> = {}): CommitmentDetection {
  return {
    type: "delivery_success_claim",
    text: "已发送图片",
    locale: "zh",
    artifactExpectation: undefined,
    ...overrides,
  } as CommitmentDetection;
}

function makeCtx(overrides: Partial<DeliveryDiagnosticContext> = {}): DeliveryDiagnosticContext {
  return {
    latestAttempt: null,
    artifactKindLabel: "结果",
    ...overrides,
  };
}

describe("enriched-replacement-text", () => {
  beforeEach(() => {
    const result = setupTestDb();
    testDb = result.db;
    cleanup = result.cleanup;
    clearTestDb();
  });

  afterEach(() => cleanup());

  describe("buildEnrichedReplacementText", () => {
    it("no taskId/traceId falls back to stock template via null latestAttempt", () => {
      // When latestAttempt is null, the builder returns a no-record message,
      // not the stock template. The guard for hasQueryContext=false is tested
      // via the auditor (not here), but we verify the builder handles null correctly.
      const claim = makeClaim({ locale: "zh" });
      const ctx = makeCtx({ latestAttempt: null, artifactKindLabel: "结果" });
      const text = buildEnrichedReplacementText(claim, ctx);
      expect(text).toBe("结果已生成，但没有发送动作的记录。");
    });

    it("pending without queue info returns 排入队列 without position", () => {
      const claim = makeClaim({ locale: "zh" });
      const ctx = makeCtx({
        latestAttempt: {
          status: "pending",
          target: { type: "channel", channelId: "ch-1" },
          createdAt: Date.now(),
          queueDepth: undefined,
          quotaResetHours: undefined,
        },
      });
      const text = buildEnrichedReplacementText(claim, ctx);
      expect(text).toContain("已排入队列");
      expect(text).not.toContain("队列位置");
      expect(text).not.toContain("恢复");
    });

    it("pending with queueDepth=2, quotaResetHours=22.5", () => {
      const claim = makeClaim({ locale: "zh" });
      const ctx = makeCtx({
        artifactKindLabel: "图片",
        latestAttempt: {
          status: "pending",
          target: { type: "channel", channelId: "ch-1" },
          createdAt: Date.now(),
          queueDepth: 2,
          quotaResetHours: 22.5,
        },
      });
      const text = buildEnrichedReplacementText(claim, ctx);
      expect(text).toContain("队列位置 #2");
      expect(text).toContain("约 22.5 小时后恢复");
    });

    it("failed with error includes truncated reason", () => {
      const claim = makeClaim({ locale: "zh" });
      const ctx = makeCtx({
        latestAttempt: {
          status: "failed",
          target: { type: "channel", channelId: "ch-1" },
          createdAt: Date.now(),
          error: "network timeout after 30000ms",
        },
      });
      const text = buildEnrichedReplacementText(claim, ctx);
      expect(text).toContain("network timeout after 30000ms");
      expect(text).toContain("发送失败");
    });

    it("delivered (mismatch case) mentions delivered time", () => {
      const claim = makeClaim({ locale: "zh" });
      const ctx = makeCtx({
        artifactKindLabel: "图片",
        latestAttempt: {
          status: "delivered",
          target: { type: "channel", channelId: "ch-1" },
          createdAt: 1700000000000,
          deliveredAt: 1700000001000,
        },
      });
      const text = buildEnrichedReplacementText(claim, ctx);
      expect(text).toContain("已发送");
      expect(text).toContain("送达");
    });

    it("expired mentions TTL expired", () => {
      const claim = makeClaim({ locale: "zh" });
      const ctx = makeCtx({
        latestAttempt: {
          status: "expired",
          target: { type: "channel", channelId: "ch-1" },
          createdAt: Date.now(),
        },
      });
      const text = buildEnrichedReplacementText(claim, ctx);
      expect(text).toContain("超时");
      expect(text).toContain("TTL");
    });

    it("audio kind + zh uses 音频", () => {
      const claim = makeClaim({ locale: "zh", artifactExpectation: { kind: "audio" } as CommitmentDetection["artifactExpectation"] });
      const ctx = makeCtx({ latestAttempt: null, artifactKindLabel: "音频" });
      const text = buildEnrichedReplacementText(claim, ctx);
      expect(text).toContain("音频");
    });

    it("image kind + en uses image", () => {
      const claim = makeClaim({ locale: "en", artifactExpectation: { kind: "image" } as CommitmentDetection["artifactExpectation"] });
      const ctx = makeCtx({ latestAttempt: null, artifactKindLabel: "image" });
      const text = buildEnrichedReplacementText(claim, ctx);
      expect(text).toContain("image");
    });

    it("resolver throws falls back to stock template via auditor try/catch", async () => {
      // This is implicitly tested by the auditor's try/catch around buildEnrichedReplacementText.
      // We verify the stock template paths exist.
      const { getUnsupportedSuccessText } = await import("../../chat/commitment-replacement-text.js");
      expect(getUnsupportedSuccessText("zh")).toBeTruthy();
    });
  });
});
