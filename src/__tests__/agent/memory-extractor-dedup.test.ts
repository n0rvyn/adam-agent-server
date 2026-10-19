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

// No reflection module imports needed (onMemoryCreated shim removed in Phase 5)

import { processTaskCompletion } from "../../agent/memory-extractor.js";
import { createMemory, listMemoriesByRole } from "../../store/memories.js";
import { createRole } from "../../store/roles.js";
import type { MemoryNode, Role } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedRole(id = "agent-1"): void {
  const role: Role = {
    id,
    name: `Test Agent ${id}`,
    cagPrompt: "",
    preferences: {},
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `stream-${id}`,
    status: "active",
    createdAt: Date.now(),
  };
  createRole(role);
}

function insertTask(id: string, roleId?: string): void {
  const db = getTestDb();
  db.prepare(`
    INSERT INTO tasks (id, status, prompt, config, role_id, created_at)
    VALUES (?, 'completed', 'test prompt', '{}', ?, ?)
  `).run(id, roleId ?? null, Date.now());
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

describe("agent/memory-extractor: complementary writers (GAP-08)", () => {
  it("processTaskCompletion produces only event-type memories (no thoughts)", async () => {
    seedRole("agent-no-thoughts");
    insertTask("task-only-events", "agent-no-thoughts");

    insertStepLog("task-only-events", 0, "tool_result", "file contents", "Read", { file_path: "/src/main.ts" }, "file contents");
    insertStepLog("task-only-events", 1, "tool_result", "search results", "Grep", { pattern: "test" }, "search results");
    insertStepLog("task-only-events", 2, "tool_result", "wrote content", "Write", {}, "wrote content");
    insertStepLog("task-only-events", 3, "tool_result", "success done", "Bash", { command: "echo test" }, "success done");

    const stored = await processTaskCompletion("task-only-events", "agent-no-thoughts");
    const memories = listMemoriesByRole("agent-no-thoughts");

    // Read and Grep are no longer extracted (post-GAP-08); Write and Bash remain as events
    expect(memories.length).toBe(2);
    expect(stored).toBe(2);
    for (const m of memories) {
      expect(m.type).toBe("event");
    }
  });

  it("processTaskCompletion does not skip events even when a thought already exists", async () => {
    seedRole("agent-with-thought");
    insertTask("task-coexist", "agent-with-thought");

    const thoughtMemory: MemoryNode = {
      id: "preexisting-thought",
      roleId: "agent-with-thought",
      type: "thought",
      content: "task-coexist reasoning transcript",
      keywords: ["task-coexist"],
      importance: 3,
      sourceType: "task_complete",
      sourceTaskId: "task-coexist",
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      retrievedCount: 0,
      tier: "episodic",
    };
    createMemory(thoughtMemory);

    insertStepLog("task-coexist", 0, "tool_result", "success done", "Bash", { command: "echo ok" }, "success done");
    insertStepLog("task-coexist", 1, "tool_result", "wrote content", "Write", {}, "wrote content");

    const stored = await processTaskCompletion("task-coexist", "agent-with-thought");
    expect(stored).toBe(2);

    const memories = listMemoriesByRole("agent-with-thought");
    expect(memories.length).toBe(3); // 1 preexisting thought + 2 new events
    const newEvents = memories.filter((m) => m.id !== "preexisting-thought");
    expect(newEvents.length).toBe(2);
    for (const m of newEvents) {
      expect(m.type).toBe("event");
    }
  });

  it("DB constraint: rejects a second thought memory for the same source_task_id", () => {
    seedRole("agent-constraint");
    insertTask("task-unique", "agent-constraint");

    const first: MemoryNode = {
      id: "thought-1",
      roleId: "agent-constraint",
      type: "thought",
      content: "first thought",
      keywords: [],
      importance: 3,
      sourceType: "task_complete",
      sourceTaskId: "task-unique",
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      retrievedCount: 0,
      tier: "episodic",
    };
    createMemory(first);

    const second: MemoryNode = { ...first, id: "thought-2", content: "second thought" };
    expect(() => createMemory(second)).toThrow(/UNIQUE constraint failed/);
  });

  it("DB constraint: allows multiple event memories for the same source_task_id", () => {
    seedRole("agent-events");
    insertTask("task-many-events", "agent-events");

    const eventTemplate: MemoryNode = {
      id: "",
      roleId: "agent-events",
      type: "event",
      content: "event content",
      keywords: [],
      importance: 3,
      sourceType: "task_complete",
      sourceTaskId: "task-many-events",
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      retrievedCount: 0,
      tier: "episodic",
    };
    createMemory({ ...eventTemplate, id: "evt-1" });
    createMemory({ ...eventTemplate, id: "evt-2" });
    createMemory({ ...eventTemplate, id: "evt-3" });

    const memories = listMemoriesByRole("agent-events");
    expect(memories.length).toBe(3);
  });
});
