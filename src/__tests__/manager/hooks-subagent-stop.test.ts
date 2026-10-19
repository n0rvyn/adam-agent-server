import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));
vi.mock("../../lib/embedding.js", () => ({
  generateEmbedding: vi.fn().mockRejectedValue(new Error("model not available")),
  isModelAvailable: vi.fn().mockReturnValue(false),
}));
import { buildSessionHooks } from "../../manager/hooks.js";
import { listMemoriesByRole, createMemory } from "../../store/memories.js";
import { createRole } from "../../store/roles.js";
import type { Role } from "../../shared/types.js";

// Match the loose hook function signature used in role-memory-hooks.test.ts
// to avoid SDK HookInput type-narrowing in the test invocation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HookFn = (input: any) => Promise<any>;

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedRole(id: string): void {
  const role: Role = {
    id,
    name: `Test ${id}`,
    cagPrompt: "",
    preferences: {},
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `stream-${id}`,
    status: "active",
    createdAt: Date.now(),
  };
  createRole(role);
}

function insertTask(id: string, roleId: string): void {
  getTestDb().prepare(
    "INSERT INTO tasks (id, status, prompt, config, role_id, created_at) VALUES (?, 'completed', 'p', '{}', ?, ?)"
  ).run(id, roleId, Date.now());
}

describe("manager/hooks SubagentStop (GAP-08)", () => {
  it("persists transcript even when an event memory exists for the task", async () => {
    seedRole("agent-1");
    insertTask("task-1", "agent-1");

    createMemory({
      id: "evt-existing",
      roleId: "agent-1",
      type: "event",
      content: "Modified file via Write: ...",
      keywords: [],
      importance: 4,
      sourceType: "task_complete",
      sourceTaskId: "task-1",
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      retrievedCount: 0,
      tier: "episodic",
    });

    const hooks = buildSessionHooks({ roleId: "agent-1", currentTaskId: "task-1" });
    const subagentStop = hooks.SubagentStop?.[0]?.hooks?.[0] as HookFn | undefined;
    expect(subagentStop).toBeDefined();

    const transcript = "x".repeat(500);
    await subagentStop!({ agent_id: "agent-1", transcript });

    const memories = listMemoriesByRole("agent-1");
    const thoughts = memories.filter((m) => m.type === "thought");
    expect(thoughts.length).toBe(1);
    expect(thoughts[0].sourceTaskId).toBe("task-1");
    expect(thoughts[0].content).toContain("[Task task-1 reasoning]");
  });

  it("DB constraint blocks a second SubagentStop for the same task", async () => {
    seedRole("agent-2");
    insertTask("task-2", "agent-2");

    const hooks = buildSessionHooks({ roleId: "agent-2", currentTaskId: "task-2" });
    const subagentStop = hooks.SubagentStop?.[0]?.hooks?.[0] as HookFn | undefined;

    const transcript = "y".repeat(500);
    await subagentStop!({ agent_id: "agent-2", transcript });
    // Sleep 5ms to ensure Date.now() differs between calls.
    // Without this, both invocations produce id="session-${Date.now()}" with the same
    // timestamp → PRIMARY KEY collision fires before partial UNIQUE index → test would
    // pass for the wrong reason (verifier S1 finding).
    await new Promise((r) => setTimeout(r, 5));
    // Second invocation should hit the partial unique index; hook silently catches errors per design
    await subagentStop!({ agent_id: "agent-2", transcript: "z".repeat(500) });

    const memories = listMemoriesByRole("agent-2");
    const thoughts = memories.filter((m) => m.type === "thought");
    expect(thoughts.length).toBe(1); // only the first persisted
  });
});
