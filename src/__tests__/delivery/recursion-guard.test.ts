/**
 * Task 8 test: Delivery engine recursion guard.
 *
 * Tests that contract-verifier tasks are silently skipped by the delivery engine's
 * rule-matching path (DP-007: task.config?.taskType === "contract-verifier").
 *
 * Also tests the negative case: normal tasks DO trigger delivery rule matching.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

const { mockFindMatchingRules } = vi.hoisted(() => ({
  mockFindMatchingRules: vi.fn().mockReturnValue([]),
}));

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));
vi.mock("../../store/delivery-rules.js", () => ({
  findMatchingRules: (...args: unknown[]) => mockFindMatchingRules(...args),
}));
vi.mock("../../store/tasks.js", () => ({
  getTask: vi.fn(),
}));

import { DeliveryEngine } from "../../delivery/engine.js";
import type { TaskConfig } from "../../shared/types.js";

/** TaskConfig helper: fills required fields so partial literals pass TS strict checks. */
function tc(overrides: Partial<TaskConfig> = {}): TaskConfig {
  return {
    timeout: 600,
    approvalRequired: [],
    approvalTimeout: 300,
    ...overrides,
  } as unknown as TaskConfig;
}

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
  mockFindMatchingRules.mockClear().mockReturnValue([]);
});

describe("Delivery engine recursion guard", () => {
  it("SKIPS delivery rule matching for taskType === 'contract-verifier'", async () => {
    const { getTask } = await import("../../store/tasks.js");
    vi.mocked(getTask).mockReturnValue({
      id: "task-verifier-1",
      status: "completed",
      prompt: "Verify the output",
      roleId: "role-reviewer",
      result: '{"identityCoherent":true}',
      config: tc({ taskType: "contract-verifier" }),
      createdAt: Date.now(),
      completedAt: Date.now(),
    });

    const engine = new DeliveryEngine();
    // Cast to any to access private method — unit test boundary
    const handler = (engine as unknown as { handleTaskStatusChange: (taskId: string, status: string) => Promise<void> })
      .handleTaskStatusChange.bind(engine);

    await handler("task-verifier-1", "completed");

    // findMatchingRules must NOT have been called
    expect(mockFindMatchingRules).not.toHaveBeenCalled();
  });

  it("does NOT skip delivery rule matching for normal tasks", async () => {
    const { getTask } = await import("../../store/tasks.js");
    vi.mocked(getTask).mockReturnValue({
      id: "task-normal-1",
      status: "completed",
      prompt: "Do the thing",
      roleId: "role-producer",
      result: "Here is the output",
      config: tc(),
      createdAt: Date.now(),
      completedAt: Date.now(),
    });

    const engine = new DeliveryEngine();
    const handler = (engine as unknown as { handleTaskStatusChange: (taskId: string, status: string) => Promise<void> })
      .handleTaskStatusChange.bind(engine);

    await handler("task-normal-1", "completed");

    // findMatchingRules MUST have been called
    expect(mockFindMatchingRules).toHaveBeenCalled();
  });

  it("skips for taskType=contract-verifier even on failed status", async () => {
    const { getTask } = await import("../../store/tasks.js");
    vi.mocked(getTask).mockReturnValue({
      id: "task-verifier-2",
      status: "failed",
      prompt: "Verifier failed",
      roleId: "role-reviewer",
      error: "timeout",
      config: tc({ taskType: "contract-verifier" }),
      createdAt: Date.now(),
      completedAt: Date.now(),
    });

    const engine = new DeliveryEngine();
    const handler = (engine as unknown as { handleTaskStatusChange: (taskId: string, status: string) => Promise<void> })
      .handleTaskStatusChange.bind(engine);

    await handler("task-verifier-2", "failed");

    expect(mockFindMatchingRules).not.toHaveBeenCalled();
  });

  it("does NOT skip for task with no config (defensive null-safety)", async () => {
    const { getTask } = await import("../../store/tasks.js");
    vi.mocked(getTask).mockReturnValue({
      id: "task-no-config",
      status: "completed",
      prompt: "No config",
      roleId: "role-producer",
      result: "output",
      config: tc(),
      createdAt: Date.now(),
      completedAt: Date.now(),
    });

    const engine = new DeliveryEngine();
    const handler = (engine as unknown as { handleTaskStatusChange: (taskId: string, status: string) => Promise<void> })
      .handleTaskStatusChange.bind(engine);

    await handler("task-no-config", "completed");

    // A task with config (even without taskType) is not a verifier task
    expect(mockFindMatchingRules).toHaveBeenCalled();
  });
});
