import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  createMemory,
  getMemory,
  listMemoriesByRole,
  searchByBM25,
  searchByVector,
  searchHybrid,
  deleteMemory,
  calculateRecency,
  calculateSmallvilleScore,
  cleanupMemories,
  markSuperseded,
  updateMemoryRetrievalCount,
  DEFAULT_SCORING_WEIGHTS,
} from "../../store/memories.js";
import type { MemoryNode, Role } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedAgent(id = "agent-1"): Role {
  const agent: Role = {
    id,
    name: `Test Agent ${id}`,
    cagPrompt: "",
    preferences: {},
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `stream-${id}`,
    status: "active",
    createdAt: Date.now(),
  };
  createRole(agent);
  return agent;
}

function makeMemory(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: overrides.id ?? `mem-${Math.random().toString(36).slice(2)}`,
    roleId: overrides.roleId ?? "agent-1",
    type: overrides.type ?? "event",
    content: overrides.content ?? "Test memory content",
    keywords: overrides.keywords ?? ["test", "memory"],
    importance: overrides.importance ?? 3,
    sourceType: overrides.sourceType ?? "task_complete",
    sourceTaskId: overrides.sourceTaskId,
    evidence: overrides.evidence,
    createdAt: overrides.createdAt ?? Date.now(),
    lastAccessed: overrides.lastAccessed ?? Date.now(),
    retrievedCount: overrides.retrievedCount ?? 0,
    tier: (overrides.tier as MemoryNode["tier"]) ?? "episodic",
    supersededBy: overrides.supersededBy,
    embedding: overrides.embedding,
  };
}

