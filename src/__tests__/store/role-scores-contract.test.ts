/**
 * Task 7 test: getRoleContractComplianceEma query helper.
 *
 * Tests:
 * - EMA over [1.0, 0.5, 0.25] (newest-first from getScoresByRole) → emaScore = 0.5275
 * - 0 rows with contractCompliance → emaScore = null
 *
 * Bug classes from prior deleted version:
 * 2. FK constraint: role_scores.role_id and role_scores.task_id are FK columns.
 *    Must call createRole + createTask before recordTaskScore.
 *
 * IMPORTANT: audit-violations.ts must be mocked so its getDb() returns the test DB.
 * Use vi.hoisted() so mock factories are available when the mock module factory runs.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// Hoisted mock factories — vi.hoisted() ensures they're ready when the mock module factory runs
const { _mockRecordAuditViolation, _mockGetViolationsByTask, _mockGetViolationsByRole } =
  vi.hoisted(() => ({
    _mockRecordAuditViolation: vi.fn(),
    _mockGetViolationsByTask: vi.fn(),
    _mockGetViolationsByRole: vi.fn(),
  }));

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../store/audit-violations.js", () => ({
  recordAuditViolation: (...args: unknown[]) => _mockRecordAuditViolation(...args),
  getViolationsByTask: (...args: unknown[]) => _mockGetViolationsByTask(...args),
  getViolationsByRole: (...args: unknown[]) => _mockGetViolationsByRole(...args),
}));

import { getRoleContractComplianceEma } from "../../store/role-scores.js";
import { recordTaskScore } from "../../audit/score.js";
import { createRole } from "../../store/roles.js";
import { createTask } from "../../store/tasks.js";
import type { TaskConfig } from "../../shared/types.js";

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
    id, name: id, cagPrompt: "test", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: `ms-${id}`,
    status: "active", preferences: {}, createdAt: Date.now(),
  });
}

function seedTask(id: string, roleId: string, config?: TaskConfig): void {
  createTask({
    id,
    status: "completed",
    prompt: "test",
    roleId,
    createdAt: Date.now(),
    completedAt: Date.now(),
    config: config ?? tc(),
  });
}

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
  seedRole("role-ema-test");
  _mockRecordAuditViolation.mockReset();
  _mockGetViolationsByTask.mockReset();
  _mockGetViolationsByRole.mockReset();
  _mockGetViolationsByTask.mockReturnValue([]);
  _mockGetViolationsByRole.mockReturnValue([]);
});

describe("getRoleContractComplianceEma", () => {
  // ---------------------------------------------------------------------------
  // EMA over [1.0, 0.5, 0.25] (newest-first from getScoresByRole)
  // → ordered [0.25, 0.5, 1.0] (oldest first via reverse())
  // → idx=0: ema=0.25 (seed)
  // → idx=1: ema = 0.3·0.5 + 0.7·0.25 = 0.325
  // → idx=2: ema = 0.3·1.0 + 0.7·0.325 = 0.5275
  //
  // Use outputContractCheckCount=8 and configure getViolationsByTask mock to return
  // the right violation counts so the stored contractCompliance values are:
  // - task-ema-3 (newest): 0 violations → 1 - 0/8 = 1.0
  // - task-ema-2: 4 violations → 1 - 4/8 = 0.5
  // - task-ema-1 (oldest): 6 violations → 1 - 6/8 = 0.25
  // ---------------------------------------------------------------------------
  it("EMA over [1.0, 0.5, 0.25] → emaScore = 0.5275", () => {
    // Seed tasks
    seedTask("task-ema-3", "role-ema-test", tc({ outputContractCheckCount: 8 }));
    seedTask("task-ema-2", "role-ema-test", tc({ outputContractCheckCount: 8 }));
    seedTask("task-ema-1", "role-ema-test", tc({ outputContractCheckCount: 8 }));

    // Configure getViolationsByTask mock to return correct violation counts
    _mockGetViolationsByTask.mockImplementation((taskId: string) => {
      if (taskId === "task-ema-3") return [];
      if (taskId === "task-ema-2") {
        return Array(4).fill(null).map((_, i) => ({
          id: `v2-${i}`, stepTaskId: taskId, roleId: "role-ema-test",
          contractField: "lengthTarget" as const, layer: "A" as const,
          severity: "error" as const, message: `violation ${i}`, createdAt: Date.now(),
        }));
      }
      if (taskId === "task-ema-1") {
        return Array(6).fill(null).map((_, i) => ({
          id: `v1-${i}`, stepTaskId: taskId, roleId: "role-ema-test",
          contractField: "lengthTarget" as const, layer: "A" as const,
          severity: "error" as const, message: `violation ${i}`, createdAt: Date.now(),
        }));
      }
      return [];
    });

    // Force monotonic timestamps so ORDER BY created_at DESC is deterministic.
    // Without this, three rapid recordTaskScore calls share a millisecond and SQLite's
    // tie-breaking is implementation-defined, producing unpredictable EMA inputs.
    const origNow = Date.now;
    let counter = 1_700_000_000_000;
    Date.now = () => counter++;
    try {
      recordTaskScore("role-ema-test", "task-ema-1");
      recordTaskScore("role-ema-test", "task-ema-2");
      recordTaskScore("role-ema-test", "task-ema-3");
    } finally {
      Date.now = origNow;
    }

    const result = getRoleContractComplianceEma("role-ema-test");
    expect(result.emaScore).toBeCloseTo(0.5275, 2);
    expect(result.contractsCheckedRowCount).toBe(3);
    expect(Array.isArray(result.recentViolations)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 0 rows with contractCompliance → emaScore = null
  // ---------------------------------------------------------------------------
  it("0 rows with contractCompliance → emaScore = null", () => {
    seedTask("task-no-cc-1", "role-ema-test", tc({ outputContractCheckCount: 0 }));
    seedTask("task-no-cc-2", "role-ema-test", tc({ outputContractCheckCount: 0 }));

    recordTaskScore("role-ema-test", "task-no-cc-1");
    recordTaskScore("role-ema-test", "task-no-cc-2");

    const result = getRoleContractComplianceEma("role-ema-test");
    expect(result.emaScore).toBeNull();
    expect(result.contractsCheckedRowCount).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Single row with contractCompliance = 1.0 → emaScore = 1.0 (seed)
  // ---------------------------------------------------------------------------
  it("single row with contractCompliance = 1.0 → emaScore = 1.0 (seed)", () => {
    seedTask("task-single-cc", "role-ema-test", tc({ outputContractCheckCount: 1 }));
    recordTaskScore("role-ema-test", "task-single-cc");

    const result = getRoleContractComplianceEma("role-ema-test");
    expect(result.emaScore).toBeCloseTo(1.0, 4);
    expect(result.contractsCheckedRowCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // EMA respects the limit parameter
  // ---------------------------------------------------------------------------
  it("limit parameter restricts the rows considered for EMA", () => {
    for (let i = 1; i <= 5; i++) {
      seedTask(`task-limit-${i}`, "role-ema-test", tc({ outputContractCheckCount: 1 }));
      recordTaskScore("role-ema-test", `task-limit-${i}`);
    }

    const result = getRoleContractComplianceEma("role-ema-test", 2);
    expect(result.contractsCheckedRowCount).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // recentViolations returns up to 10 most recent violations for the role
  // ---------------------------------------------------------------------------
  it("recentViolations returns up to 10 most recent violations", () => {
    _mockGetViolationsByRole.mockReturnValue([]);
    const result = getRoleContractComplianceEma("role-ema-test");
    expect(Array.isArray(result.recentViolations)).toBe(true);
    expect(result.recentViolations.length).toBe(0);
  });
});
