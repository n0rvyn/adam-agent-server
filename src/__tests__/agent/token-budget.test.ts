import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock embedding to return a fixed vector
vi.mock("../../lib/embedding.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.5)),
  isModelAvailable: vi.fn().mockReturnValue(true),
}));

import { estimateTokens } from "../../lib/token-estimator.js";
import { getRelevantMemoryContext } from "../../agent/memory-service.js";
import { createMemory } from "../../store/memories.js";
import { createBelief } from "../../store/beliefs.js";
import { createRole } from "../../store/roles.js";
import type { Role, MemoryNode, Belief } from "../../shared/types.js";

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
      scope: { emaAlpha: 0.3, humanFeedbackWeight: 3.0, reflectionPoolMax: 100, decayBase: 0.995, archiveThreshold: 0.2 },
    },
    anthropic: {},
  }),
}));

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedRole(id = "agent-1"): void {
  const role: Role = {
    id,
    name: `Test Agent ${id}`,
    cagPrompt: "",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `stream-${id}`,
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  };
  createRole(role);
}

describe("agent/token-budget", () => {
  describe("estimateTokens", () => {
    it("should estimate ~1 token per CJK character", () => {
      // 8 CJK characters → ~8 tokens
      const cjk = "这是一个测试文本";
      expect(estimateTokens(cjk)).toBe(8);
    });

    it("should estimate ~4 chars per token for English text", () => {
      // 400 English chars → ~100 tokens
      const english = "a".repeat(400);
      expect(estimateTokens(english)).toBe(100);
    });

    it("should handle mixed CJK and English", () => {
      // 4 CJK chars + 40 English chars → 4 + ceil(40/4) = 4 + 10 = 14 tokens
      const mixed = "中文字符" + "a".repeat(40);
      expect(estimateTokens(mixed)).toBe(14);
    });

    it("should handle empty string", () => {
      expect(estimateTokens("")).toBe(0);
    });
  });

  describe("getRelevantMemoryContext", () => {
    it("should return empty string when no beliefs exist", async () => {
      seedRole("agent-empty");
      const context = await getRelevantMemoryContext("test", "agent-empty", 5);
      expect(context).toBe("");
    });

    it("should format beliefs with [belief] prefix (not tier-based labels)", async () => {
      seedRole("agent-belief-format");
      const b: Belief = {
        id: "b-format",
        roleId: "agent-belief-format",
        content: "Belief content for format test",
        isAnti: false,
        evidenceObsIds: [],
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        lastValidatedAt: Date.now(),
        status: "active",
        injectCount: 0,
      };
      createBelief(b);

      const context = await getRelevantMemoryContext("format", "agent-belief-format", 5, 2000);
      expect(context).toContain("[belief]");
      expect(context).not.toContain("[semantic]");
      expect(context).not.toContain("[episodic]");
    });
  });
});
