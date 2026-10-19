import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role, Task } from "../../shared/types.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";

// --- Mocks ---

vi.mock("../../lib/task-admission.js", () => ({
  admitTask: vi.fn(),
}));

vi.mock("../../store/tasks.js", () => ({
  createTask: vi.fn(),
}));

vi.mock("../../store/manager-decisions.js", () => ({
  recordRoutingDecision: vi.fn(),
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn(),
}));

vi.mock("../../strategy/engine.js", () => ({
  StrategyEngine: {
    selectStrategy: vi.fn(),
  },
}));

const emitSpy = vi.fn();
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: (...args: unknown[]) => emitSpy(...args),
  },
}));

import { createTaskWithAdmission } from "../../lib/task-dispatch.js";
import { admitTask } from "../../lib/task-admission.js";
import { createTask } from "../../store/tasks.js";
import { recordRoutingDecision } from "../../store/manager-decisions.js";
import { getRuntimeConfig } from "../../config/runtime.js";
import { StrategyEngine } from "../../strategy/engine.js";

const mockAdmit = vi.mocked(admitTask);
const mockCreateTask = vi.mocked(createTask);
const mockRecord = vi.mocked(recordRoutingDecision);
const mockRuntimeConfig = vi.mocked(getRuntimeConfig);
const mockSelectStrategy = vi.mocked(StrategyEngine.selectStrategy);

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: "role-1",
    name: "TestRole",
    cagPrompt: "You are Test.",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "ms-1",
    status: "active",
    preferences: {},
    createdAt: Date.now(),
    allowedTools: ["Read", "Write", "Bash"],
    disallowedTools: ["Edit"],
    approvalRequired: ["Bash"],
    maxBudgetUsd: 2.0,
    model: "claude-sonnet-4-6",
    source: "user",
    ...overrides,
  } as Role;
}

const BASE_DEFAULTS = {
  timeout: 600,
  maxTurns: 400,
  maxBudgetUsd: 5.0,
  effort: "high" as const,
  model: "",
  settingSources: ["user", "project"] as Array<"user" | "project" | "local">,
  allowedTools: ["Read", "Write", "Bash", "Edit", "Grep"],
  disallowedTools: ["RemoveFile"],
  approvalRequired: ["rm -rf *"],
  approvalTimeout: 600,
  env: {},
  plugins: ["core-plugin"],
  workspacePath: "/tmp/workspace",
  workspaceRetention: "immediate" as const,
  deniedReadPaths: [] as string[],
};

