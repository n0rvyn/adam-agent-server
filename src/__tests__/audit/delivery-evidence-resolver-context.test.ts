import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";
import { resolveDeliveryDiagnosticContext } from "../../audit/delivery-evidence-resolver.js";
import type { CommitmentDetection } from "../../chat/commitment-detector.js";

let testDb: BetterSqlite3.Database;
let cleanup: () => void;

vi.mock("../../store/db.js", () => ({
  getDb: () => testDb,
  closeDb: () => {},
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

function insertDeliveryLog(overrides: Record<string, unknown> = {}): void {
  const now = Date.now();
  testDb.prepare(`
    INSERT INTO delivery_log (id, rule_id, task_id, status, target, content, attempts, error, created_at, delivered_at, expires_at, source, message_type, trace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.id ?? `log-${Math.random().toString(36).slice(2)}`,
    overrides.rule_id ?? null,
    overrides.task_id ?? null,
    overrides.status ?? "pending",
    overrides.target ?? JSON.stringify({ type: "channel", channelId: "ch-1" }),
    overrides.content ?? "test",
    overrides.attempts ?? 0,
    overrides.error ?? null,
    overrides.created_at ?? now,
    overrides.delivered_at ?? null,
    overrides.expires_at ?? now + 86400000,
    overrides.source ?? null,
    overrides.message_type ?? null,
    overrides.trace_id ?? null,
  );
}

describe("delivery-evidence-resolver-context", () => {
  beforeEach(() => {
    const result = setupTestDb();
    testDb = result.db;
    cleanup = result.cleanup;
    clearTestDb();
  });

  afterEach(() => cleanup());

  describe("resolveDeliveryDiagnosticContext", () => {
    it("delivery_log empty returns latestAttempt null, artifactKindLabel=结果 (zh)", () => {
      const claim = makeClaim({ locale: "zh" });
      const ctx = resolveDeliveryDiagnosticContext(claim, { taskId: "task-1" });
      expect(ctx.latestAttempt).toBeNull();
      expect(ctx.artifactKindLabel).toBe("结果");
    });

    it("delivery_log has status=pending returns full row", () => {
      insertDeliveryLog({ task_id: "task-1", status: "pending", created_at: 1700000000000 });
      const claim = makeClaim({ locale: "zh" });
      const ctx = resolveDeliveryDiagnosticContext(claim, { taskId: "task-1" });
      expect(ctx.latestAttempt).not.toBeNull();
      expect(ctx.latestAttempt!.status).toBe("pending");
      expect(ctx.latestAttempt!.createdAt).toBe(1700000000000);
    });

    it("delivery_log has status=failed with error", () => {
      insertDeliveryLog({ task_id: "task-1", status: "failed", error: "network error", created_at: 1700000000000 });
      const claim = makeClaim({ locale: "zh" });
      const ctx = resolveDeliveryDiagnosticContext(claim, { taskId: "task-1" });
      expect(ctx.latestAttempt!.status).toBe("failed");
      expect(ctx.latestAttempt!.error).toBe("network error");
    });

    it("claim.artifactExpectation.kind=audio + zh locale returns label=音频", () => {
      const claim = makeClaim({ locale: "zh", artifactExpectation: { kind: "audio" } as CommitmentDetection["artifactExpectation"] });
      const ctx = resolveDeliveryDiagnosticContext(claim, { taskId: "task-1" });
      expect(ctx.artifactKindLabel).toBe("音频");
    });

    it("claim.artifactExpectation.kind=image + en locale returns label=image", () => {
      const claim = makeClaim({ locale: "en", artifactExpectation: { kind: "image" } as CommitmentDetection["artifactExpectation"] });
      const ctx = resolveDeliveryDiagnosticContext(claim, { taskId: "task-1" });
      expect(ctx.artifactKindLabel).toBe("image");
    });

    it("taskId provided + traceId absent queries by taskId", () => {
      insertDeliveryLog({ task_id: "task-only", status: "pending", trace_id: null });
      const claim = makeClaim({ locale: "zh" });
      const ctx = resolveDeliveryDiagnosticContext(claim, { taskId: "task-only" });
      expect(ctx.latestAttempt).not.toBeNull();
    });

    it("traceId only queries by traceId", () => {
      insertDeliveryLog({ task_id: null, trace_id: "trace-only", status: "delivered", delivered_at: 1700000000000 });
      const claim = makeClaim({ locale: "zh" });
      const ctx = resolveDeliveryDiagnosticContext(claim, { traceId: "trace-only" });
      expect(ctx.latestAttempt).not.toBeNull();
      expect(ctx.latestAttempt!.status).toBe("delivered");
    });

    it("neither taskId nor traceId returns latestAttempt null", () => {
      const claim = makeClaim({ locale: "zh" });
      const ctx = resolveDeliveryDiagnosticContext(claim, {});
      expect(ctx.latestAttempt).toBeNull();
    });
  });
});
