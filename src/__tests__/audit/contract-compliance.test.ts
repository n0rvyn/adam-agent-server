/**
 * Task 6 test: audit-manager + score.ts integration for contract_compliance.
 *
 * Tests:
 * - computeTaskScore reads outputContractCheckCount and audit_violations to
 *   compute contractCompliance.
 * - evaluateTaskCompletion skips intent-eval when taskType === "contract-verifier".
 *
 * Bug classes from prior deleted version:
 * 1. vi.mock hoisting: use vi.hoisted() for evaluateIntentFulfillment mock.
 * 2. TaskConfig partial literals: use tc() helper for required fields.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

const { mockEvaluateIntentFulfillment } = vi.hoisted(() => ({
  mockEvaluateIntentFulfillment: vi.fn().mockResolvedValue({ score: 0.8, failed: false }),
}));

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../audit/intent-eval.js", () => ({
  evaluateIntentFulfillment: (...args: unknown[]) => mockEvaluateIntentFulfillment(...args),
}));

import { computeTaskScore } from "../../audit/score.js";
import { evaluateTaskCompletion } from "../../audit/audit-manager.js";
import { createRole } from "../../store/roles.js";
import { createTask, updateTaskConfig } from "../../store/tasks.js";
import { recordAuditViolation } from "../../store/audit-violations.js";
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

function seedRole(id: string): void {
  createRole({
    id, name: id, cagPrompt: "test role", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: `ms-${id}`,
    status: "active", preferences: {}, createdAt: Date.now(),
  });
}

function seedTask(id: string, roleId: string, config: TaskConfig): void {
  createTask({
    id,
    status: "completed",
    prompt: "test prompt",
    roleId,
    createdAt: Date.now(),
    completedAt: Date.now(),
    config,
  });
}

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
  seedRole("role-contract-test");
  seedRole("role-contract-test-2");
  seedRole("role-reviewer"); // the verifier role
});

describe("contractCompliance in computeTaskScore", () => {
  // ---------------------------------------------------------------------------
  // 3 violations, 4 checks → contractCompliance = 1 - 3/4 = 0.25
  // ---------------------------------------------------------------------------
  it("3 violations + 4 checks → contractCompliance = 0.25", () => {
    seedTask("task-violations-3of4", "role-contract-test", tc({ outputContractCheckCount: 4 }));
    recordAuditViolation({
      id: "v1", stepTaskId: "task-violations-3of4", roleId: "role-contract-test",
      contractField: "lengthTarget", layer: "A", severity: "error",
      message: "too short", createdAt: Date.now(),
    });
    recordAuditViolation({
      id: "v2", stepTaskId: "task-violations-3of4", roleId: "role-contract-test",
      contractField: "format", layer: "A", severity: "error",
      message: "no heading", createdAt: Date.now(),
    });
    recordAuditViolation({
      id: "v3", stepTaskId: "task-violations-3of4", roleId: "role-contract-test",
      contractField: "persona.speakAs", layer: "A", severity: "error",
      message: "identity drift", createdAt: Date.now(),
    });

    const scores = computeTaskScore("task-violations-3of4", "role-contract-test");
    expect(scores.contractCompliance).toBeCloseTo(0.25, 4);
    expect(scores.contractsCheckedThisTask).toBe(4);
    // weighted is separate signal — verify it is computed
    expect(typeof scores.weighted).toBe("number");
  });

  // ---------------------------------------------------------------------------
  // 0 violations, 4 checks → contractCompliance = 1.0
  // ---------------------------------------------------------------------------
  it("0 violations + 4 checks → contractCompliance = 1.0", () => {
    seedTask("task-clean-4", "role-contract-test", tc({ outputContractCheckCount: 4 }));

    const scores = computeTaskScore("task-clean-4", "role-contract-test");
    expect(scores.contractCompliance).toBeCloseTo(1.0, 4);
    expect(scores.contractsCheckedThisTask).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // 0 violations, 0 checks → contractCompliance = null (excluded)
  // ---------------------------------------------------------------------------
  it("0 violations + 0 checks → contractCompliance = null (excluded)", () => {
    seedTask("task-no-checks", "role-contract-test", tc({ outputContractCheckCount: 0 }));

    const scores = computeTaskScore("task-no-checks", "role-contract-test");
    expect(scores.contractCompliance).toBeNull();
    expect(scores.contractsCheckedThisTask).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 1 violation, 1 check → contractCompliance = 0.0
  // ---------------------------------------------------------------------------
  it("1 violation + 1 check → contractCompliance = 0.0", () => {
    seedTask("task-fail-1of1", "role-contract-test", tc({ outputContractCheckCount: 1 }));
    recordAuditViolation({
      id: "v1", stepTaskId: "task-fail-1of1", roleId: "role-contract-test",
      contractField: "lengthTarget", layer: "A", severity: "error",
      message: "too short", createdAt: Date.now(),
    });

    const scores = computeTaskScore("task-fail-1of1", "role-contract-test");
    expect(scores.contractCompliance).toBeCloseTo(0.0, 4);
  });

  // ---------------------------------------------------------------------------
  // weighted formula unchanged regardless of contractCompliance
  // ---------------------------------------------------------------------------
  it("weighted formula unchanged regardless of contractCompliance", () => {
    // Two identical tasks with different contractCompliance values
    // Both should have the same weighted score (weighted uses 4-dim, not contractCompliance)
    seedTask("task-weighted-1", "role-contract-test", tc({ outputContractCheckCount: 4 }));
    seedTask("task-weighted-2", "role-contract-test-2", tc({ outputContractCheckCount: 0 }));

    const scores1 = computeTaskScore("task-weighted-1", "role-contract-test");
    const scores2 = computeTaskScore("task-weighted-2", "role-contract-test-2");

    // Both are successful, completed tasks with no deviations or permission issues
    // So taskSuccess=1, planAccuracy=1, permissionCompliance=1, efficiency=1
    // weighted (legacy 4-dim) = 0.3*1 + 0.25*1 + 0.25*1 + 0.2*1 = 1.0
    expect(scores1.weighted).toBeCloseTo(1.0, 2);
    expect(scores2.weighted).toBeCloseTo(1.0, 2);
    // But contractCompliance differs
    expect(scores1.contractCompliance).not.toEqual(scores2.contractCompliance);
  });
});

describe("evaluateTaskCompletion recursion guard", () => {
  // ---------------------------------------------------------------------------
  // intent-eval is called for normal tasks
  // ---------------------------------------------------------------------------
  it("intent-eval is called for normal tasks (taskType !== contract-verifier)", async () => {
    seedTask("task-normal", "role-contract-test", tc());

    evaluateTaskCompletion("task-normal", "role-contract-test");

    // Wait for setImmediate to fire
    await new Promise((r) => setImmediate(r));

    expect(mockEvaluateIntentFulfillment).toHaveBeenCalledWith("task-normal", "role-contract-test");
  });

  // ---------------------------------------------------------------------------
  // intent-eval is SKIPPED for contract-verifier tasks
  // ---------------------------------------------------------------------------
  it("intent-eval is skipped for taskType === 'contract-verifier'", async () => {
    seedTask("task-verifier", "role-reviewer", tc({ taskType: "contract-verifier" }));

    evaluateTaskCompletion("task-verifier", "role-reviewer");

    // Wait for setImmediate to fire
    await new Promise((r) => setImmediate(r));

    // intent-eval must NOT be called for verifier tasks
    expect(mockEvaluateIntentFulfillment).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // verifier task still records its own score (so reviewer Role gets credit/discredit)
  // ---------------------------------------------------------------------------
  it("verifier task still records a score row (role gets credit/discredit)", () => {
    seedTask("task-verifier-record", "role-reviewer", tc({ taskType: "contract-verifier" }));

    evaluateTaskCompletion("task-verifier-record", "role-reviewer");

    // Verify that a role_scores row was created (score was recorded)
    const db = getTestDb();
    const rows = db.prepare(
      "SELECT * FROM role_scores WHERE task_id = ? AND role_id = ?"
    ).all("task-verifier-record", "role-reviewer") as { id: string }[];
    expect(rows).toHaveLength(1);
  });
});
