import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

const mockGetRuntimeConfig = vi.fn();
const mockSelectInjectionBeliefs = vi.fn();

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => mockGetRuntimeConfig(),
}));

vi.mock("../../agent/memory-service.js", () => ({
  getRelevantMemoryContext: vi.fn(),
  queryMemoryByTier: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../agent/belief-injection.js", () => ({
  selectInjectionBeliefs: (...args: unknown[]) => mockSelectInjectionBeliefs(...args),
  formatInjectionContext: (beliefs: unknown[]) =>
    beliefs.length > 0
      ? "[Memory Refresh — 过往观察]\n- [belief] memo\n\n[User Request]\n"
      : "",
}));

vi.mock("../../store/logs.js", () => ({
  createStepLog: vi.fn(),
}));

vi.mock("../../store/memories.js", () => ({
  createMemory: vi.fn(),
}));

const { buildSessionHooks } = await import("../../manager/hooks.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HookFn = (input: any) => Promise<any>;

function getHookCallbacks(currentTaskId?: string, roleId = "role-test", taskPrompt = "test goal") {
  const hooks = buildSessionHooks({ currentTaskId, roleId, taskPrompt });
  const preToolUse = hooks.PreToolUse?.[0]?.hooks?.[0];
  const subagentStop = hooks.SubagentStop?.[0]?.hooks?.[0];
  if (!preToolUse || !subagentStop) throw new Error("hook callbacks missing");
  return {
    preToolUse: preToolUse as HookFn,
    subagentStop: subagentStop as HookFn,
  };
}

function defaultMidTaskCfg(
  overrides: Partial<{
    enabled: boolean;
    toolCallThreshold: number;
    cooldownMs: number;
    topK: number;
    maxTokens: number;
  }> = {},
) {
  return {
    enabled: true,
    toolCallThreshold: 3,
    cooldownMs: 60_000,
    topK: 3,
    maxTokens: 1000,
    ...overrides,
  };
}

function wireConfig(
  midTaskInjection: ReturnType<typeof defaultMidTaskCfg> | null,
): void {
  mockGetRuntimeConfig.mockReturnValue({
    memory: midTaskInjection ? { midTaskInjection } : undefined,
  });
}

function makePreToolInput(toolName: string) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: {},
    tool_use_id: `tu-${toolName}`,
  };
}

async function callTool(preToolUse: HookFn, toolName: string) {
  return preToolUse(makePreToolInput(toolName));
}