beforeEach(() => {
  vi.clearAllMocks();
  emitSpy.mockReset();
  mockRuntimeConfig.mockReturnValue({ defaults: BASE_DEFAULTS } as ReturnType<typeof getRuntimeConfig>);
  mockSelectStrategy.mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// admission failure propagation
// ---------------------------------------------------------------------------

describe("createTaskWithAdmission — admission failure", () => {
  it("returns failure result without creating task or emitting event", async () => {
    mockAdmit.mockResolvedValue({
      ok: false,
      code: "ROLE_TOOL_MISMATCH",
      reason: "Missing tools: Bash",
      missing: { tools: ["Bash"] },
    });

    const result = await createTaskWithAdmission({
      prompt: "implement a fix",
      roleId: "role-1",
    });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; code: string }).code).toBe("ROLE_TOOL_MISMATCH");
    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("propagates candidates from admission failure", async () => {
    mockAdmit.mockResolvedValue({
      ok: false,
      code: "ROLE_SELECTION_AMBIGUOUS",
      reason: "no role fits",
      candidates: [
        { roleId: "r1", name: "R1", fitScore: 0.5 },
        { roleId: "r2", name: "R2", fitScore: 0.3 },
      ],
    });

    const result = await createTaskWithAdmission({
      prompt: "analyze data",
      autoSelectRole: true,
      requirements: { tools: ["Read"] },
    });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; candidates: unknown[] }).candidates).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// admission success path
// ---------------------------------------------------------------------------

describe("createTaskWithAdmission — admission success", () => {
  it("creates task with frozen executionProfile and requirements in config", async () => {
    const role = makeRole();
    mockAdmit.mockResolvedValue({
      ok: true,
      roleId: role.id,
      executionProfile: role,
      fitScore: 0.95,
      warnings: [],
      auditCandidates: [{ roleId: role.id, name: role.name, fitScore: 0.95, fits: true }],
    });

    const reqs = { tools: ["Read"] };
    const result = await createTaskWithAdmission({
      prompt: "implement fix",
      roleId: role.id,
      requirements: reqs,
    });

    expect(result.ok).toBe(true);
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.roleId).toBe(role.id);
    expect(task.config.executionProfile).toBe(role);
    expect(task.config.requirements).toEqual(reqs);
    expect(task.prompt).toBe("implement fix");
    expect(task.status).toBe("pending");
  });

  it("uses admission.roleId (not caller roleId) — autoSelectRole divergence", async () => {
    const chosen = makeRole({ id: "chosen-role", name: "Chosen" });
    mockAdmit.mockResolvedValue({
      ok: true,
      roleId: chosen.id,
      executionProfile: chosen,
      fitScore: 0.8,
      warnings: [],
      auditCandidates: [{ roleId: chosen.id, name: chosen.name, fitScore: 0.8, fits: true }],
    });

    const result = await createTaskWithAdmission({
      prompt: "do work",
      autoSelectRole: true,
      requirements: { tools: ["Read"] },
    });

    expect(result.ok).toBe(true);
    expect((result as { ok: true; roleId: string }).roleId).toBe("chosen-role");
    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.roleId).toBe("chosen-role");
  });

  it("emits task_created event after task creation", async () => {
    const role = makeRole();
    mockAdmit.mockResolvedValue({
      ok: true,
      roleId: role.id,
      executionProfile: role,
      fitScore: 1,
      warnings: [],
      auditCandidates: [{ roleId: role.id, name: role.name, fitScore: 1, fits: true }],
    });

    const result = await createTaskWithAdmission({ prompt: "go", roleId: role.id });

    expect(result.ok).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith({
      type: "task_created",
      taskId: (result as { ok: true; taskId: string }).taskId,
    });
  });

  it("records routing decision AFTER createTask (FK-safe ordering)", async () => {
    const role = makeRole();
    mockAdmit.mockResolvedValue({
      ok: true,
      roleId: role.id,
      executionProfile: role,
      fitScore: 0.9,
      warnings: [],
      auditCandidates: [{ roleId: role.id, name: role.name, fitScore: 0.9, fits: true }],
    });

    const callOrder: string[] = [];
    mockCreateTask.mockImplementation(() => {
      callOrder.push("createTask");
    });
    mockRecord.mockImplementation(() => {
      callOrder.push("recordRoutingDecision");
    });

    await createTaskWithAdmission({ prompt: "go", roleId: role.id, requirements: { tools: ["Read"] } });

    expect(callOrder).toEqual(["createTask", "recordRoutingDecision"]);
  });

  it("skips recordRoutingDecision when admission has no auditCandidates", async () => {
    const role = makeRole();
    mockAdmit.mockResolvedValue({
      ok: true,
      roleId: role.id,
      executionProfile: role,
      fitScore: 1,
      warnings: [],
      // auditCandidates intentionally omitted
    });

    await createTaskWithAdmission({ prompt: "go", roleId: role.id });

    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// permission composition: intersect allowedTools, union the rest
// ---------------------------------------------------------------------------

describe("createTaskWithAdmission — permission composition", () => {
  function setupAdmission(role: Role) {
    mockAdmit.mockResolvedValue({
      ok: true,
      roleId: role.id,
      executionProfile: role,
      fitScore: 1,
      warnings: [],
      auditCandidates: [{ roleId: role.id, name: role.name, fitScore: 1, fits: true }],
    });
  }

  it("intersects role.allowedTools with defaults.allowedTools", async () => {
    const role = makeRole({ allowedTools: ["Read", "Write", "Bash", "UnknownTool"] });
    setupAdmission(role);

    await createTaskWithAdmission({ prompt: "go", roleId: role.id });

    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.config.allowedTools?.sort()).toEqual(["Bash", "Read", "Write"].sort());
  });

  it("falls back to defaults.allowedTools when role has no allowedTools", async () => {
    const role = makeRole({ allowedTools: [] });
    setupAdmission(role);

    await createTaskWithAdmission({ prompt: "go", roleId: role.id });

    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.config.allowedTools).toEqual(BASE_DEFAULTS.allowedTools);
  });

  it("unions role.disallowedTools with defaults.disallowedTools", async () => {
    const role = makeRole({ disallowedTools: ["Edit"] });
    setupAdmission(role);

    await createTaskWithAdmission({ prompt: "go", roleId: role.id });

    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.config.disallowedTools?.sort()).toEqual(["Edit", "RemoveFile"].sort());
  });

  it("unions role.approvalRequired with defaults.approvalRequired", async () => {
    const role = makeRole({ approvalRequired: ["Bash"] });
    setupAdmission(role);

    await createTaskWithAdmission({ prompt: "go", roleId: role.id });

    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.config.approvalRequired?.sort()).toEqual(["Bash", "rm -rf *"].sort());
  });

  it("picks min(role.maxBudgetUsd, defaults.maxBudgetUsd)", async () => {
    const role = makeRole({ maxBudgetUsd: 2.0 });
    setupAdmission(role);

    await createTaskWithAdmission({ prompt: "go", roleId: role.id });

    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.config.maxBudgetUsd).toBe(2.0);
  });

  it("falls back to defaults.maxBudgetUsd when role's is 0", async () => {
    const role = makeRole({ maxBudgetUsd: 0 });
    setupAdmission(role);

    await createTaskWithAdmission({ prompt: "go", roleId: role.id });

    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.config.maxBudgetUsd).toBe(5.0);
  });

  it("honors toolOverrides.allowedTools (replaces effective)", async () => {
    const role = makeRole({ allowedTools: ["Read", "Write", "Bash"] });
    setupAdmission(role);

    await createTaskWithAdmission({
      prompt: "go",
      roleId: role.id,
      toolOverrides: { allowedTools: ["Read"] },
    });

    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.config.allowedTools).toEqual(["Read"]);
  });

  it("honors toolOverrides.disallowedTools (replaces effective)", async () => {
    const role = makeRole({ disallowedTools: ["Edit"] });
    setupAdmission(role);

    await createTaskWithAdmission({
      prompt: "go",
      roleId: role.id,
      toolOverrides: { disallowedTools: ["Bash"] },
    });

    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.config.disallowedTools).toEqual(["Bash"]);
  });
});

