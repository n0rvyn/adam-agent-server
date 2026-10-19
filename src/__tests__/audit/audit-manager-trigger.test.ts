import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

// vi.hoisted ensures mocks are available before vi.mock factories run (vi.mock is hoisted)
const {
  mockEvaluateIntentFulfillment,
  mockUpdateRoleScoreWithIntent,
  mockGetLatestRoleScore,
  mockUpdateRole,
  mockRecordTaskScore,
  mockGetRole,
  mockCheckProbationGraduation,
  mockCheckRetirement,
  mockReinstateAgent,
} = vi.hoisted(() => ({
  mockEvaluateIntentFulfillment: vi.fn(),
  mockUpdateRoleScoreWithIntent: vi.fn(),
  mockGetLatestRoleScore: vi.fn(),
  mockUpdateRole: vi.fn(),
  mockRecordTaskScore: vi.fn(),
  mockGetRole: vi.fn(),
  mockCheckProbationGraduation: vi.fn(),
  mockCheckRetirement: vi.fn(),
  mockReinstateAgent: vi.fn(),
}));

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../audit/intent-eval.js", () => ({
  evaluateIntentFulfillment: mockEvaluateIntentFulfillment,
}));

vi.mock("../../store/role-scores.js", () => ({
  updateRoleScoreWithIntent: mockUpdateRoleScoreWithIntent,
  getLatestRoleScore: mockGetLatestRoleScore,
}));

vi.mock("../../audit/score.js", () => ({
  recordTaskScore: mockRecordTaskScore,
  computeWeighted: vi.fn(),
  EMA_ALPHA: 0.3,
}));

vi.mock("../../store/roles.js", () => ({
  getRole: mockGetRole,
  updateRole: mockUpdateRole,
  incrementRoleTaskSeq: vi.fn(),
  getRoleTaskSeq: vi.fn().mockReturnValue(0),
}));

vi.mock("../../audit/retirement.js", () => ({
  checkProbationGraduation: mockCheckProbationGraduation,
  checkRetirement: mockCheckRetirement,
  reinstateAgent: mockReinstateAgent,
}));

vi.mock("../../audit/diagnostic.js", () => ({
  generateDiagnosticReport: vi.fn(),
}));

vi.mock("../../sandbox/provider.js", () => ({
  getSandboxProvider: vi.fn(() => ({ platform: "none" })),
  isSandboxAvailable: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { evaluateTaskCompletion } from "../../audit/audit-manager.js";

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
  // CRITICAL: opt setImmediate into fake timers — vitest does NOT fake it by default
  vi.useFakeTimers({ toFake: ["setImmediate", "setTimeout", "queueMicrotask"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("audit/audit-manager — evaluateTaskCompletion async intent-eval wiring", () => {
  it("synchronously: evaluateIntentFulfillment NOT called before setImmediate drains", () => {
    mockGetRole.mockReturnValue({ id: "r1", name: "Test", status: "active", cagPrompt: "" });
    mockRecordTaskScore.mockReturnValue(0.8);
    mockCheckProbationGraduation.mockReturnValue(false);
    mockCheckRetirement.mockReturnValue(false);

    evaluateTaskCompletion("t1", "r1");

    expect(mockEvaluateIntentFulfillment).not.toHaveBeenCalled();
  });

  it("after runAllTimersAsync: evaluateIntentFulfillment called with (taskId, roleId)", async () => {
    mockGetRole.mockReturnValue({ id: "r1", name: "Test", status: "active", cagPrompt: "" });
    mockRecordTaskScore.mockReturnValue(0.8);
    mockCheckProbationGraduation.mockReturnValue(false);
    mockCheckRetirement.mockReturnValue(false);
    mockEvaluateIntentFulfillment.mockResolvedValue({ score: 0.9, failed: false });
    mockUpdateRoleScoreWithIntent.mockReturnValue(0.85);
    mockGetLatestRoleScore.mockReturnValue({ taskId: "t1" });

    evaluateTaskCompletion("t1", "r1");
    await vi.runAllTimersAsync();

    expect(mockEvaluateIntentFulfillment).toHaveBeenCalledWith("t1", "r1");
  });

  it("eval result calls updateRoleScoreWithIntent with result fields", async () => {
    mockGetRole.mockReturnValue({ id: "r1", name: "Test", status: "active", cagPrompt: "" });
    mockRecordTaskScore.mockReturnValue(0.8);
    mockCheckProbationGraduation.mockReturnValue(false);
    mockCheckRetirement.mockReturnValue(false);
    mockEvaluateIntentFulfillment.mockResolvedValue({ score: 0.75, failed: false });
    mockUpdateRoleScoreWithIntent.mockReturnValue(0.82);
    mockGetLatestRoleScore.mockReturnValue({ taskId: "t1" });

    evaluateTaskCompletion("t1", "r1");
    await vi.runAllTimersAsync();

    expect(mockUpdateRoleScoreWithIntent).toHaveBeenCalledWith(
      "t1",
      0.75,
      false,
      expect.any(Function),
      0.3,
    );
  });

  it("getLatestRoleScore returns different taskId → async updateRole NOT called (out-of-order safety)", async () => {
    mockGetRole.mockReturnValue({ id: "r1", name: "Test", status: "active", cagPrompt: "" });
    mockRecordTaskScore.mockReturnValue(0.8);
    mockCheckProbationGraduation.mockReturnValue(false);
    mockCheckRetirement.mockReturnValue(false);
    mockEvaluateIntentFulfillment.mockResolvedValue({ score: 0.8, failed: false });
    mockUpdateRoleScoreWithIntent.mockReturnValue(0.82);
    // A newer task's row is now the latest — this task's eval should NOT update Role.performanceScore
    mockGetLatestRoleScore.mockReturnValue({ taskId: "t2" });

    evaluateTaskCompletion("t1", "r1");
    await vi.runAllTimersAsync();

    expect(mockUpdateRoleScoreWithIntent).toHaveBeenCalled(); // row was updated
    // The async path's updateRole is blocked by the out-of-order guard (latest row != this task)
    // The synchronous updateRole (line 64) still runs — only the ASYNC updateRole is blocked
    expect(mockUpdateRole).toHaveBeenCalledTimes(1);
    // Confirm the first (synchronous) call uses the initial emaScore, not the async newEma
    expect(mockUpdateRole).toHaveBeenCalledWith("r1", { performanceScore: 0.8 });
  });

  it("exception thrown inside .then() → evaluateTaskCompletion does NOT throw (swallowed)", async () => {
    mockGetRole.mockReturnValue({ id: "r1", name: "Test", status: "active", cagPrompt: "" });
    mockRecordTaskScore.mockReturnValue(0.8);
    mockCheckProbationGraduation.mockReturnValue(false);
    mockCheckRetirement.mockReturnValue(false);
    mockEvaluateIntentFulfillment.mockRejectedValue(new Error("eval error"));

    // Should not throw
    expect(() => evaluateTaskCompletion("t1", "r1")).not.toThrow();
  });
});
