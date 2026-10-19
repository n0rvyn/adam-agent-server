/**
 * Task 4-tests rewrite: selectInjectionBeliefs via memory-service wrapper
 *
 * Replaces old selectScopedBeliefsForContext tests (v2 champion/challenger model).
 * Tests the unified selectInjectionBeliefs path: active filter, context format, empty paths.
 *
 * Pre-impl: FAIL (selectInjectionBeliefs not yet implemented in belief-injection.ts).
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
  successEma?: number;
  scopeKey?: string | null;
  isAnti?: boolean;
}) {
  getTestDb().prepare(`
    INSERT INTO beliefs (id, role_id, content, is_anti, created_at, last_used_at, last_validated_at, status, success_ema, inject_count, scope_key)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?)
  `).run(
    opts.id,
    opts.roleId,
    opts.content,
    opts.isAnti ? 1 : 0,
    Date.now(),
    Date.now(),
    opts.status ?? "active",
    opts.successEma ?? 0.5,
    opts.scopeKey ?? null,
  );
}

describe("selectInjectionBeliefs (via memory-service / belief-injection)", () => {
  it("returns active beliefs in context format with [belief] prefix", async () => {
    const { getRelevantMemoryContext } = await import("../../agent/memory-service.js");
    const roleId = "role-scoped-1";
    seedRole(roleId);
    seedBelief({ id: "sb1", roleId, content: "always use ESM imports", successEma: 0.8 });

    const ctx = await getRelevantMemoryContext("typescript config", roleId);
    expect(ctx).toContain("[belief]");
    expect(ctx).toContain("always use ESM imports");
  });

  it("returns empty string for role with no active beliefs", async () => {
    const { getRelevantMemoryContext } = await import("../../agent/memory-service.js");
    const roleId = "role-scoped-empty";
    seedRole(roleId);

    const ctx = await getRelevantMemoryContext("any query", roleId);
    expect(ctx).toBe("");
  });

  it("formats anti-pattern beliefs with [anti-pattern] prefix", async () => {
    const { getRelevantMemoryContext } = await import("../../agent/memory-service.js");
    const roleId = "role-scoped-anti";
    seedRole(roleId);
    seedBelief({ id: "ab1", roleId, content: "never hardcode API keys", isAnti: true, successEma: 0.7 });

    const ctx = await getRelevantMemoryContext("security", roleId);
    expect(ctx).toContain("[anti-pattern]");
    expect(ctx).toContain("never hardcode API keys");
  });

  it("includes context header and [User Request] footer", async () => {
    const { getRelevantMemoryContext } = await import("../../agent/memory-service.js");
    const roleId = "role-scoped-header";
    seedRole(roleId);
    seedBelief({ id: "hb1", roleId, content: "context header test belief", successEma: 0.6 });

    const ctx = await getRelevantMemoryContext("test query", roleId);
    expect(ctx).toContain("[Memory Context");
    expect(ctx).toContain("[User Request]");
  });

  it("does not return archived beliefs", async () => {
    const { getRelevantMemoryContext } = await import("../../agent/memory-service.js");
    const roleId = "role-scoped-arch";
    seedRole(roleId);
    seedBelief({ id: "arch1", roleId, content: "this is archived", status: "archived", successEma: 0.9 });
    seedBelief({ id: "act1", roleId, content: "this is active", status: "active", successEma: 0.4 });

    const ctx = await getRelevantMemoryContext("query", roleId);
    expect(ctx).not.toContain("this is archived");
    expect(ctx).toContain("this is active");
  });
});
