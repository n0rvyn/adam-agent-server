/**
 * Unit tests for SubagentStart hook CAG injection (Task 6 Part A).
 *
 * Tests that after Task 5, the SubagentStart hook:
 * - Injects CAG into additionalContext when role has cagPrompt
 * - Places CAG before memory in additionalContext
 * - Skips CAG block when role.cagPrompt is empty
 * - Returns {} when role does not exist (no CAG, no memory)
 * - Falls through to memory-only when role has no CAG but memory exists
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

let _cleanup: (() => void) | undefined;
let _testDb: ReturnType<typeof setupTestDb>["db"];

const { cleanup: _c, db: _tdb } = setupTestDb();
_cleanup = _c;
_testDb = _tdb;

// ---- Mock DB so real roles.js uses the test in-memory DB ----
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// ---- Mock embedding so real memory-service doesn't fail on embedding generation ----
vi.mock("../../lib/embedding.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(16)),
}));

// ---- Mock SDK ----
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
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

// ---- Mock belief-injection helpers (hooks.ts calls selectInjectionBeliefs now) ----
const mockSelectInjectionBeliefs = vi.fn().mockResolvedValue([]);
const mockFormatInjectionContext = vi.fn().mockReturnValue(
  "[Memory Context — retrieved from prior interactions]\n- [belief] Use type-safe patterns\n\n[User Request]\n",
);
const mockGetRelevantMemoryContext = vi.fn().mockResolvedValue(
  "[Memory Context — retrieved from prior interactions]\n- [belief] Use type-safe patterns\n\n[User Request]\n",
);
const mockAppendUsedMemoryIds = vi.fn();

vi.mock("../../agent/belief-injection.js", () => ({
  selectInjectionBeliefs: (...args: unknown[]) => mockSelectInjectionBeliefs(...args),
  formatInjectionContext: (...args: unknown[]) => mockFormatInjectionContext(...args),
}));

vi.mock("../../agent/memory-service.js", () => ({
  getRelevantMemoryContext: (...args: unknown[]) => mockGetRelevantMemoryContext(...args),
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

// ---- Mock tasks (Phase 2 added appendUsedMemoryIds + getContextMeta) ----
vi.mock("../../store/tasks.js", () => ({
  listTasks: vi.fn().mockReturnValue([]),
  appendUsedMemoryIds: (...args: unknown[]) => mockAppendUsedMemoryIds(...args),
  getContextMeta: vi.fn().mockReturnValue(null),
}));

// NOTE: roles.js is NOT fully mocked here — we need the real createRole/getRole to
// exist in the test DB. We use vi.mock in the test body to control getRole behavior.

afterAll(() => _cleanup?.());

beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
  // Reset belief-injection mocks to return a non-empty context each time
  mockSelectInjectionBeliefs.mockResolvedValue([]);
  mockFormatInjectionContext.mockReturnValue(
    "[Memory Context — retrieved from prior interactions]\n- [belief] Use type-safe patterns\n\n[User Request]\n",
  );
});

// ---- Import after mocks ----
import { buildSessionHooks } from "../../manager/hooks.js";
import { createRole, getRole } from "../../store/roles.js";

/** Minimal SubagentStart hook input */
function makeSubagentInput(roleId?: string) {
  return {
    hook_event_name: "SubagentStart",
    agent_id: roleId ?? "unknown-agent",
    agent_type: "general-purpose",
    session_id: "sess-test",
    transcript_path: "/tmp/transcript.txt",
    cwd: "/tmp",
    permission_mode: "acceptEdits",
  } as Parameters<NonNullable<ReturnType<typeof buildSessionHooks>["SubagentStart"]>[0]["hooks"][0]>[0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HookFn = (input: any) => Promise<any>;

describe("hooks-cag: SubagentStart CAG injection", () => {

  it("injects CAG into SubagentStart additionalContext when role has cagPrompt", async () => {
    // Seed real Role into test DB
    createRole({
      id: "r1",
      name: "test-role-1",
      cagPrompt: "DistinctiveCAGMarker",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "ms-r1",
      status: "active",
      preferences: {},
      createdAt: Date.now(),
    });

    const hooks = buildSessionHooks({
      currentTaskId: "t1",
      roleId: "r1",
      taskPrompt: "do thing",
    });

    const hookFn = hooks["SubagentStart"]![0].hooks[0] as HookFn;
    const result = await hookFn(makeSubagentInput("r1"));

    const output = result as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(output.hookSpecificOutput).toBeDefined();
    expect(output.hookSpecificOutput.additionalContext).toContain("DistinctiveCAGMarker");
    expect(output.hookSpecificOutput.additionalContext).toContain("[Role CAG]");
  });

  it("places CAG before memory in additionalContext", async () => {
    createRole({
      id: "r2",
      name: "test-role-2",
      cagPrompt: "CAGPositionTestMarker",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "ms-r2",
      status: "active",
      preferences: {},
      createdAt: Date.now(),
    });

    mockFormatInjectionContext.mockReturnValueOnce(
      "[Memory Context — retrieved from prior interactions]\n- [belief] MemorySectionHere\n\n[User Request]\n",
    );

    const hooks = buildSessionHooks({
      currentTaskId: "t2",
      roleId: "r2",
      taskPrompt: "do thing",
    });

    const hookFn = hooks["SubagentStart"]![0].hooks[0] as HookFn;
    const result = await hookFn(makeSubagentInput("r2"));

    const output = result as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    const ctx = output.hookSpecificOutput.additionalContext;

    const cagIdx = ctx.indexOf("CAGPositionTestMarker");
    const memIdx = ctx.indexOf("MemorySectionHere");
    expect(cagIdx).toBeGreaterThan(-1);
    expect(memIdx).toBeGreaterThan(-1);
    expect(cagIdx).toBeLessThan(memIdx);
  });

  it("skips CAG block when role.cagPrompt is empty", async () => {
    createRole({
      id: "r3",
      name: "test-role-3",
      cagPrompt: "",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "ms-r3",
      status: "active",
      preferences: {},
      createdAt: Date.now(),
    });

    const hooks = buildSessionHooks({
      currentTaskId: "t3",
      roleId: "r3",
      taskPrompt: "do thing",
    });

    const hookFn = hooks["SubagentStart"]![0].hooks[0] as HookFn;
    const result = await hookFn(makeSubagentInput("r3"));

    const output = result as { hookSpecificOutput: { hookEventName: string; additionalContext: string } | undefined };
    // Since there's no CAG and memory returns a string, additionalContext should be present
    // but NOT contain [Role CAG]
    if (output?.hookSpecificOutput) {
      expect(output.hookSpecificOutput.additionalContext).not.toContain("[Role CAG]");
      expect(output.hookSpecificOutput.additionalContext).toContain("Memory Context");
    }
  });

  it("returns {} when role does not exist and memory returns empty", async () => {
    // Role r4 does not exist in DB
    mockFormatInjectionContext.mockReturnValueOnce("");

    const hooks = buildSessionHooks({
      currentTaskId: "t4",
      roleId: "r4",
      taskPrompt: "do thing",
    });

    const hookFn = hooks["SubagentStart"]![0].hooks[0] as HookFn;
    const result = await hookFn(makeSubagentInput("r4"));

    // Both CAG (no role) and memory (empty string) fail, so {} is returned
    expect(result).toEqual({});
  });

  it("falls through to memory-only when role has no CAG but memory exists", async () => {
    createRole({
      id: "r5",
      name: "test-role-5",
      cagPrompt: "",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "ms-r5",
      status: "active",
      preferences: {},
      createdAt: Date.now(),
    });

    mockFormatInjectionContext.mockReturnValueOnce(
      "[Memory Context — retrieved from prior interactions]\n- [belief] MemoryOnlyContent\n\n[User Request]\n",
    );

    const hooks = buildSessionHooks({
      currentTaskId: "t5",
      roleId: "r5",
      taskPrompt: "do thing",
    });

    const hookFn = hooks["SubagentStart"]![0].hooks[0] as HookFn;
    const result = await hookFn(makeSubagentInput("r5"));

    const output = result as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(output.hookSpecificOutput).toBeDefined();
    expect(output.hookSpecificOutput.additionalContext).toContain("MemoryOnlyContent");
    expect(output.hookSpecificOutput.additionalContext).not.toContain("[Role CAG]");
  });
});
