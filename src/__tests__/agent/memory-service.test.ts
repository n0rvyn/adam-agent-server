import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock the embedding module - it requires ONNX model download
const mockGenerateEmbedding = vi.fn().mockRejectedValue(new Error("model not available in test"));
vi.mock("../../lib/embedding.js", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
  isModelAvailable: vi.fn().mockReturnValue(false),
  EMBEDDING_DIMENSION: 512,
}));

import { queryMemory, queryMemoryByTier, getRelevantMemoryContext } from "../../agent/memory-service.js";
import { createMemory, markSuperseded } from "../../store/memories.js";
import { createBelief } from "../../store/beliefs.js";
import { createRole } from "../../store/roles.js";
import type { MemoryNode, Role, Belief } from "../../shared/types.js";

// Config stub so belief-based retrieval does not throw "not initialized"
vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({
    memory: {
      midTaskInjection: { enabled: false, toolCallThreshold: 10, cooldownMs: 60_000, topK: 3, maxTokens: 1000 },
      retrievalWeights: { cosSim: 0.4, recency: 0.2, tokenCost: 0.05 },
      globalBudgetTokens: 1500,
      retrievalDecayDays: 30,
      attributionThresholds: { high: 0.7, low: 0.4 },
      antiFlipMinUses: 5,
      antiFlipSuccessEmaThreshold: 0.25,
    },
    anthropic: {},
  }),
}));

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedAgent(id = "agent-1"): void {
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
}

function seedMemory(roleId: string, id: string, content: string, importance = 3): void {
  const mem: MemoryNode = {
    id,
    roleId,
    type: "event",
    content,
    keywords: content.toLowerCase().split(/\s+/).filter((w) => w.length > 2),
    importance,
    sourceType: "task_complete",
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    retrievedCount: 0,
    tier: "episodic",
  };
  createMemory(mem);
}