// ---------------------------------------------------------------------------
// strategy selection (Thompson Sampling)
// ---------------------------------------------------------------------------

describe("createTaskWithAdmission — strategy selection", () => {
  it("prefixes prompt with template and attaches strategyId when StrategyEngine returns one", async () => {
    const role = makeRole();
    mockAdmit.mockResolvedValue({
      ok: true,
      roleId: role.id,
      executionProfile: role,
      fitScore: 1,
      warnings: [],
      auditCandidates: [{ roleId: role.id, name: role.name, fitScore: 1, fits: true }],
    });
    mockSelectStrategy.mockReturnValue({
      id: "strat-42",
      roleId: role.id,
      taskType: "coding",
      name: "test-strategy",
      promptTemplate: "Apply SOLID principles.",
      alpha: 1,
      beta: 1,
      totalTrials: 0,
      createdAt: Date.now(),
    });

    const result = await createTaskWithAdmission({
      prompt: "implement a new feature",
      roleId: role.id,
    });

    expect(result.ok).toBe(true);
    expect((result as { ok: true; strategyId?: string }).strategyId).toBe("strat-42");
    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.prompt).toBe("Apply SOLID principles.\n\n## Task\nimplement a new feature");
    expect(task.originalPrompt).toBe("implement a new feature");
  });

  it("leaves prompt unchanged when no strategy is selected", async () => {
    const role = makeRole();
    mockAdmit.mockResolvedValue({
      ok: true,
      roleId: role.id,
      executionProfile: role,
      fitScore: 1,
      warnings: [],
      auditCandidates: [{ roleId: role.id, name: role.name, fitScore: 1, fits: true }],
    });
    mockSelectStrategy.mockReturnValue(null);

    const result = await createTaskWithAdmission({
      prompt: "review this PR",
      roleId: role.id,
    });

    expect(result.ok).toBe(true);
    expect((result as { ok: true; strategyId?: string }).strategyId).toBeUndefined();
    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.prompt).toBe("review this PR");
  });

  it("routes strategy selection by inferred task type", async () => {
    const role = makeRole();
    mockAdmit.mockResolvedValue({
      ok: true,
      roleId: role.id,
      executionProfile: role,
      fitScore: 1,
      warnings: [],
      auditCandidates: [{ roleId: role.id, name: role.name, fitScore: 1, fits: true }],
    });

    await createTaskWithAdmission({ prompt: "implement a bug fix", roleId: role.id });
    expect(mockSelectStrategy).toHaveBeenLastCalledWith(role.id, "coding");

    await createTaskWithAdmission({ prompt: "analyze the sales data", roleId: role.id });
    expect(mockSelectStrategy).toHaveBeenLastCalledWith(role.id, "analysis");

    await createTaskWithAdmission({ prompt: "write a summary article", roleId: role.id });
    expect(mockSelectStrategy).toHaveBeenLastCalledWith(role.id, "content");

    await createTaskWithAdmission({ prompt: "review this change", roleId: role.id });
    expect(mockSelectStrategy).toHaveBeenLastCalledWith(role.id, "review");

    await createTaskWithAdmission({ prompt: "deploy and manage config", roleId: role.id });
    expect(mockSelectStrategy).toHaveBeenLastCalledWith(role.id, "admin");

    await createTaskWithAdmission({ prompt: "say hello", roleId: role.id });
    expect(mockSelectStrategy).toHaveBeenLastCalledWith(role.id, "general");
  });
});

