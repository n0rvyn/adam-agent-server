/**
 * Task 7-tests: Delivery layer never emits an internal sentinel to the user.
 *
 * Guard location (Task 1): template-summary-assembler.ts:231 — the
 * `content = result.result ?? result.error ?? "No output"` assignment in the
 * concat-step-results loop.
 *
 * PRE-IMPL (FAILS): No sentinel guard exists; sentinel flows straight into content.
 * POST-IMPL (PASSES): isInternalSentinel check drops/replaces the sentinel.
 *
 * Contract:
 * - A step result whose `result` field is the internal sentinel must NOT appear
 *   in the assembled delivery string.
 * - A legitimate step result MUST appear in the assembled delivery string
 *   (regression — must not drop real content).
 * - A proper "task failed" user-facing message may still appear.
 */

import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { setupTestDb, clearTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// ---------------------------------------------------------------------------
// Minimal mocks — assembleSummary calls checkDeliveryCompleteness and
// listArtifactsByExecution; stub both so the test is unit-scoped.
// ---------------------------------------------------------------------------

vi.mock("../../store/db.js", () => ({
  getDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn(() => []),
}));

vi.mock("../../store/template-executions.js", () => ({
  getTemplateExecution: vi.fn(() => undefined),
}));

vi.mock("../../store/task-templates.js", () => ({
  getTaskTemplate: vi.fn(() => undefined),
}));

vi.mock("../../lib/delivery-completeness.js", () => ({
  checkDeliveryCompleteness: vi.fn(() => ({ gaps: [], isComplete: true })),
}));

afterAll(() => {
  cleanup();
});

beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTemplate(mode: "concat-step-results" | "primary-artifact" = "concat-step-results") {
  return {
    id: "tpl-sentinel-guard",
    name: "Sentinel Guard Test Template",
    config: {
      delivery: { mode },
    },
  } as import("../../shared/types.js").TaskTemplate;
}

function makeInput(
  stepResults: Map<string, import("../../shared/types.js").StepResult>,
  mode: "concat-step-results" | "primary-artifact" = "concat-step-results",
) {
  return {
    executionId: "exec-sentinel-guard",
    template: makeTemplate(mode),
    stepResults,
  };
}

// The deliverable sentinel string (must match INACTIVITY_SENTINEL in resolve-contract-rules.ts)
const SENTINEL = "ExecutionManager: SDK loop force-closed after activity timeout";

// ---------------------------------------------------------------------------
// Test 1: sentinel in step result → NOT emitted in delivery (FAILS pre-impl)
// ---------------------------------------------------------------------------
describe("Task 7: delivery sentinel guard", () => {
  it("(1) sentinel as step result is NOT emitted to the channel (FAILS pre-impl)", async () => {
    const { assembleSummary } = await import("../../scheduler/template-summary-assembler.js");

    const stepResults = new Map<string, import("../../shared/types.js").StepResult>();
    stepResults.set("采集", {
      status: "completed",
      result: SENTINEL,
      roleName: "采集角色",
      stepId: "step-采集",
      taskId: "task-sentinel-1",
    });

    const summary = assembleSummary(makeInput(stepResults));

    // The raw sentinel must NOT appear in the delivered string.
    // PRE-IMPL: this assertion FAILS because the sentinel is inserted verbatim at line 231.
    expect(summary).not.toContain(SENTINEL);
  });

  // ---------------------------------------------------------------------------
  // Test 2: legitimate result delivers unchanged (regression)
  // ---------------------------------------------------------------------------
  it("(2) legitimate step result is delivered unchanged (regression)", async () => {
    const { assembleSummary } = await import("../../scheduler/template-summary-assembler.js");

    const realContent = "今日精选内容：比特币突破十万美元大关，全球科技股普涨。";
    const stepResults = new Map<string, import("../../shared/types.js").StepResult>();
    stepResults.set("采集", {
      status: "completed",
      result: realContent,
      roleName: "采集角色",
      stepId: "step-采集",
      taskId: "task-sentinel-2",
    });

    const summary = assembleSummary(makeInput(stepResults));

    expect(summary).toContain(realContent);
  });

  // ---------------------------------------------------------------------------
  // Test 3: sentinel as step error → NOT emitted to the channel (defense in depth)
  // ---------------------------------------------------------------------------
  it("(3) sentinel as step error field is NOT emitted to the channel", async () => {
    const { assembleSummary } = await import("../../scheduler/template-summary-assembler.js");

    const stepResults = new Map<string, import("../../shared/types.js").StepResult>();
    stepResults.set("采集", {
      status: "failed",
      result: undefined,
      error: SENTINEL,
      roleName: "采集角色",
      stepId: "step-采集",
      taskId: "task-sentinel-3",
    });

    const summary = assembleSummary(makeInput(stepResults));

    expect(summary).not.toContain(SENTINEL);
  });

  // ---------------------------------------------------------------------------
  // Test 4: legitimate error message delivers unchanged (regression)
  // ---------------------------------------------------------------------------
  it("(4) legitimate error message delivers unchanged (regression)", async () => {
    const { assembleSummary } = await import("../../scheduler/template-summary-assembler.js");

    const realError = "Task failed: API rate limit exceeded after 3 retries";
    const stepResults = new Map<string, import("../../shared/types.js").StepResult>();
    stepResults.set("采集", {
      status: "failed",
      result: undefined,
      error: realError,
      roleName: "采集角色",
      stepId: "step-采集",
      taskId: "task-sentinel-4",
    });

    const summary = assembleSummary(makeInput(stepResults));

    expect(summary).toContain(realError);
  });
});
