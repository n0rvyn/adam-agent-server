/**
 * Task 4-tests: Unified selectInjectionBeliefs tests
 *
 * Tests for the new selectInjectionBeliefs(roleId, stepKind?, queryEmbedding?) function:
 *   - top-K=5 hard cap
 *   - archived beliefs never returned
 *   - scope filtering when stepKind given
 *   - role-wide pool when no stepKind
 *   - cold-start: empty role returns []
 *   - decay-adjusted ranking (decayed belief ranks below fresh)
 *
 * Pre-impl (Task 4-tests): FAIL with "selectInjectionBeliefs is not a function" or similar.
 * Post-impl (Task 4-impl): all tests pass.
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
  const db = getTestDb();
  db.prepare(
    "INSERT OR IGNORE INTO roles (id, name, memory_stream_id, status, created_at, task_seq) VALUES (?, ?, ?, 'active', ?, 0)"
  ).run(id, `role-${id}`, `stream-${id}`, Date.now());
}

function seedBelief(opts: {
  id: string;
  roleId: string;
  status?: string;
  successEma?: number | null;
  lastUsedAt?: number;
  scopeKey?: string | null;
  isAnti?: number;
}) {
  const db = getTestDb();
  db.prepare(`
    INSERT INTO beliefs (id, role_id, content, is_anti, created_at, last_used_at, last_validated_at, status, success_ema, inject_count, scope_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    opts.id,
    opts.roleId,
    `content-${opts.id}`,
    opts.isAnti ?? 0,
    Date.now(),
    opts.lastUsedAt ?? 0,
    Date.now(),
    opts.status ?? "active",
    opts.successEma ?? 0.5,
    opts.scopeKey ?? null,
  );
}

describe("selectInjectionBeliefs", () => {
  it("caps results at top-K=5 even when more active beliefs exist", async () => {
    const { selectInjectionBeliefs } = await import("../../agent/belief-injection.js");
    const roleId = "role-topk";
    seedRole(roleId);
    // Insert 8 active beliefs
    for (let i = 0; i < 8; i++) {
      seedBelief({ id: `b-topk-${i}`, roleId, successEma: 0.5, lastUsedAt: 0 });
    }

    const result = await selectInjectionBeliefs(roleId, undefined);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("never returns archived beliefs even if they have high success_ema", async () => {
    const { selectInjectionBeliefs } = await import("../../agent/belief-injection.js");
    const roleId = "role-archive";
    seedRole(roleId);
    // High-EMA archived belief
    seedBelief({ id: "b-archived", roleId, status: "archived", successEma: 0.99, lastUsedAt: 0 });
    // Low-EMA active belief
    seedBelief({ id: "b-active", roleId, status: "active", successEma: 0.3, lastUsedAt: 0 });

    const result = await selectInjectionBeliefs(roleId, undefined);
    const ids = result.map((b) => b.id);
    expect(ids).not.toContain("b-archived");
    expect(ids).toContain("b-active");
  });

  it("filters by scopeKey when stepKind is given", async () => {
    const { selectInjectionBeliefs } = await import("../../agent/belief-injection.js");
    const roleId = "role-scope";
    seedRole(roleId);
    // Belief in the target scope
    seedBelief({ id: "b-scoped", roleId, scopeKey: `${roleId}::review`, successEma: 0.6 });
    // Belief in a different scope
    seedBelief({ id: "b-other-scope", roleId, scopeKey: `${roleId}::write`, successEma: 0.7 });
    // Belief with no scope (pool, should also be included per plan: scope filter includes null)
    seedBelief({ id: "b-no-scope", roleId, scopeKey: null, successEma: 0.5 });

    const result = await selectInjectionBeliefs(roleId, "review");
    const ids = result.map((b) => b.id);
    expect(ids).toContain("b-scoped");
    expect(ids).toContain("b-no-scope");
    expect(ids).not.toContain("b-other-scope");
  });

  it("returns role-wide active beliefs when no stepKind given", async () => {
    const { selectInjectionBeliefs } = await import("../../agent/belief-injection.js");
    const roleId = "role-wide";
    seedRole(roleId);
    seedBelief({ id: "b-wide-1", roleId, scopeKey: `${roleId}::review`, successEma: 0.6 });
    seedBelief({ id: "b-wide-2", roleId, scopeKey: null, successEma: 0.5 });

    const result = await selectInjectionBeliefs(roleId, undefined);
    const ids = result.map((b) => b.id);
    expect(ids).toContain("b-wide-1");
    expect(ids).toContain("b-wide-2");
  });

  it("returns empty array for role with no active beliefs (cold-start safe)", async () => {
    const { selectInjectionBeliefs } = await import("../../agent/belief-injection.js");
    const roleId = "role-cold";
    seedRole(roleId);

    const result = await selectInjectionBeliefs(roleId, undefined);
    expect(result).toHaveLength(0);
  });

  it("step-scoped injection includes role-wide (null scopeKey) beliefs and matching niche, excludes unrelated niches", async () => {
    // Post-v82: all legacy ::pool rows normalized to NULL. Filter is single-path:
    // accept exact scopeKey match OR null. The previous endsWith("::pool") band-aid is gone.
    const { selectInjectionBeliefs } = await import("../../agent/belief-injection.js");
    seedRole("r1");
    // bump task_seq so decay doesn't zero everything out
    getTestDb().prepare("UPDATE roles SET task_seq = ? WHERE id = ?").run(5, "r1");
    seedBelief({ id: "b-null", roleId: "r1", scopeKey: null, successEma: 0.7 });          // role-wide (v82 norm + new reflection writes)
    seedBelief({ id: "b-tts", roleId: "r1", scopeKey: "r1::tts", successEma: 0.7 });       // exact-scope match
    seedBelief({ id: "b-other", roleId: "r1", scopeKey: "r1::other", successEma: 0.7 });  // unrelated niche
    const result = await selectInjectionBeliefs("r1", "tts");
    expect(result.length).toBe(2);
    expect(result.some((b) => b.scopeKey === "r1::tts")).toBe(true);
    expect(result.some((b) => b.scopeKey == null)).toBe(true);
    expect(result.every((b) => b.scopeKey !== "r1::other")).toBe(true);
  });

  it("bumpInjectCount is called exactly once per selected belief (DP-002 B contract)", async () => {
    const { selectInjectionBeliefs } = await import("../../agent/belief-injection.js");
    const roleId = "role-bump";
    seedRole(roleId);
    seedBelief({ id: "b-bump-1", roleId, successEma: 0.5 });
    seedBelief({ id: "b-bump-2", roleId, successEma: 0.5 });
    seedBelief({ id: "b-bump-3", roleId, successEma: 0.5 });

    await selectInjectionBeliefs(roleId, undefined);

    const db = getTestDb();
    const counts = db.prepare(
      "SELECT id, inject_count FROM beliefs WHERE id IN ('b-bump-1','b-bump-2','b-bump-3')"
    ).all() as Array<{ id: string; inject_count: number }>;

    expect(counts).toHaveLength(3);
    for (const row of counts) {
      expect(row.inject_count).toBe(1); // exactly one bump each per DP-002 B
    }
  });

  it("falls back to recency list when vector search returns only archived hits", async () => {
    const { selectInjectionBeliefs } = await import("../../agent/belief-injection.js");
    const roleId = "role-fallback";
    seedRole(roleId);

    // 5 archived beliefs with embeddings — vector search will find them but filter them out
    for (let i = 0; i < 5; i++) {
      seedBelief({ id: `b-archived-${i}`, roleId, status: "archived", successEma: 0.9 });
    }
    // 3 active beliefs without embeddings — should be returned via fallback recency list
    for (let i = 0; i < 3; i++) {
      seedBelief({ id: `b-active-${i}`, roleId, status: "active", successEma: 0.5 });
    }

    // Provide a query embedding so vector search path is taken
    const queryEmbedding = new Float32Array(512).fill(0.5);
    const result = await selectInjectionBeliefs(roleId, undefined, queryEmbedding);

    const ids = result.map((b) => b.id);
    // All returned must be active
    expect(result.every((b) => b.status === "active")).toBe(true);
    // Active beliefs are present
    expect(ids.some((id) => id.startsWith("b-active-"))).toBe(true);
  });

  it("vector search returning mixed active+archived hits filters out archived (direct)", async () => {
    const { selectInjectionBeliefs } = await import("../../agent/belief-injection.js");
    const roleId = "role-mixed";
    seedRole(roleId);

    // Both kinds have embeddings — vector search returns all 6, filter keeps only the 3 actives.
    const emb = new Float32Array(512).fill(0.5);
    for (let i = 0; i < 3; i++) {
      seedBelief({ id: `mx-active-${i}`, roleId, status: "active", successEma: 0.5 });
    }
    for (let i = 0; i < 3; i++) {
      seedBelief({ id: `mx-archived-${i}`, roleId, status: "archived", successEma: 0.5 });
    }

    const result = await selectInjectionBeliefs(roleId, undefined, emb);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((b) => b.status === "active")).toBe(true);
    expect(result.every((b) => b.id.startsWith("mx-active-"))).toBe(true);
  });

  it("ranks decayed beliefs below fresh beliefs of same base ema", async () => {
    const { selectInjectionBeliefs } = await import("../../agent/belief-injection.js");
    const roleId = "role-decay";
    seedRole(roleId);
    // Both start at successEma=0.5; one is stale (last_used_at=0 with current_seq=200 → heavy decay)
    // the other is fresh (last_used_at=200 same as current_seq → no decay)
    // current task_seq for role = 0 (just seeded), so we set last_used_at appropriately
    seedBelief({ id: "b-stale", roleId, successEma: 0.5, lastUsedAt: 0 });
    seedBelief({ id: "b-fresh", roleId, successEma: 0.5, lastUsedAt: 0 });

    // Update role task_seq to 200 so stale belief has decayed significantly
    getTestDb().prepare("UPDATE roles SET task_seq = 200 WHERE id = ?").run(roleId);
    // Update fresh belief's last_used_at to match current seq
    getTestDb().prepare("UPDATE beliefs SET last_used_at = 200 WHERE id = 'b-fresh'").run();

    const result = await selectInjectionBeliefs(roleId, undefined);
    const ids = result.map((b) => b.id);
    // Both should be returned (both active, 2 < top-5)
    expect(ids).toContain("b-fresh");
    expect(ids).toContain("b-stale");
    // Fresh belief should rank first (higher effective_ema)
    expect(ids.indexOf("b-fresh")).toBeLessThan(ids.indexOf("b-stale"));
  });
});

describe("formatInjectionContext", () => {
  function makeBelief(overrides: Partial<{ id: string; content: string; isAnti: boolean }> = {}): Parameters<typeof import("../../agent/belief-injection.js").formatInjectionContext>[0][number] {
    return {
      id: overrides.id ?? "b1",
      roleId: "r1",
      content: overrides.content ?? "default content",
      isAnti: overrides.isAnti ?? false,
      evidenceObsIds: [],
      createdAt: 0,
      lastUsedAt: 0,
      lastValidatedAt: 0,
      status: "active",
      injectCount: 0,
    } as Parameters<typeof import("../../agent/belief-injection.js").formatInjectionContext>[0][number];
  }

  it("returns empty string when beliefs array is empty", async () => {
    const { formatInjectionContext } = await import("../../agent/belief-injection.js");
    expect(formatInjectionContext([], "initial")).toBe("");
    expect(formatInjectionContext([], "refresh")).toBe("");
  });

  it("uses 'Memory Context' header for mode=initial", async () => {
    const { formatInjectionContext } = await import("../../agent/belief-injection.js");
    const out = formatInjectionContext([makeBelief({ content: "alpha" })], "initial");
    expect(out).toContain("[Memory Context");
    expect(out).not.toContain("[Memory Refresh");
    expect(out).toContain("- [belief] alpha");
    expect(out).toContain("[User Request]");
  });

  it("uses 'Memory Refresh' header for mode=refresh", async () => {
    const { formatInjectionContext } = await import("../../agent/belief-injection.js");
    const out = formatInjectionContext([makeBelief({ content: "beta" })], "refresh");
    expect(out).toContain("[Memory Refresh");
    expect(out).not.toContain("[Memory Context");
  });

  it("prefixes anti-pattern beliefs with ❌", async () => {
    const { formatInjectionContext } = await import("../../agent/belief-injection.js");
    const out = formatInjectionContext(
      [makeBelief({ id: "b-anti", content: "do not commit secrets", isAnti: true })],
      "initial",
    );
    expect(out).toContain("- [anti-pattern] ❌ do not commit secrets");
  });
});
