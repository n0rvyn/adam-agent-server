/**
 * Task 4-tests rewrite: belief retrieval with unified selectInjectionBeliefs scoring
 *
 * Replaces old 5-factor compositeScore tests (v2: confidence/useCount/successCount).
 * Tests the new unified EMA-based score path via selectInjectionBeliefs and getRelevantMemoryContext.
 *
 * Pre-impl: FAIL (selectInjectionBeliefs not yet implemented).
 * Post-impl: all tests pass.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({
    memory: {
      scope: {
        archiveThreshold: 0.2,
        decayBase: 0.995,
        emaAlpha: 0.3,
        reflectionPoolMax: 100,
      },
    },
  }),
}));

vi.mock("../../lib/embedding.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(512).fill(0.5)),
  EMBEDDING_DIMENSION: 512,
  isModelAvailable: vi.fn().mockReturnValue(false),
}));

const { cleanup } = setupTestDb();
afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedRole(id: string) {
  getTestDb().prepare(
    "INSERT OR IGNORE INTO roles (id, name, memory_stream_id, status, created_at, task_seq) VALUES (?, ?, ?, 'active', ?, 0)"
  ).run(id, `role-${id}`, `stream-${id}`, Date.now());
}

function seedBelief(opts: {
  id: string;
  roleId: string;
  content: string;
  status?: string;
  successEma?: number | null;
  lastUsedAt?: number;
  isAnti?: boolean;
}) {
  getTestDb().prepare(`
    INSERT INTO beliefs (id, role_id, content, is_anti, created_at, last_used_at, last_validated_at, status, success_ema, inject_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    opts.id,
    opts.roleId,
    opts.content,
    opts.isAnti ? 1 : 0,
    Date.now(),
    opts.lastUsedAt ?? 0,
    Date.now(),
    opts.status ?? "active",
    opts.successEma ?? 0.5,
  );
}

describe("belief-retrieval (unified EMA scoring)", () => {
  it("returns empty result for role with zero beliefs", async () => {
    const { getRelevantMemoryContext } = await import("../../agent/memory-service.js");
    seedRole("role-empty");

    const ctx = await getRelevantMemoryContext("any query", "role-empty");
    expect(ctx).toBe("");
  });

  it("returns empty string when roleId is undefined", async () => {
    const { getRelevantMemoryContext } = await import("../../agent/memory-service.js");

    const ctx = await getRelevantMemoryContext("any query", undefined);
    expect(ctx).toBe("");
  });

  it("selects active beliefs and formats with [belief] prefix", async () => {
    const { getRelevantMemoryContext } = await import("../../agent/memory-service.js");
    seedRole("role-test");
    seedBelief({ id: "br1", roleId: "role-test", content: "TypeScript strict mode is configured" });

    const ctx = await getRelevantMemoryContext("typescript config", "role-test");
    expect(ctx).toContain("[belief]");
    expect(ctx).toContain("TypeScript strict mode is configured");
  });

  it("formats anti-pattern beliefs with [anti-pattern] prefix and red marker", async () => {
    const { getRelevantMemoryContext } = await import("../../agent/memory-service.js");
    seedRole("role-anti");
    seedBelief({
      id: "br-anti",
      roleId: "role-anti",
      content: "Never skip type checking",
      isAnti: true,
    });

    const ctx = await getRelevantMemoryContext("type checking", "role-anti");
    expect(ctx).toContain("[anti-pattern]");
    expect(ctx).toContain("Never skip type checking");
  });

  it("wraps output with context header and [User Request] footer", async () => {
    const { getRelevantMemoryContext } = await import("../../agent/memory-service.js");
    seedRole("role-header");
    seedBelief({ id: "br-hdr", roleId: "role-header", content: "header test belief" });

    const ctx = await getRelevantMemoryContext("testing", "role-header");
    expect(ctx).toContain("[Memory Context");
    expect(ctx).toContain("[User Request]");
  });

  it("high-EMA active belief ranked above low-EMA active belief", async () => {
    const { selectInjectionBeliefs } = await import("../../agent/belief-injection.js");
    seedRole("role-rank");
    seedBelief({ id: "br-high", roleId: "role-rank", content: "high ema belief", successEma: 0.9, lastUsedAt: 0 });
    seedBelief({ id: "br-low", roleId: "role-rank", content: "low ema belief", successEma: 0.1, lastUsedAt: 0 });

    const results = await selectInjectionBeliefs("role-rank", undefined);
    const ids = results.map((b) => b.id);
    expect(ids.indexOf("br-high")).toBeLessThan(ids.indexOf("br-low"));
  });
});