describe("PreToolUse mid-task memory injection", () => {
  beforeEach(() => {
    mockGetRuntimeConfig.mockReset();
    mockSelectInjectionBeliefs.mockReset();
    mockSelectInjectionBeliefs.mockResolvedValue([{ id: "b1", content: "memo", roleId: "role-test", isAnti: false, evidenceObsIds: [], createdAt: 0, lastUsedAt: 0, lastValidatedAt: 0, status: "active", injectCount: 0 }]);
    wireConfig(defaultMidTaskCfg());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => cleanup());

  it("returns {} immediately when ctx.currentTaskId is undefined (ChatManager scope)", async () => {
    const { preToolUse } = getHookCallbacks(undefined);
    const result = await callTool(preToolUse, "Bash");

    expect(result).toEqual({});
    expect(mockGetRuntimeConfig).not.toHaveBeenCalled();
  });

  it("short-circuits when enabled is false (no counter mutation, no memory query)", async () => {
    wireConfig(defaultMidTaskCfg({ enabled: false }));
    const { preToolUse } = getHookCallbacks("task-disabled");

    for (let i = 0; i < 5; i += 1) {
      await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    }

    expect(mockSelectInjectionBeliefs).not.toHaveBeenCalled();
  });

  it("returns {} safely when memory section is absent from runtime config", async () => {
    wireConfig(null);
    const { preToolUse } = getHookCallbacks("task-no-memory");

    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    expect(mockSelectInjectionBeliefs).not.toHaveBeenCalled();
  });

  it("returns {} safely when getRuntimeConfig throws (runtime not initialized)", async () => {
    mockGetRuntimeConfig.mockImplementation(() => {
      throw new Error("not initialized");
    });
    const { preToolUse } = getHookCallbacks("task-no-runtime");

    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    expect(mockSelectInjectionBeliefs).not.toHaveBeenCalled();
  });

  it("does not increment counter or inject for skip-list tools (Read, Glob, Grep, LSP)", async () => {
    const { preToolUse } = getHookCallbacks("task-skip");
    const tools = ["Read", "Glob", "Grep", "LSP", "Read", "Glob", "Grep", "LSP", "Read", "Glob"];

    for (const toolName of tools) {
      await expect(callTool(preToolUse, toolName)).resolves.toEqual({});
    }

    expect(mockSelectInjectionBeliefs).not.toHaveBeenCalled();
  });

  it("does not increment counter for memory tools but resets state and suppresses within cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T00:00:00.000Z"));
    const { preToolUse } = getHookCallbacks("task-memory-tool");

    await callTool(preToolUse, "Bash");
    await callTool(preToolUse, "Bash");
    await expect(callTool(preToolUse, "search_memories")).resolves.toEqual({});

    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    expect(mockSelectInjectionBeliefs).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-04-19T00:01:00.001Z"));
    const result = await callTool(preToolUse, "Bash");
    expect(result).toHaveProperty("hookSpecificOutput");
    expect(mockSelectInjectionBeliefs).toHaveBeenCalledTimes(1);
  });

  it("fires injection on Nth non-skip-list call (counter gate)", async () => {
    wireConfig(defaultMidTaskCfg({ toolCallThreshold: 3 }));
    const { preToolUse } = getHookCallbacks("task-threshold");

    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    const result = await callTool(preToolUse, "Bash");

    expect(result).toHaveProperty("hookSpecificOutput");
    const output = (result as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput;
    expect(output.additionalContext).toContain("[Memory Refresh");
    expect(output.additionalContext).not.toContain("[User Request]");
    expect(mockSelectInjectionBeliefs).toHaveBeenCalledWith("role-test", undefined, expect.anything());
  });

  it("honors cooldown and suppresses a second injection within the cooldown window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T00:00:00.000Z"));
    wireConfig(defaultMidTaskCfg({ cooldownMs: 60_000 }));
    const { preToolUse } = getHookCallbacks("task-cooldown");

    await callTool(preToolUse, "Bash");
    await callTool(preToolUse, "Bash");
    await callTool(preToolUse, "Bash");

    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});

    expect(mockSelectInjectionBeliefs).toHaveBeenCalledTimes(1);
  });

  it("counter resets after injection so second injection requires another threshold of calls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T00:00:00.000Z"));
    wireConfig(defaultMidTaskCfg({ cooldownMs: 1 }));
    const { preToolUse } = getHookCallbacks("task-reset");

    await callTool(preToolUse, "Bash");
    await callTool(preToolUse, "Bash");
    const first = await callTool(preToolUse, "Bash");
    expect(first).toHaveProperty("hookSpecificOutput");

    vi.setSystemTime(new Date("2026-04-19T00:00:00.100Z"));
    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    const second = await callTool(preToolUse, "Bash");

    expect(second).toHaveProperty("hookSpecificOutput");
    expect(mockSelectInjectionBeliefs).toHaveBeenCalledTimes(2);
  });

  it("clears state on SubagentStop (no leak across tasks in persistent hooks)", async () => {
    const { preToolUse, subagentStop } = getHookCallbacks("task-cleanup");

    await callTool(preToolUse, "Bash");
    await callTool(preToolUse, "Bash");
    const first = await callTool(preToolUse, "Bash");
    expect(first).toHaveProperty("hookSpecificOutput");

    await expect(subagentStop({ agent_id: "role-test", transcript: "" })).resolves.toEqual({});

    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    const second = await callTool(preToolUse, "Bash");

    expect(second).toHaveProperty("hookSpecificOutput");
    expect(mockSelectInjectionBeliefs).toHaveBeenCalledTimes(2);
  });

  it("clears state on SubagentStop even when agentId is missing", async () => {
    const { preToolUse, subagentStop } = getHookCallbacks("task-cleanup-no-agent");

    await callTool(preToolUse, "Bash");
    await callTool(preToolUse, "Bash");
    const first = await callTool(preToolUse, "Bash");
    expect(first).toHaveProperty("hookSpecificOutput");

    await expect(subagentStop({ agent_id: undefined, transcript: "" })).resolves.toEqual({});

    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    const second = await callTool(preToolUse, "Bash");

    expect(second).toHaveProperty("hookSpecificOutput");
    expect(mockSelectInjectionBeliefs).toHaveBeenCalledTimes(2);
  });

  it("memory-service throw is non-fatal and the hook returns {}", async () => {
    mockSelectInjectionBeliefs.mockRejectedValueOnce(new Error("embedding down"));
    const { preToolUse } = getHookCallbacks("task-memory-fail");

    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});
    await expect(callTool(preToolUse, "Bash")).resolves.toEqual({});

    expect(mockSelectInjectionBeliefs).toHaveBeenCalledTimes(1);
  });

  it("returns {} when selectInjectionBeliefs yields no beliefs (empty context)", async () => {
    mockSelectInjectionBeliefs.mockResolvedValueOnce([]);
    const { preToolUse } = getHookCallbacks("task-empty-context");

    await callTool(preToolUse, "Bash");
    await callTool(preToolUse, "Bash");
    const result = await callTool(preToolUse, "Bash");

    expect(result).toEqual({});
    expect(mockSelectInjectionBeliefs).toHaveBeenCalledTimes(1);
  });
});
