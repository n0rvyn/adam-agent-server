import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock embedding - not available in test
vi.mock("../../lib/embedding.js", () => ({
  generateEmbedding: vi.fn().mockRejectedValue(new Error("model not available")),
  isModelAvailable: vi.fn().mockReturnValue(false),
}));

// Mock reflection — no longer imports onMemoryCreated (shim removed in Phase 5)

import { extractKeyFacts, processTaskCompletion } from "../../agent/memory-extractor.js";
import { listMemoriesByRole } from "../../store/memories.js";
import type { MemoryNode, Role } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedAgent(id = "agent-1"): void {
  const agent: Role = {
    id,
    name: "Test Agent",
    cagPrompt: "",
    preferences: {},
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `stream-${id}`,
    status: "active",
    createdAt: Date.now(),
  };
  createRole(agent);
}

function insertStepLog(
  taskId: string,
  index: number,
  type: string,
  content: string,
  toolName?: string,
  toolInput?: Record<string, unknown>,
  toolOutput?: string,
): void {
  const db = getTestDb();
  const id = `log-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO step_logs (id, task_id, "index", type, content, tool_name, tool_input, tool_output, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    taskId,
    index,
    type,
    content,
    toolName ?? null,
    toolInput ? JSON.stringify(toolInput) : null,
    toolOutput ?? null,
    Date.now(),
  );
}

function insertTask(id: string): void {
  const db = getTestDb();
  db.prepare(`
    INSERT INTO tasks (id, status, prompt, config, created_at)
    VALUES (?, 'completed', 'test prompt', '{}', ?)
  `).run(id, Date.now());
}

describe("agent/memory-extractor", () => {
  describe("extractKeyFacts", () => {
    it("should extract facts from tool_result logs with Write tool", () => {
      insertTask("task-1");
      insertStepLog("task-1", 0, "tool_result", "wrote file content", "Write", {}, "wrote file content");

      const result = extractKeyFacts("task-1");
      expect(result.facts.length).toBeGreaterThan(0);
      expect(result.facts[0].content).toContain("Modified file via Write");
      expect(result.facts[0].importance).toBe(4);
      expect(result.facts[0].type).toBe("event");
    });

    it("should extract facts from error logs", () => {
      insertTask("task-err");
      insertStepLog("task-err", 0, "error", "Something went wrong badly");

      const result = extractKeyFacts("task-err");
      expect(result.facts.length).toBe(1);
      expect(result.facts[0].content).toContain("Error occurred");
      expect(result.facts[0].importance).toBe(4);
    });

    it("should extract facts from failed Bash commands", () => {
      insertTask("task-bash-fail");
      insertStepLog(
        "task-bash-fail",
        0,
        "tool_result",
        "error: compilation failed",
        "Bash",
        { command: "npm run build" },
        "error: compilation failed",
      );

      const result = extractKeyFacts("task-bash-fail");
      expect(result.facts.length).toBe(1);
      expect(result.facts[0].content).toContain("Command failed");
    });

    it("should NOT extract Read tool (post-GAP-08: only events extracted)", () => {
      insertTask("task-read");
      insertStepLog("task-read", 0, "tool_result", "file contents", "Read", { file_path: "/src/index.ts" }, "file contents");

      const result = extractKeyFacts("task-read");
      expect(result.facts).toEqual([]);
    });

    it("should return empty facts when no relevant logs exist", () => {
      insertTask("task-empty");
      insertStepLog("task-empty", 0, "reasoning", "thinking about something");

      const result = extractKeyFacts("task-empty");
      expect(result.facts).toEqual([]);
    });
  });

  describe("processTaskCompletion", () => {
    it("should store memories from task step logs", async () => {
      seedAgent();
      insertTask("task-process");
      insertStepLog("task-process", 0, "tool_result", "wrote something", "Edit", {}, "wrote something");
      insertStepLog("task-process", 1, "tool_result", "success done", "Bash", { command: "test" }, "success done");

      const stored = await processTaskCompletion("task-process", "agent-1");
      expect(stored).toBe(2);

      const memories = listMemoriesByRole("agent-1");
      expect(memories.length).toBe(2);
    });

    it("should return 0 when no facts are extracted", async () => {
      seedAgent();
      insertTask("task-no-facts");
      insertStepLog("task-no-facts", 0, "reasoning", "just thinking");

      const stored = await processTaskCompletion("task-no-facts", "agent-1");
      expect(stored).toBe(0);
    });

    it("should set sourceTaskId on created memories", async () => {
      seedAgent();
      insertTask("task-src");
      insertStepLog("task-src", 0, "tool_result", "wrote file", "Write", {}, "wrote file");

      await processTaskCompletion("task-src", "agent-1");
      const memories = listMemoriesByRole("agent-1");
      expect(memories[0].sourceTaskId).toBe("task-src");
    });
  });
});
import { createRole } from "../../store/roles.js";
