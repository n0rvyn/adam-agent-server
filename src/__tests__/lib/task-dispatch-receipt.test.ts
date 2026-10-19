import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

// Mock store/db.js before any imports so effect-receipts.js uses the test DB
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock writeMutationReceipt so it doesn't call the real module (which would require
// tracing setup in this test context). We spy on the mock to verify call arguments.
vi.mock("../../audit/mutation-receipt-writer.js", () => ({
  writeMutationReceipt: vi.fn(),
}));

// Mock task-admission so we can control role selection
vi.mock("../../lib/task-admission.js", () => ({
  admitTask: vi.fn(),
}));

// Mock createTask to prevent real DB writes (task-dispatch.ts calls createTask first,
// then writeMutationReceipt)
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
  StrategyEngine: { selectStrategy: vi.fn() },
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
}));

import { createTaskWithAdmission } from "../../lib/task-dispatch.js";
import { admitTask } from "../../lib/task-admission.js";
import { createTask } from "../../store/tasks.js";
import { getRuntimeConfig } from "../../config/runtime.js";
import { StrategyEngine } from "../../strategy/engine.js";
import { writeMutationReceipt } from "../../audit/mutation-receipt-writer.js";
import type { AdmissionResult } from "../../shared/types.js";

const { cleanup } = setupTestDb();
afterAll(() => cleanup());

function makeRole(overrides: Partial<import("../../shared/types.js").Role> = {}) {
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
    disallowedTools: [],
    approvalRequired: [],
    maxBudgetUsd: 2.0,
    model: "claude-sonnet-4-6",
    source: "user",
    ...overrides,
  } as import("../../shared/types.js").Role;
}

const BASE_DEFAULTS = {
  timeout: 600,
  maxTurns: 400,
  maxBudgetUsd: 5.0,
  effort: "high" as const,
  model: "",
  settingSources: ["user", "project"] as Array<"user" | "project" | "local">,
  allowedTools: ["Read", "Write", "Bash"],
  disallowedTools: [],
  approvalRequired: [],
  approvalTimeout: 600,
  env: {},
  plugins: [],
  workspacePath: "/tmp/workspace",
  workspaceRetention: "immediate" as const,
  deniedReadPaths: [] as string[],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(writeMutationReceipt).mockClear();
  vi.mocked(getRuntimeConfig).mockReturnValue({ defaults: BASE_DEFAULTS } as unknown as ReturnType<typeof getRuntimeConfig>);
  vi.mocked(StrategyEngine.selectStrategy).mockReturnValue(null);
  clearTestDb();
});

describe("createTaskWithAdmission — receipt injection", () => {
  it("writes a task-creation receipt via writeMutationReceipt when dispatchSource is provided", async () => {
    vi.mocked(admitTask).mockResolvedValue({
      ok: true,
      roleId: "role-1",
      fitScore: 1.0,
      executionProfile: { allowedTools: [], disallowedTools: [], maxBudgetUsd: 5.0 },
    } as unknown as AdmissionResult);

    await createTaskWithAdmission({
      prompt: "test task prompt",
      roleId: "role-1",
      dispatchSource: "dispatch_task",
    });

    expect(vi.mocked(writeMutationReceipt)).toHaveBeenCalledTimes(1);
    const [receipt] = vi.mocked(writeMutationReceipt).mock.calls[0];
    expect(receipt.toolName).toBe("dispatch_task");
    expect(receipt.entityType).toBe("task");
    expect(receipt.verb).toBe("create");
    expect(receipt.entityId).toBeTruthy(); // UUID assigned by createTaskWithAdmission
    expect(receipt.fieldChanges).toHaveLength(1);
    expect(receipt.fieldChanges![0].path).toBe("_entity");
    expect(receipt.fieldChanges![0].op).toBe("set");
    expect(receipt.fieldChanges![0].before).toBeNull();
    expect(receipt.fieldChanges![0].after).toMatchObject({
      roleId: "role-1",
      status: "pending",
    });
    expect(receipt.taskId).toBeTruthy();
    expect(receipt.roleId).toBe("role-1");
  });

  it("uses 'createTaskWithAdmission' as default toolName when dispatchSource is omitted", async () => {
    vi.mocked(admitTask).mockResolvedValue({
      ok: true,
      roleId: "role-1",
      fitScore: 1.0,
      executionProfile: { allowedTools: [], disallowedTools: [], maxBudgetUsd: 5.0 },
    } as unknown as AdmissionResult);

    await createTaskWithAdmission({
      prompt: "test task prompt",
      roleId: "role-1",
    });

    expect(vi.mocked(writeMutationReceipt)).toHaveBeenCalledTimes(1);
    const [receipt] = vi.mocked(writeMutationReceipt).mock.calls[0];
    expect(receipt.toolName).toBe("createTaskWithAdmission");
  });

  it("passes traceIdOverride from input.traceId so receipts attach to the original trace", async () => {
    vi.mocked(admitTask).mockResolvedValue({
      ok: true,
      roleId: "role-1",
      fitScore: 1.0,
      executionProfile: { allowedTools: [], disallowedTools: [], maxBudgetUsd: 5.0 },
    } as unknown as AdmissionResult);

    await createTaskWithAdmission({
      prompt: "retry task",
      roleId: "role-1",
      traceId: "trace-parent",
      dispatchSource: "chat_manager_retry",
    });

    expect(vi.mocked(writeMutationReceipt)).toHaveBeenCalledTimes(1);
    const [receipt] = vi.mocked(writeMutationReceipt).mock.calls[0];
    expect(receipt.traceIdOverride).toBe("trace-parent");
    expect(receipt.taskId).toBeTruthy();
    expect(receipt.sessionId).toBeUndefined(); // sourceSessionId not passed in this call
  });

  it("does NOT call writeMutationReceipt when admission fails (early return)", async () => {
    vi.mocked(admitTask).mockResolvedValue({
      ok: false,
      code: "ROLE_NOT_FOUND",
      reason: "No such role",
    } as unknown as AdmissionResult);

    const result = await createTaskWithAdmission({
      prompt: "test",
      roleId: "missing-role",
    });

    expect(result.ok).toBe(false);
    expect(vi.mocked(writeMutationReceipt)).not.toHaveBeenCalled();
    expect(vi.mocked(createTask)).not.toHaveBeenCalled();
  });
});
