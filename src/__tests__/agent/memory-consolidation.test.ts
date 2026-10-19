import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock embedding
vi.mock("../../lib/embedding.js", () => ({
  generateEmbedding: vi.fn().mockRejectedValue(new Error("model not available")),
  isModelAvailable: vi.fn().mockReturnValue(false),
}));

// Mock LLM eval
vi.mock("../../lib/llm-eval.js", () => ({
  callClaudeForEvaluation: vi.fn().mockResolvedValue("Heuristic reflection: Test patterns observed."),
}));

import { markSuperseded, createMemory, listMemoriesByRole, searchByBM25 } from "../../store/memories.js";
import { createRole } from "../../store/roles.js";
import type { MemoryNode, Role } from "../../shared/types.js";

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

function seedMemory(roleId: string, id: string, content: string): void {
  const mem: MemoryNode = {
    id,
    roleId,
    type: "event",
    content,
    keywords: ["test"],
    importance: 3,
    sourceType: "task_complete",
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    retrievedCount: 0,
    tier: "episodic",
  };
  createMemory(mem);
}

describe("agent/memory-consolidation", () => {
  describe("markSuperseded", () => {
    it("should set superseded_by on multiple memories", () => {
      seedRole("agent-supersede");
      seedMemory("agent-supersede", "mem-1", "First memory");
      seedMemory("agent-supersede", "mem-2", "Second memory");
      seedMemory("agent-supersede", "mem-3", "Third memory");

      const updated = markSuperseded(["mem-1", "mem-2"], "reflection-1");
      expect(updated).toBe(2);

      const mem1 = searchByBM25("agent-supersede", "First memory", 1)[0];
      const mem2 = searchByBM25("agent-supersede", "Second memory", 1)[0];
      const mem3 = searchByBM25("agent-supersede", "Third memory", 1)[0];
      expect(mem1.node.supersededBy).toBe("reflection-1");
      expect(mem2.node.supersededBy).toBe("reflection-1");
      expect(mem3.node.supersededBy).toBeUndefined();
    });

    it("should return 0 for non-existent memory IDs", () => {
      seedRole("agent-nonexistent");
      const updated = markSuperseded(["non-existent"], "reflection-1");
      expect(updated).toBe(0);
    });
  });

});

