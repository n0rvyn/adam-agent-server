/**
 * Task 6-tests: Partial-execution fallback delivery — failing tests.
 *
 * Problem 3: "partial 时连兜底邮件也发不出"
 *
 * When a template execution finishes with status="partial" and the primary delivery
 * artifact (e.g., 定稿/定稿结果) is absent BUT alternate artifacts exist (e.g., 终稿-A
 * or 终稿-C from succeeded 润色 steps), the delivery path should invoke
 * tryAssembleFallbackDelivery instead of throwing PrimaryArtifactNotFoundError.
 *
 * Before Task 6-impl:
 *   isFailureReport = status === "failed" || status === "cancelled"
 *   So for status="partial", isFailureReport=false → fallback skipped → delivery throws.
 *
 * Expected: FAILS before Task 6-impl (delivery throws for partial status).
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import type { TaskTemplate, StepResult } from "../../shared/types.js";

const { cleanup } = setupTestDb();

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

// Mutable artifact store seeded per-test
const _artifactRows = vi.hoisted<Array<{
  id: string; sourceKind: "template_step"; executionId: string; stepId: string;
  key: string; kind: "file" | "json"; value?: unknown; blobPath?: string;
  mime?: string; sizeBytes: number; createdAt: number; roleId: string;
}>>(() => []);

let _testArtifactRows: typeof _artifactRows = [];

// Mutable stepResults seeded per-test
let _testStepResults = new Map<string, StepResult>();

// Captured fallback delivery calls (kept for potential future test use)
const _fallbackCalls = vi.hoisted<Array<{
  input: unknown; status: unknown; assembleFailureReport: unknown;
}>>(() => []);

afterAll(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn(() => ({ type: "sdk" as const, name: "test" })),
  tool: vi.fn(() => ({ name: "test" })),
}));

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn().mockImplementation(() => _testArtifactRows),
}));

vi.mock("../../lib/delivery-completeness.js", () => ({
  checkDeliveryCompleteness: vi.fn().mockReturnValue({
    complete: false,
    missingKeys: ["定稿结果"],
    gaps: [{ stepId: "润色B", key: "终稿-B", reason: "no_content" }],
  }),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readFileSync: vi.fn().mockReturnValue("FALLBACK_ARTIFACT_CONTENT_MARKER"),
  };
});

// Only mock PrimaryArtifactNotFoundError — tryAssembleFallbackDelivery uses the REAL function
vi.mock("../../scheduler/template-summary-assembler.js", async (importActual) => {
  const actual = await importActual() as Record<string, unknown>;
  return {
    ...actual,
    PrimaryArtifactNotFoundError: class PrimaryArtifactNotFoundError extends Error {
      constructor(public stepId: string, public key: string, public availableKeys: string[]) {
        super(`Primary artifact not found: stepId="${stepId}" key="${key}"`);
        this.name = "PrimaryArtifactNotFoundError";
      }
    },
    DeliveryNotImplementedError: class DeliveryNotImplementedError extends Error {
      constructor(_mode: string) {
        super(`Delivery mode not implemented`);
        this.name = "DeliveryNotImplementedError";
      }
    },
  };
});

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: vi.fn().mockReturnValue({
    send: vi.fn().mockResolvedValue(undefined),
    redeliverExecutionTo: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Test: partial status triggers fallback delivery dispatch
// ---------------------------------------------------------------------------

describe("partial-execution fallback delivery", () => {
  beforeEach(() => {
    clearTestDb();
    vi.clearAllMocks();
    _testArtifactRows = [];
    _testStepResults = new Map();
    _fallbackCalls.length = 0;
  });

  // -------------------------------------------------------------------------
  // Assertion: tryAssembleFallbackDelivery returns non-null for status=partial
  // when a fallback artifact is available.
  //
  // Before impl: this function IS called for "failed"/"cancelled" today (so the
  // fix only requires changing isFailureReport). It already works correctly for
  // partial — this test verifies the function itself is ready for partial status.
  // After impl: same function is called for partial status; result is non-null.
  //
  // NOTE: We cannot directly test deliverTemplateExecutionResult calling the
  // function for partial (vi.mock is per-module — the executor holds the original
  // reference). Test 2 verifies the full delivery path works without throwing.
  // -------------------------------------------------------------------------
  it("tryAssembleFallbackDelivery returns non-null for status=partial with available artifact", async () => {
    // Seed 终稿-A artifact (succeeded 润色-A) — the fallback candidate
    _testArtifactRows.push({
      id: "art-final-a", sourceKind: "template_step", executionId: "exec-partial-test",
      stepId: "润色A", key: "终稿-A", kind: "file",
      blobPath: "/tmp/终稿-A.md",
      mime: "text/markdown", sizeBytes: 42, createdAt: Date.now(), roleId: "role-podcast",
    });

    const fakeTemplate: TaskTemplate = {
      id: "tmpl-podcast",
      name: "Daily Podcast",
      config: {
        delivery: {
          mode: "primary-artifact" as const,
          primaryArtifact: { stepId: "润色A", key: "终稿-A" },
        },
      },
      steps: [{ id: "润色A", outputAs: "终稿-A" }],
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: Date.now(),
    } as TaskTemplate;

    const { tryAssembleFallbackDelivery } = await import("../../scheduler/template-summary-assembler.js");

    // The function should return non-null for partial when the primary artifact exists.
    // This proves the fallback machinery is ready to be called for partial status.
    // (The gate that decides WHEN to call it is isFailureReport in deliverTemplateExecutionResult.)
    const result = tryAssembleFallbackDelivery(
      { executionId: "exec-partial-test", template: fakeTemplate, stepResults: _testStepResults },
      "partial",
      (_status) => "## Partial Execution\n\n部分步骤未能完成。",
    );

    // Before impl: function returns non-null for partial (no gate in the function itself).
    // After impl: same. This test verifies the function is working.
    // Test 2 verifies the full delivery path.
    expect(result).not.toBeNull();
    expect(result!.summary).toContain("FALLBACK_ARTIFACT_CONTENT_MARKER");
  });

  // -------------------------------------------------------------------------
  // Assertion: delivery does NOT throw when primary artifact is absent for partial.
  // Before impl: isFailureReport=false → normal path taken → assembleSummary throws
  // After impl: isFailureReport=true → fallback called → no throw
  // -------------------------------------------------------------------------
  it("delivery does not throw for partial status when primary artifact is absent", async () => {
    const { TemplateExecutor } = await import("../../scheduler/template-executor.js");

    const fakeTemplate: TaskTemplate = {
      id: "tmpl-podcast",
      name: "Daily Podcast",
      config: {
        delivery: {
          mode: "primary-artifact" as const,
          primaryArtifact: { stepId: "定稿", key: "定稿结果" }, // absent — 润色B failed
        },
      },
      steps: [{ id: "定稿", outputAs: "定稿结果" }],
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: Date.now(),
    } as TaskTemplate;

    const executor = new TemplateExecutor({ maxRetries: 0, baseDelayMs: 10 });

    const context = {
      executionId: "exec-partial-test-no-artifact",
      templateId: fakeTemplate.id,
      templateName: "Daily Podcast",
      template: fakeTemplate,
      stepResults: _testStepResults,
      failedStepIds: new Set<string>(["润色B"]),
      rolePreference: "role-podcast",
      deliverTo: [{ type: "channel" as const, channelId: "wechat-test", sessionId: "sess-1" }],
      stepStatuses: {},
      continueOnError: false,
      goalSteps: [],
      config: { timeout: 30, approvalRequired: [], approvalTimeout: 60 },
    };

    // Before impl: this throws PrimaryArtifactNotFoundError (fallback not reached for partial)
    // After impl: fallback path reached → no throw (even if fallback returns null)
    await expect(executor.deliverTemplateExecutionResult(context, "partial")).resolves.not.toThrow();
  });
});
