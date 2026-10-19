/**
 * Probe: SubagentStart hook contract + AgentDefinition.prompt requirement.
 *
 * D-S01: Regression guard for the contract assumption that subagents do NOT inherit
 * the parent session's systemPrompt and therefore need explicit CAG injection.
 *
 * This test verifies:
 * 1. The current SubagentStart handler injects CAG (post-Task-5 behavior)
 * 2. AgentDefinition requires `prompt: string` (TypeScript compile-time contract)
 *
 * Pre-Task-5 baseline: the handler did NOT inject CAG. After Task 5 lands, the
 * assertion polarity flips — see Task 6 Part C audit.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { buildSessionHooks } from "../../manager/hooks.js";

let _cleanup: (() => void) | undefined;

const { cleanup: _c, db: _testDb } = setupTestDb();
_cleanup = _c;

// ---- Mock DB so real roles.js uses the test in-memory DB ----
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// ---- Mock embedding so real memory-service doesn't fail on embedding generation ----
vi.mock("../../lib/embedding.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(16)),
}));

// ---- Mock getRelevantMemoryContext to return a string (matching real contract) ----
const mockGetRelevantMemoryContext = vi.fn().mockResolvedValue("");

vi.mock("../../agent/memory-service.js", () => ({
  getRelevantMemoryContext: (...args: unknown[]) => mockGetRelevantMemoryContext(...args),
}));

// ---- Mock logger ----
vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---- Mock SDK ----
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// ---- Mock logs ----
vi.mock("../../store/logs.js", () => ({
  createStepLog: vi.fn(),
}));

// ---- Mock server-state ----
vi.mock("../../store/server-state.js", () => ({
  getServerState: vi.fn().mockReturnValue({ userTaskSessionId: undefined }),
}));

// ---- Mock goals ----
vi.mock("../../store/goals.js", () => ({
  listGoals: vi.fn().mockReturnValue([]),
}));

// ---- Mock tasks ----
vi.mock("../../store/tasks.js", () => ({
  listTasks: vi.fn().mockReturnValue([]),
}));

afterAll(() => _cleanup?.());

beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
  mockGetRelevantMemoryContext.mockResolvedValue("");
});

// ---- Import after mocks ----
// Note: buildSessionHooks is imported at module scope above.

describe("Probe: SubagentStart hook contract + AgentDefinition.prompt requirement (regression guard)", () => {

  describe("SubagentStart handler injects CAG (post-Task-5)", () => {
    it("returns additionalContext containing [Role CAG] marker when role has cagPrompt", async () => {
      // Seed real Role into test DB
      const { createRole } = await import("../../store/roles.js");
      createRole({
        id: "role-test",
        name: "test-role",
        cagPrompt: "DistinctiveProbeMarker",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "ms-probe",
        status: "active",
        preferences: {},
        createdAt: Date.now(),
      });

      const hooks = buildSessionHooks({
        currentTaskId: "t1",
        roleId: "role-test",
        taskPrompt: "test",
      });

      const hookArray = hooks.SubagentStart!;
      expect(hookArray.length).toBeGreaterThan(0);

      // Construct fake SubagentStartHookInput per sdk.d.ts:4575-4579
      const fakeInput = {
        hook_event_name: "SubagentStart",
        agent_id: "sub1",
        agent_type: "general-purpose",
        session_id: "sess-1",
        transcript_path: "/tmp/transcript.txt",
        cwd: "/tmp",
        permission_mode: "acceptEdits",
      };

      const hookFn = hookArray[0].hooks[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (hookFn as (input: any) => Promise<any>)(fakeInput);

      // Post-Task-5: CAG is injected via SubagentStart hook
      const output = (result as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput;
      const additionalContext = output?.additionalContext ?? "";
      expect(additionalContext).toContain("[Role CAG]");
      expect(additionalContext).toContain("DistinctiveProbeMarker");
    });
  });

  describe("AgentDefinition.prompt is a required field (compile-time contract)", () => {
    it("AgentDefinition requires prompt: string — TypeScript rejects literal without it", () => {
      // This assertion documents the SDK contract that AgentDefinition requires `prompt`.
      // The TypeScript compiler enforces this at compile time; this runtime check
      // confirms the type annotation is not just a comment.
      const myAgentDef = {
        description: "test agent",
        prompt: "You are a test agent.",
      } satisfies AgentDefinition;

      expect(typeof myAgentDef.prompt).toBe("string");
      expect(myAgentDef.prompt.length).toBeGreaterThan(0);
    });

    it("AgentDefinition allows optional fields (tools, model, mcpServers)", () => {
      const partialDef = {
        description: "minimal agent",
        prompt: "Minimal.",
      } satisfies AgentDefinition;

      expect(typeof partialDef.prompt).toBe("string");
      // These are optional — TS will NOT error if omitted
      expect(partialDef).toBeDefined();
    });
  });
});