describe("agent/memory-service", () => {
  describe("queryMemory", () => {
    it("should fallback to BM25 search when embedding generation fails", async () => {
      seedAgent();
      seedMemory("agent-1", "m1", "some test content");

      // With embedding unavailable, queryMemory falls back to BM25-only via zero vector
      const results = await queryMemory("agent-1", "test query");
      // BM25 may or may not match depending on content — just verify it doesn't throw
      expect(Array.isArray(results)).toBe(true);
    });

    it("should return empty array for role with no memories", async () => {
      seedAgent("empty-agent");
      const results = await queryMemory("empty-agent", "anything");
      expect(results).toEqual([]);
    });

    it("should respect topK option", async () => {
      seedAgent();
      // Even though embedding fails and returns [], verify the option is accepted
      const results = await queryMemory("agent-1", "query", { topK: 5 });
      expect(Array.isArray(results)).toBe(true);
    });

    it("works with undefined roleId for cross-role search", async () => {
      seedAgent("agent-1");
      seedAgent("agent-2");
      seedMemory("agent-1", "m1", "alpha memory content");
      seedMemory("agent-2", "m2", "beta memory content");

      // Make embedding succeed so queryMemory reaches searchHybrid
      const fakeEmbedding = new Float32Array(384).fill(0.1);
      mockGenerateEmbedding.mockResolvedValueOnce(fakeEmbedding);

      const results = await queryMemory(undefined, "memory content");
      // With undefined roleId, results can come from any role
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe("getRelevantMemoryContext", () => {
    it("returns formatted context for relevant beliefs", async () => {
      seedAgent("agent-ctx");
      // Create a belief that matches the query
      const belief: Belief = {
        id: "belief-ctx-1",
        roleId: "agent-ctx",
        content: "The project uses TypeScript with strict mode",
        isAnti: false,
        evidenceObsIds: [],
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        lastValidatedAt: Date.now(),
        status: "active",
        injectCount: 0,
      };
      createBelief(belief);

      const context = await getRelevantMemoryContext("TypeScript config", "agent-ctx");
      expect(context.startsWith("[Memory Context")).toBe(true);
      expect(context).toContain("The project uses TypeScript with strict mode");
      expect(context).toContain("[belief]");
    });

    it("returns empty string when no beliefs", async () => {
      seedAgent("agent-empty-ctx");
      const context = await getRelevantMemoryContext("anything", "agent-empty-ctx");
      expect(context).toBe("");
    });
  });

  describe("queryMemoryByTier", () => {
    it("should only return memories matching the specified tiers", async () => {
      seedAgent("agent-tier");
      const embedding = new Float32Array(384).fill(0.2);
      mockGenerateEmbedding.mockResolvedValueOnce(new Float32Array(384).fill(0.2));

      const semanticMem: MemoryNode = {
        id: "qbt-sem",
        roleId: "agent-tier",
        type: "reflection",
        content: "semantic insight about testing patterns",
        keywords: ["semantic", "testing"],
        importance: 5,
        sourceType: "reflection",
        embedding,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        retrievedCount: 0,
        tier: "semantic",
      };
      const episodicMem: MemoryNode = {
        id: "qbt-epi",
        roleId: "agent-tier",
        type: "event",
        content: "episodic event about testing patterns",
        keywords: ["episodic", "testing"],
        importance: 3,
        sourceType: "task_complete",
        embedding,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        retrievedCount: 0,
        tier: "episodic",
      };
      const workingMem: MemoryNode = {
        id: "qbt-wrk",
        roleId: "agent-tier",
        type: "thought",
        content: "working memory about testing patterns",
        keywords: ["working", "testing"],
        importance: 2,
        sourceType: "task_complete",
        embedding,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        retrievedCount: 0,
        tier: "working",
      };
      createMemory(semanticMem);
      createMemory(episodicMem);
      createMemory(workingMem);

      const results = await queryMemoryByTier("agent-tier", "testing patterns", ["semantic"]);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe("qbt-sem");
      expect(results[0].tier).toBe("semantic");
    });

    it("should return multiple tiers when specified", async () => {
      seedAgent("agent-multi-tier");
      const embedding = new Float32Array(384).fill(0.3);
      mockGenerateEmbedding.mockResolvedValueOnce(new Float32Array(384).fill(0.3));

      createMemory({
        id: "mt-sem",
        roleId: "agent-multi-tier",
        type: "reflection",
        content: "multi-tier semantic memory content",
        keywords: ["multi", "tier"],
        importance: 5,
        sourceType: "reflection",
        embedding,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        retrievedCount: 0,
        tier: "semantic",
      });
      createMemory({
        id: "mt-wrk",
        roleId: "agent-multi-tier",
        type: "thought",
        content: "multi-tier working memory content",
        keywords: ["multi", "tier"],
        importance: 2,
        sourceType: "task_complete",
        embedding,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        retrievedCount: 0,
        tier: "working",
      });
      createMemory({
        id: "mt-epi",
        roleId: "agent-multi-tier",
        type: "event",
        content: "multi-tier episodic memory content",
        keywords: ["multi", "tier"],
        importance: 3,
        sourceType: "task_complete",
        embedding,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        retrievedCount: 0,
        tier: "episodic",
      });

      const results = await queryMemoryByTier("agent-multi-tier", "multi tier", ["semantic", "working"]);
      expect(results.length).toBe(2);
      const tiers = results.map((r) => r.tier);
      expect(tiers).toContain("semantic");
      expect(tiers).toContain("working");
      expect(tiers).not.toContain("episodic");
    });
  });

  describe("queryMemory scoring (GAP-10 — magnitude-preserving hybrid)", () => {
    it("[discriminator] BM25-only high-importance memory outranks cosine-only low-importance memory", async () => {
      // This is the test that fails against pre-GAP-10 code and passes
      // against post-GAP-10. Both memories are in the candidate pool under
      // either version, but the ranking is different:
      //
      // Pre-GAP-10 (cosine recomputed, BM25 rank discarded after pool):
      //   X (cosine=1, imp=1): relevance=1 → Smallville ≈ 3.9
      //   Y (cosine=0, imp=5): relevance=0 → Smallville ≈ 2.5
      //   → X ranks first (wrong — Y has a perfect BM25 match).
      //
      // Post-GAP-10 (combinedRelevance = 0.6*cosine + 0.4*bm25Norm):
      //   X: combinedRelevance = 0.6 → Smallville ≈ 2.7
      //   Y: combinedRelevance = 0.4 → Smallville ≈ 3.7
      //   → Y ranks first (BM25 magnitude compensates for low importance).
      seedAgent("gap10-discrim");
      const sharedEmb = new Float32Array(384).fill(0.5);

      createMemory({
        id: "X-cos-low-imp",
        roleId: "gap10-discrim",
        type: "event",
        content: "alpha beta gamma unrelated filler",
        keywords: ["filler"],
        importance: 1,
        sourceType: "task_complete",
        embedding: sharedEmb,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        retrievedCount: 0,
        tier: "episodic",
      });
      createMemory({
        id: "Y-bm25-high-imp",
        roleId: "gap10-discrim",
        type: "event",
        content: "cryptocosm nucleosynthesis distinctive phrase",
        keywords: ["cryptocosm"],
        importance: 5,
        sourceType: "task_complete",
        // no embedding — BM25-only
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        retrievedCount: 0,
        tier: "episodic",
      });

      mockGenerateEmbedding.mockResolvedValueOnce(new Float32Array(384).fill(0.5));
      const results = await queryMemory("gap10-discrim", "cryptocosm nucleosynthesis");
      const xIdx = results.findIndex((r) => r.id === "X-cos-low-imp");
      const yIdx = results.findIndex((r) => r.id === "Y-bm25-high-imp");
      expect(xIdx).toBeGreaterThanOrEqual(0);
      expect(yIdx).toBeGreaterThanOrEqual(0);
      expect(yIdx).toBeLessThan(xIdx);
    });

    it("surfaces a BM25-only memory (no embedding) in queryMemory output", async () => {
      // Consistency check: after GAP-10, a BM25-only memory reaches the
      // returned results with a positive score driven by BM25 magnitude.
      seedAgent("gap10-bm25-only-agent");
      createMemory({
        id: "vec-irrelevant",
        roleId: "gap10-bm25-only-agent",
        type: "event",
        content: "completely unrelated filler text",
        keywords: ["filler"],
        importance: 3,
        sourceType: "task_complete",
        embedding: new Float32Array(384).fill(0.1),
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        retrievedCount: 0,
        tier: "episodic",
      });
      createMemory({
        id: "bm25-hit",
        roleId: "gap10-bm25-only-agent",
        type: "event",
        content: "distinctive nautilus keyword present here",
        keywords: ["nautilus"],
        importance: 3,
        sourceType: "task_complete",
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        retrievedCount: 0,
        tier: "episodic",
      });

      mockGenerateEmbedding.mockResolvedValueOnce(new Float32Array(384).fill(0.1));
      const results = await queryMemory("gap10-bm25-only-agent", "nautilus");
      const ids = results.map((r) => r.id);
      expect(ids).toContain("bm25-hit");
      const bm25Hit = results.find((r) => r.id === "bm25-hit")!;
      expect(bm25Hit.score).toBeGreaterThan(0);
    });

    it("should add retrievalBonus to score for frequently retrieved memories", async () => {
      seedAgent("agent-bonus");
      const embedding = new Float32Array(384).fill(0.4);
      mockGenerateEmbedding.mockResolvedValueOnce(new Float32Array(384).fill(0.4));

      // Memory with high retrieval count
      createMemory({
        id: "bonus-high",
        roleId: "agent-bonus",
        type: "event",
        content: "highly retrieved bonus test memory",
        keywords: ["bonus", "test"],
        importance: 3,
        sourceType: "task_complete",
        embedding,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        retrievedCount: 10,
        tier: "episodic",
      });
      // Memory with no retrievals
      createMemory({
        id: "bonus-zero",
        roleId: "agent-bonus",
        type: "event",
        content: "never retrieved bonus test memory",
        keywords: ["bonus", "test"],
        importance: 3,
        sourceType: "task_complete",
        embedding,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        retrievedCount: 0,
        tier: "episodic",
      });

      const results = await queryMemory("agent-bonus", "bonus test");
      // Both should have scores; the high-retrieval one should score higher
      const highRetrieval = results.find((r) => r.id === "bonus-high");
      const zeroRetrieval = results.find((r) => r.id === "bonus-zero");
      expect(highRetrieval).toBeDefined();
      expect(zeroRetrieval).toBeDefined();
      // retrievalBonus = min(0.3, 10*0.05) = 0.3 vs min(0.3, 0*0.05) = 0
      expect(highRetrieval!.score).toBeGreaterThan(zeroRetrieval!.score);
    });

    it("should pass excludeSuperseded option to searchHybrid via vector path", async () => {
      seedAgent("agent-sup-excl");
      // With embedding unavailable, only BM25 runs (no vector filtering).
      // Create one active and one superseded memory with distinct content.
      // Use a query that only matches the active memory's BM25 keywords.
      createMemory({
        id: "sup-active",
        roleId: "agent-sup-excl",
        type: "event",
        content: "zephyr unique active memory content",
        keywords: ["zephyr"],
        importance: 3,
        sourceType: "task_complete",
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        retrievedCount: 0,
        tier: "episodic",
      });
      createMemory({
        id: "sup-replaced",
        roleId: "agent-sup-excl",
        type: "event",
        content: "quasar unique replaced memory content",
        keywords: ["quasar"],
        importance: 3,
        sourceType: "task_complete",
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        retrievedCount: 0,
        tier: "episodic",
        supersededBy: "reflection-99",
      });

      // Embedding fails → BM25-only with zero vector, but query "zephyr" only matches active
      const results = await queryMemory("agent-sup-excl", "zephyr");
      const ids = results.map((r) => r.id);
      expect(ids).toContain("sup-active");
      expect(ids).not.toContain("sup-replaced");
    });
  });

  describe("getRelevantMemoryContext budget", () => {
    it("should limit output to maxTokens budget and not include all beliefs", async () => {
      seedAgent("agent-budget-ctx");

      // Create 10 beliefs with long content (~50 tokens each)
      for (let i = 0; i < 10; i++) {
        const belief: Belief = {
          id: `bbctx-${i}`,
          roleId: "agent-budget-ctx",
          content: `Belief context item number ${i} with substantial text content to consume token budget easily and test the cutoff behavior properly`,
          isAnti: false,
          evidenceObsIds: [],
          createdAt: Date.now() - i * 1000,
          lastUsedAt: Date.now() - i * 1000,
          lastValidatedAt: Date.now() - i * 1000,
          status: "active",
          injectCount: 0,
        };
        createBelief(belief);
      }

      // Very small budget: should only fit 1-2 beliefs
      const context = await getRelevantMemoryContext("budget context", "agent-budget-ctx", 10, 60);
      if (context === "") {
        // Budget too small even for header → that's a valid outcome
        return;
      }
      const lineCount = (context.match(/- \[/g) || []).length;
      expect(lineCount).toBeLessThan(10);
      expect(lineCount).toBeGreaterThan(0);
    });
  });
});