// ---------------------------------------------------------------------------
// runtime config resilience
// ---------------------------------------------------------------------------

describe("createTaskWithAdmission — runtime config resilience", () => {
  it("falls back to DEFAULT_CONFIG when getRuntimeConfig throws", async () => {
    const role = makeRole();
    mockAdmit.mockResolvedValue({
      ok: true,
      roleId: role.id,
      executionProfile: role,
      fitScore: 1,
      warnings: [],
      auditCandidates: [{ roleId: role.id, name: role.name, fitScore: 1, fits: true }],
    });
    mockRuntimeConfig.mockImplementation(() => {
      throw new Error("runtime not initialized");
    });

    const result = await createTaskWithAdmission({ prompt: "go", roleId: role.id });

    expect(result.ok).toBe(true);
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// task config propagation
// ---------------------------------------------------------------------------

describe("createTaskWithAdmission — config propagation", () => {
  it("propagates parentId, templateId, stepId, sourceSessionId to task", async () => {
    const role = makeRole();
    mockAdmit.mockResolvedValue({
      ok: true,
      roleId: role.id,
      executionProfile: role,
      fitScore: 1,
      warnings: [],
      auditCandidates: [{ roleId: role.id, name: role.name, fitScore: 1, fits: true }],
    });

    await createTaskWithAdmission({
      prompt: "go",
      roleId: role.id,
      parentId: "parent-1",
      templateId: "tmpl-1",
      stepId: "step-1",
      sourceSessionId: "sess-1",
    });

    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.parentId).toBe("parent-1");
    expect(task.templateId).toBe("tmpl-1");
    expect(task.stepId).toBe("step-1");
    expect(task.sourceSessionId).toBe("sess-1");
  });

  it("uses executionProfile.model when config.model is not set", async () => {
    const role = makeRole({ model: "claude-opus-4-6" });
    mockAdmit.mockResolvedValue({
      ok: true,
      roleId: role.id,
      executionProfile: role,
      fitScore: 1,
      warnings: [],
      auditCandidates: [{ roleId: role.id, name: role.name, fitScore: 1, fits: true }],
    });

    await createTaskWithAdmission({ prompt: "go", roleId: role.id });

    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.config.model).toBe("claude-opus-4-6");
  });

  it("lets caller config.model override executionProfile.model", async () => {
    const role = makeRole({ model: "claude-opus-4-6" });
    mockAdmit.mockResolvedValue({
      ok: true,
      roleId: role.id,
      executionProfile: role,
      fitScore: 1,
      warnings: [],
      auditCandidates: [{ roleId: role.id, name: role.name, fitScore: 1, fits: true }],
    });

    await createTaskWithAdmission({
      prompt: "go",
      roleId: role.id,
      config: { model: "claude-sonnet-4-6" },
    });

    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.config.model).toBe("claude-sonnet-4-6");
  });
});

// ---------------------------------------------------------------------------
// maxTurns fallback chain (Phase 2: raised from 100 to 400)
// ---------------------------------------------------------------------------

describe("createTaskWithAdmission — maxTurns fallback chain", () => {
  function setupAdmission(role: Role) {
    mockAdmit.mockResolvedValue({
      ok: true,
      roleId: role.id,
      executionProfile: role,
      fitScore: 1,
      warnings: [],
      auditCandidates: [{ roleId: role.id, name: role.name, fitScore: 1, fits: true }],
    });
  }

  it("uses defaults.maxTurns (400) when config is undefined", async () => {
    const role = makeRole();
    setupAdmission(role);

    await createTaskWithAdmission({ prompt: "go", roleId: role.id });

    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.config.maxTurns).toBe(400);
  });

  it("uses defaults.maxTurns (400) when config.maxTurns is undefined", async () => {
    const role = makeRole();
    setupAdmission(role);

    await createTaskWithAdmission({
      prompt: "go",
      roleId: role.id,
      config: { maxBudgetUsd: 1.0 },
    });

    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.config.maxTurns).toBe(400);
  });

  it("uses explicit config.maxTurns when provided (override works)", async () => {
    const role = makeRole();
    setupAdmission(role);

    await createTaskWithAdmission({
      prompt: "go",
      roleId: role.id,
      config: { maxTurns: 250 },
    });

    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.config.maxTurns).toBe(250);
  });

  it("uses explicit config.maxTurns=50 (ChatManager-style pin) without affecting defaults", async () => {
    const role = makeRole();
    setupAdmission(role);

    await createTaskWithAdmission({
      prompt: "go",
      roleId: role.id,
      config: { maxTurns: 50 },
    });

    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.config.maxTurns).toBe(50);
    // defaults still 400 for non-pinned tasks
    expect(DEFAULT_CONFIG.defaults.maxTurns).toBe(400);
  });

  it("uses explicit config.maxTurns=1000 — no upper cap", async () => {
    const role = makeRole();
    setupAdmission(role);

    await createTaskWithAdmission({
      prompt: "go",
      roleId: role.id,
      config: { maxTurns: 1000 },
    });

    const task = mockCreateTask.mock.calls[0][0] as Task;
    expect(task.config.maxTurns).toBe(1000);
  });
});

describe("createTaskWithAdmission — legacy/Template compatibility", () => {
  it("creates task with explicit roleId and empty requirements", async () => {
    const role = makeRole();
    mockAdmit.mockResolvedValue({
      ok: true,
      roleId: role.id,
      executionProfile: role,
      fitScore: 1,
      warnings: [],
      auditCandidates: [{ roleId: role.id, name: role.name, fitScore: 1, fits: true }],
    });

    const result = await createTaskWithAdmission({
      prompt: "legacy or template task",
      roleId: role.id,
      requirements: {},
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.taskId).toBeDefined();
      expect(result.roleId).toBe(role.id);
    }

    // createTask was called — admission didn't reject empty requirements
    expect(mockCreateTask).toHaveBeenCalled();
  });
});