describe("store/memories", () => {
  describe("createMemory + getMemory", () => {
    it("should create and retrieve a memory", () => {
      seedAgent();
      const mem = makeMemory({ id: "mem-1" });
      createMemory(mem);

      const retrieved = getMemory("mem-1");
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe("mem-1");
      expect(retrieved!.content).toBe("Test memory content");
      expect(retrieved!.importance).toBe(3);
      expect(retrieved!.type).toBe("event");
      expect(retrieved!.keywords).toEqual(["test", "memory"]);
    });

    it("should return undefined for non-existent memory", () => {
      const result = getMemory("nonexistent");
      expect(result).toBeUndefined();
    });

    it("should store and retrieve embedding", () => {
      seedAgent();
      const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
      const mem = makeMemory({ id: "mem-emb", embedding });
      createMemory(mem);

      const retrieved = getMemory("mem-emb");
      expect(retrieved).toBeDefined();
      expect(retrieved!.embedding).toBeDefined();
      expect(retrieved!.embedding!.length).toBe(4);
      expect(retrieved!.embedding![0]).toBeCloseTo(0.1);
    });
  });

  describe("listMemoriesByRole", () => {
    it("should list memories for a specific role", () => {
      seedAgent("agent-1");
      seedAgent("agent-2");
      createMemory(makeMemory({ id: "m1", roleId: "agent-1" }));
      createMemory(makeMemory({ id: "m2", roleId: "agent-1" }));
      createMemory(makeMemory({ id: "m3", roleId: "agent-2" }));

      const result = listMemoriesByRole("agent-1");
      expect(result.length).toBe(2);
      expect(result.every((m: MemoryNode) => m.roleId === "agent-1")).toBe(true);
    });

    it("should return empty array for role with no memories", () => {
      seedAgent("agent-empty");
      const result = listMemoriesByRole("agent-empty");
      expect(result).toEqual([]);
    });

    it("should respect limit and offset", () => {
      seedAgent();
      for (let i = 0; i < 5; i++) {
        createMemory(makeMemory({ id: `m-${i}`, createdAt: Date.now() - i * 1000 }));
      }
      const page = listMemoriesByRole("agent-1", 2, 1);
      expect(page.length).toBe(2);
    });
  });

  describe("searchByBM25 (FTS5)", () => {
    it("should find memories by content keyword", () => {
      seedAgent();
      createMemory(makeMemory({ id: "fts-1", content: "TypeScript compiler optimization" }));
      createMemory(makeMemory({ id: "fts-2", content: "Python data analysis" }));

      const results = searchByBM25("agent-1", "TypeScript", 10);
      expect(results.length).toBe(1);
      expect(results[0].node.id).toBe("fts-1");
      expect(results[0].bm25).toBeGreaterThan(0);
    });

    it("should find memories by keywords field", () => {
      seedAgent();
      createMemory(makeMemory({
        id: "fts-k1",
        content: "Some content here",
        keywords: ["refactoring", "cleanup"],
      }));

      const results = searchByBM25("agent-1", "refactoring", 10);
      expect(results.length).toBe(1);
      expect(results[0].node.id).toBe("fts-k1");
    });

    it("should not return results from different role", () => {
      seedAgent("agent-a");
      seedAgent("agent-b");
      createMemory(makeMemory({ id: "fts-a", roleId: "agent-a", content: "shared keyword unique" }));
      createMemory(makeMemory({ id: "fts-b", roleId: "agent-b", content: "shared keyword unique" }));

      const results = searchByBM25("agent-a", "shared", 10);
      expect(results.length).toBe(1);
      expect(results[0].node.roleId).toBe("agent-a");
    });
  });

  describe("deleteMemory", () => {
    it("should delete a memory", () => {
      seedAgent();
      createMemory(makeMemory({ id: "del-1" }));
      expect(getMemory("del-1")).toBeDefined();

      deleteMemory("del-1");
      expect(getMemory("del-1")).toBeUndefined();
    });
  });

  describe("updateMemoryRetrievalCount", () => {
    it("should increment retrieval count and update last_accessed", () => {
      seedAgent();
      const pastTime = Date.now() - 100000;
      createMemory(makeMemory({ id: "ret-1", lastAccessed: pastTime, retrievedCount: 0 }));

      updateMemoryRetrievalCount("ret-1");
      const updated = getMemory("ret-1");
      expect(updated!.retrievedCount).toBe(1);
      expect(updated!.lastAccessed).toBeGreaterThan(pastTime);
    });
  });

  describe("calculateRecency", () => {
    it("should return ~1 for very recent memories", () => {
      const score = calculateRecency(Date.now());
      expect(score).toBeGreaterThan(0.99);
    });

    it("should return lower score for older memories", () => {
      const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
      const score = calculateRecency(twoDaysAgo);
      expect(score).toBeLessThan(1);
      expect(score).toBeGreaterThan(0);
    });

    it("should decay over time", () => {
      const recent = calculateRecency(Date.now() - 1 * 24 * 60 * 60 * 1000);
      const old = calculateRecency(Date.now() - 10 * 24 * 60 * 60 * 1000);
      expect(recent).toBeGreaterThan(old);
    });
  });

  describe("calculateSmallvilleScore", () => {
    it("should combine recency, relevance, and importance", () => {
      const score = calculateSmallvilleScore(Date.now(), 0.8, 4);
      expect(score).toBeGreaterThan(0);
    });

    it("should give higher score to more important memories", () => {
      const now = Date.now();
      const lowImportance = calculateSmallvilleScore(now, 0.5, 1);
      const highImportance = calculateSmallvilleScore(now, 0.5, 5);
      expect(highImportance).toBeGreaterThan(lowImportance);
    });

    it("should respect custom weights", () => {
      const now = Date.now();
      const importanceHeavy = calculateSmallvilleScore(now, 0.5, 5, {
        recency: 0,
        relevance: 0,
        importance: 10,
      });
      expect(importanceHeavy).toBeCloseTo(10 * (5 / 5));
    });
  });

  describe("searchHybrid", () => {
    it("works without roleId filter", () => {
      seedAgent("agent-x");
      seedAgent("agent-y");

      const embedding = new Float32Array(384).fill(0.1);
      createMemory(makeMemory({
        id: "sh-1",
        roleId: "agent-x",
        content: "vector search optimization techniques",
        embedding,
      }));
      createMemory(makeMemory({
        id: "sh-2",
        roleId: "agent-y",
        content: "vector search performance tuning",
        embedding,
      }));

      const queryEmbedding = new Float32Array(384).fill(0.1);
      const results = searchHybrid(undefined, queryEmbedding, "vector search", 10);

      // With undefined roleId, results should include memories from both roles
      expect(results.length).toBeGreaterThanOrEqual(2);
      const roleIds = new Set(results.map((r) => r.node.roleId));
      expect(roleIds.has("agent-x")).toBe(true);
      expect(roleIds.has("agent-y")).toBe(true);
    });

    // GAP-10 coverage — magnitude-preserving hybrid
    it("exposes cosine and bm25 magnitudes alongside combinedRelevance", () => {
      seedAgent();
      const embedding = new Float32Array(384).fill(0.1);
      createMemory(makeMemory({
        id: "gap10-vec",
        content: "magnitude preservation check content",
        embedding,
      }));

      const queryEmbedding = new Float32Array(384).fill(0.1);
      const results = searchHybrid("agent-1", queryEmbedding, "magnitude preservation", 10);
      expect(results.length).toBe(1);
      expect(results[0].cosine).toBeGreaterThan(0.99); // parallel vectors → ≈1
      expect(results[0].cosine).toBeLessThanOrEqual(1);
      expect(results[0].bm25).toBeGreaterThan(0);
      expect(results[0].combinedRelevance).toBeGreaterThan(0);
      expect(results[0].combinedRelevance).toBeLessThanOrEqual(1);
    });

    it("ranks BM25-only matches (no embedding) alongside vector matches", () => {
      // GAP-10: BM25 magnitude now reaches the final score. A memory with no
      // embedding but a strong BM25 hit should survive the hybrid pool.
      seedAgent();
      const embedding = new Float32Array(384).fill(0.5);
      createMemory(makeMemory({
        id: "gap10-vec-only",
        content: "unrelated wording here",
        embedding,
      }));
      createMemory(makeMemory({
        id: "gap10-bm25-only",
        content: "quokka saturn very unique phrase",
        // No embedding on purpose — BM25-only candidate
      }));

      const queryEmb = new Float32Array(384).fill(0.0); // zero vector → cosine 0 for everything
      const results = searchHybrid("agent-1", queryEmb, "quokka saturn", 10);
      const ids = new Set(results.map((r) => r.node.id));
      expect(ids.has("gap10-bm25-only")).toBe(true);
      const bm25OnlyHit = results.find((r) => r.node.id === "gap10-bm25-only")!;
      expect(bm25OnlyHit.cosine).toBe(0);
      expect(bm25OnlyHit.bm25).toBeGreaterThan(0);
      expect(bm25OnlyHit.combinedRelevance).toBeGreaterThan(0);
    });

    it("assigns bm25Norm=1 to every BM25 hit when scores are tied (min==max)", () => {
      // When every BM25-matched candidate shares the same score, they've all
      // matched BM25 equally well — each gets the full BM25 weight. This beats
      // the "pretend no match happened" alternative which would underweight
      // BM25 whenever a single dominant match exists.
      seedAgent();
      const embedding = new Float32Array(384).fill(0.3);
      for (let i = 0; i < 3; i++) {
        createMemory(makeMemory({
          id: `gap10-equal-${i}`,
          content: "identical phrase wording",
          embedding,
        }));
      }
      const queryEmb = new Float32Array(384).fill(0.3);
      const results = searchHybrid("agent-1", queryEmb, "identical phrase", 10);
      expect(results.length).toBe(3);
      for (const r of results) {
        expect(r.cosine).toBeGreaterThan(0.99);
        // combinedRelevance = vectorWeight*cosine + bm25Weight*1
        // = 0.6*~1 + 0.4*1 = ~1.0
        expect(r.combinedRelevance).toBeCloseTo(0.6 * r.cosine + 0.4, 5);
      }
    });

    it("returns bm25Norm=0 for vector-only arrivals even when pool has BM25 hits", () => {
      // A memory that matched via vector but not BM25 has bm25=0 and should
      // contribute nothing from the BM25 term, regardless of other memories'
      // BM25 scores.
      seedAgent();
      const embedding = new Float32Array(384).fill(0.3);
      createMemory(makeMemory({
        id: "vector-only",
        content: "alpha beta gamma filler",
        embedding,
      }));
      createMemory(makeMemory({
        id: "bm25-matched",
        content: "zephyrion unique keyword present",
        embedding,
      }));
      const queryEmb = new Float32Array(384).fill(0.3);
      const results = searchHybrid("agent-1", queryEmb, "zephyrion", 10);
      const vectorOnly = results.find((r) => r.node.id === "vector-only")!;
      expect(vectorOnly.bm25).toBe(0);
      // combinedRelevance for vector-only = 0.6 * cosine only
      expect(vectorOnly.combinedRelevance).toBeCloseTo(0.6 * vectorOnly.cosine, 5);
    });

    it("post-filters BM25-only arrivals by tier and excludeSuperseded", () => {
      seedAgent();
      const embedding = new Float32Array(384).fill(0.4);

      // Episodic memory that would match BM25 but is filtered out by tier option
      createMemory(makeMemory({
        id: "gap10-epi-bm25",
        tier: "episodic",
        content: "octopus tangerine alignment",
        // no embedding
      }));
      // Semantic memory that should survive the tier filter
      createMemory(makeMemory({
        id: "gap10-sem-bm25",
        tier: "semantic",
        content: "octopus tangerine alignment",
        embedding,
      }));
      // Superseded memory — excluded even if it matches
      createMemory(makeMemory({
        id: "gap10-superseded",
        tier: "semantic",
        content: "octopus tangerine alignment",
        embedding,
        supersededBy: "ref-x",
      }));

      const queryEmb = new Float32Array(384).fill(0.4);
      const results = searchHybrid("agent-1", queryEmb, "octopus tangerine", 10, undefined, {
        tiers: ["semantic"],
        excludeSuperseded: true,
      });
      const ids = new Set(results.map((r) => r.node.id));
      expect(ids.has("gap10-sem-bm25")).toBe(true);
      expect(ids.has("gap10-epi-bm25")).toBe(false);
      expect(ids.has("gap10-superseded")).toBe(false);
    });
  });

  describe("cleanupMemories", () => {
    it("should delete memories older than maxAgeDays", () => {
      seedAgent();
      const oldTime = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 days ago
      createMemory(makeMemory({ id: "old-1", createdAt: oldTime, lastAccessed: oldTime }));
      createMemory(makeMemory({ id: "new-1" }));

      const deleted = cleanupMemories("agent-1", 10000, 90);
      expect(deleted).toBe(1);
      expect(getMemory("old-1")).toBeUndefined();
      expect(getMemory("new-1")).toBeDefined();
    });

    it("should delete excess memories beyond maxMemories", () => {
      seedAgent();
      for (let i = 0; i < 5; i++) {
        createMemory(makeMemory({ id: `excess-${i}`, createdAt: Date.now() - i * 1000 }));
      }

      const deleted = cleanupMemories("agent-1", 2, 365);
      expect(deleted).toBe(3);
      const remaining = listMemoriesByRole("agent-1");
      expect(remaining.length).toBe(2);
    });

    it("Phase 1: should delete superseded memories older than 7 days but keep recent superseded", () => {
      seedAgent();
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;

      // Old superseded → should be deleted
      createMemory(makeMemory({
        id: "sup-old",
        createdAt: eightDaysAgo,
        lastAccessed: eightDaysAgo,
        supersededBy: "reflection-1",
      }));
      // Recent superseded → should be kept (audit trail)
      createMemory(makeMemory({
        id: "sup-recent",
        createdAt: twoDaysAgo,
        lastAccessed: twoDaysAgo,
        supersededBy: "reflection-2",
      }));
      // Not superseded → should be kept
      createMemory(makeMemory({ id: "not-sup", createdAt: eightDaysAgo, lastAccessed: eightDaysAgo, importance: 5 }));

      const deleted = cleanupMemories("agent-1", 10000, 365);
      expect(deleted).toBeGreaterThanOrEqual(1);
      expect(getMemory("sup-old")).toBeUndefined();
      expect(getMemory("sup-recent")).toBeDefined();
      expect(getMemory("not-sup")).toBeDefined();
    });

    it("Phase 2: should delete unretrieved low-importance memories older than 30 days", () => {
      seedAgent();
      const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;

      // Unretrieved, low importance, old → deleted
      createMemory(makeMemory({
        id: "unret-low",
        createdAt: fortyDaysAgo,
        lastAccessed: fortyDaysAgo,
        retrievedCount: 0,
        importance: 2,
      }));
      // Retrieved, low importance, old → kept
      createMemory(makeMemory({
        id: "ret-low",
        createdAt: fortyDaysAgo,
        lastAccessed: fortyDaysAgo,
        retrievedCount: 3,
        importance: 2,
      }));
      // Unretrieved, high importance, old → kept (by phase 2; phase 3 may apply)
      createMemory(makeMemory({
        id: "unret-high",
        createdAt: fortyDaysAgo,
        lastAccessed: fortyDaysAgo,
        retrievedCount: 0,
        importance: 4,
      }));

      const deleted = cleanupMemories("agent-1", 10000, 365);
      expect(deleted).toBeGreaterThanOrEqual(1);
      expect(getMemory("unret-low")).toBeUndefined();
      expect(getMemory("ret-low")).toBeDefined();
      expect(getMemory("unret-high")).toBeDefined();
    });

    it("Phase 3: should delete old memories with importance < 4 but keep importance >= 4", () => {
      seedAgent();
      const oldTime = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 days ago

      // Old, importance 3 → deleted
      createMemory(makeMemory({
        id: "aged-low",
        createdAt: oldTime,
        lastAccessed: oldTime,
        importance: 3,
        retrievedCount: 5, // has retrievals, but importance < 4
      }));
      // Old, importance 4 → kept
      createMemory(makeMemory({
        id: "aged-high",
        createdAt: oldTime,
        lastAccessed: oldTime,
        importance: 4,
        retrievedCount: 0,
      }));
      // Old, importance 5 → kept
      createMemory(makeMemory({
        id: "aged-max",
        createdAt: oldTime,
        lastAccessed: oldTime,
        importance: 5,
      }));

      const deleted = cleanupMemories("agent-1", 10000, 90);
      expect(deleted).toBeGreaterThanOrEqual(1);
      expect(getMemory("aged-low")).toBeUndefined();
      expect(getMemory("aged-high")).toBeDefined();
      expect(getMemory("aged-max")).toBeDefined();
    });

    it("Phase 4: should delete excess non-semantic memories by importance ASC, protect semantic tier", () => {
      seedAgent();
      // Create 5 memories: 2 semantic + 3 episodic
      createMemory(makeMemory({ id: "sem-1", tier: "semantic", importance: 1 }));
      createMemory(makeMemory({ id: "sem-2", tier: "semantic", importance: 2 }));
      createMemory(makeMemory({ id: "epi-1", tier: "episodic", importance: 1, retrievedCount: 0 }));
      createMemory(makeMemory({ id: "epi-2", tier: "episodic", importance: 3, retrievedCount: 5 }));
      createMemory(makeMemory({ id: "epi-3", tier: "episodic", importance: 2, retrievedCount: 0 }));

      // maxMemories = 3: excess = 5 - 3 = 2 → should delete 2 non-semantic lowest
      const deleted = cleanupMemories("agent-1", 3, 365);
      expect(deleted).toBeGreaterThanOrEqual(2);
      // Semantic memories should survive regardless of low importance
      expect(getMemory("sem-1")).toBeDefined();
      expect(getMemory("sem-2")).toBeDefined();
      // epi-1 (importance 1, retrievedCount 0) and epi-3 (importance 2, retrievedCount 0) should be deleted
      expect(getMemory("epi-1")).toBeUndefined();
      expect(getMemory("epi-3")).toBeUndefined();
      // epi-2 (importance 3, retrievedCount 5) should survive
      expect(getMemory("epi-2")).toBeDefined();
    });
  });

  describe("searchByVector with options", () => {
    it("should filter by tier when tiers option is provided", () => {
      seedAgent();
      const embedding = new Float32Array(384).fill(0.1);

      createMemory(makeMemory({ id: "vec-epi", tier: "episodic", embedding }));
      createMemory(makeMemory({ id: "vec-sem", tier: "semantic", embedding }));
      createMemory(makeMemory({ id: "vec-wrk", tier: "working", embedding }));

      const queryEmb = new Float32Array(384).fill(0.1);
      const results = searchByVector("agent-1", queryEmb, 10, { tiers: ["semantic"] });
      expect(results.length).toBe(1);
      expect(results[0].node.id).toBe("vec-sem");
      expect(results[0].cosine).toBeGreaterThan(0);
      expect(results[0].cosine).toBeLessThanOrEqual(1);
    });

    it("should filter by multiple tiers", () => {
      seedAgent();
      const embedding = new Float32Array(384).fill(0.2);

      createMemory(makeMemory({ id: "mt-epi", tier: "episodic", embedding }));
      createMemory(makeMemory({ id: "mt-sem", tier: "semantic", embedding }));
      createMemory(makeMemory({ id: "mt-wrk", tier: "working", embedding }));

      const queryEmb = new Float32Array(384).fill(0.2);
      const results = searchByVector("agent-1", queryEmb, 10, { tiers: ["semantic", "working"] });
      expect(results.length).toBe(2);
      const ids = results.map((r) => r.node.id).sort();
      expect(ids).toEqual(["mt-sem", "mt-wrk"]);
    });

    it("should exclude superseded memories when excludeSuperseded is true", () => {
      seedAgent();
      const embedding = new Float32Array(384).fill(0.3);

      createMemory(makeMemory({ id: "active-1", embedding }));
      createMemory(makeMemory({ id: "superseded-1", embedding, supersededBy: "ref-1" }));

      const queryEmb = new Float32Array(384).fill(0.3);
      const results = searchByVector("agent-1", queryEmb, 10, { excludeSuperseded: true });
      expect(results.length).toBe(1);
      expect(results[0].node.id).toBe("active-1");
    });

    it("should include superseded memories when excludeSuperseded is false or not set", () => {
      seedAgent();
      const embedding = new Float32Array(384).fill(0.4);

      createMemory(makeMemory({ id: "inc-active", embedding }));
      createMemory(makeMemory({ id: "inc-superseded", embedding, supersededBy: "ref-x" }));

      const queryEmb = new Float32Array(384).fill(0.4);
      const results = searchByVector("agent-1", queryEmb, 10);
      expect(results.length).toBe(2);
    });

    it("should combine tier filter and excludeSuperseded", () => {
      seedAgent();
      const embedding = new Float32Array(384).fill(0.5);

      createMemory(makeMemory({ id: "combo-1", tier: "semantic", embedding }));
      createMemory(makeMemory({ id: "combo-2", tier: "semantic", embedding, supersededBy: "ref-z" }));
      createMemory(makeMemory({ id: "combo-3", tier: "episodic", embedding }));

      const queryEmb = new Float32Array(384).fill(0.5);
      const results = searchByVector("agent-1", queryEmb, 10, {
        tiers: ["semantic"],
        excludeSuperseded: true,
      });
      expect(results.length).toBe(1);
      expect(results[0].node.id).toBe("combo-1");
    });
  });

  describe("searchHybrid with options", () => {
    it("should pass tier filter options through to searchByVector", () => {
      seedAgent();
      const embedding = new Float32Array(384).fill(0.6);

      createMemory(makeMemory({
        id: "hyb-epi",
        tier: "episodic",
        content: "hybrid episodic content searchable",
        embedding,
      }));
      createMemory(makeMemory({
        id: "hyb-sem",
        tier: "semantic",
        content: "hybrid semantic content searchable",
        embedding,
      }));

      const queryEmb = new Float32Array(384).fill(0.6);
      const results = searchHybrid("agent-1", queryEmb, "hybrid content", 10, undefined, {
        tiers: ["semantic"],
      });
      // Hybrid post-filters by tier on BOTH vector and BM25 arrivals, so only
      // semantic memories should appear regardless of which pass matched them.
      const ids = new Set(results.map((r) => r.node.id));
      expect(ids.has("hyb-sem")).toBe(true);
      expect(ids.has("hyb-epi")).toBe(false);
    });
  });

  describe("markSuperseded", () => {
    it("should return 0 for empty array", () => {
      const updated = markSuperseded([], "reflection-empty");
      expect(updated).toBe(0);
    });
  });

  describe("createMemory with all tiers", () => {
    it("should store and retrieve each tier correctly", () => {
      seedAgent();
      const tiers = ["working", "episodic", "semantic"] as const;

      for (const tier of tiers) {
        const id = `tier-${tier}`;
        createMemory(makeMemory({ id, tier }));
        const retrieved = getMemory(id);
        expect(retrieved).toBeDefined();
        expect(retrieved!.tier).toBe(tier);
      }
    });

    it("should default to episodic tier", () => {
      seedAgent();
      createMemory(makeMemory({ id: "default-tier" }));
      const retrieved = getMemory("default-tier");
      expect(retrieved).toBeDefined();
      expect(retrieved!.tier).toBe("episodic");
    });
  });
});
import { createRole } from "../../store/roles.js";
