import { describe, it, expect, vi } from "vitest";
import { extractRulesFromDeviation } from "../../agent/learner.js";
import type { DeviationReport } from "../../shared/types.js";

// Intercept the store/db.js import chain.
// From src/__tests__/agent/ → ../../store/ = src/store/
vi.mock("../../store/db.js", async () => {
  // From src/__tests__/agent/ → ../helpers/ = src/__tests__/helpers/
  const { setupTestDb } = await import("../helpers/test-db.js");
  const { db } = setupTestDb();
  return { getDb: () => db };
});

/**
 * Mirrors the private classification logic in learner.ts.
 * Used to assert that extractRulesFromDeviation's output is correctly classified.
 */
function classifyRulesForRoleSlots(rules: string[]): { stylePreferences: string[]; avoidedActions: string[] } {
  const stylePreferences: string[] = [];
  const avoidedActions: string[] = [];
  for (const rule of rules) {
    if (rule.startsWith("[-]")) {
      avoidedActions.push(rule);
    } else {
      // [+](positive), [~](added/modified) → stylePreferences
      stylePreferences.push(rule);
    }
  }
  return { stylePreferences, avoidedActions };
}

describe("agent/learner — extractRulesFromDeviation + classifyRulesForRoleSlots", () => {
  it("all-success report: rules land in stylePreferences, not avoidedActions", () => {
    const report: DeviationReport = {
      stepsPlanned: 3,
      stepsExecuted: 3,
      deviations: [],
      overallAccuracy: 1.0,
    };

    const rules = extractRulesFromDeviation("task-all-success", report);
    const classified = classifyRulesForRoleSlots(rules);

    expect(classified.stylePreferences.length).toBeGreaterThan(0);
    expect(classified.avoidedActions).toHaveLength(0);
    // Verify the rule has the [+]
    expect(classified.stylePreferences.every(r => r.startsWith("[+]"))).toBe(true);
  });

  it("skipped step: rule lands in avoidedActions", () => {
    const report: DeviationReport = {
      stepsPlanned: 2,
      stepsExecuted: 1,
      deviations: [
        {
          stepIndex: 1,
          planned: 'cp template.html',
          actual: "Not executed",
          deviationType: "skipped",
        },
      ],
      overallAccuracy: 0.5,
    };

    const rules = extractRulesFromDeviation("task-skipped", report);
    const classified = classifyRulesForRoleSlots(rules);

    expect(classified.avoidedActions.length).toBeGreaterThan(0);
    expect(classified.stylePreferences).toHaveLength(0);
    expect(classified.avoidedActions[0]).toContain("[-]");
    expect(classified.avoidedActions[0]).toContain("skipped");
  });

  it("modified step: rule lands in stylePreferences ([~] prefix)", () => {
    const report: DeviationReport = {
      stepsPlanned: 2,
      stepsExecuted: 2,
      deviations: [
        {
          stepIndex: 0,
          planned: "npm install",
          actual: "pnpm install",
          deviationType: "modified",
        },
      ],
      overallAccuracy: 1.0,
    };

    const rules = extractRulesFromDeviation("task-modified", report);
    const classified = classifyRulesForRoleSlots(rules);

    // isExecutionSuccessful fires (no failed/skipped), adding a [+]
    // The modified deviation adds a [~]
    expect(classified.stylePreferences.length).toBe(2);
    expect(classified.avoidedActions).toHaveLength(0);
    // First is [+], second is [~]
    expect(classified.stylePreferences[0]).toContain("[+]");
    expect(classified.stylePreferences[1]).toContain("[~]");
    expect(classified.stylePreferences[1]).toContain("modified");
  });

  it("failed step: rule lands in avoidedActions", () => {
    const report: DeviationReport = {
      stepsPlanned: 1,
      stepsExecuted: 1,
      deviations: [
        {
          stepIndex: 0,
          planned: "Write tests first",
          actual: "PERMISSION DENIED: Write",
          deviationType: "failed",
        },
      ],
      overallAccuracy: 0,
    };

    const rules = extractRulesFromDeviation("task-failed", report);
    const classified = classifyRulesForRoleSlots(rules);

    expect(classified.avoidedActions.length).toBeGreaterThan(0);
    expect(classified.stylePreferences).toHaveLength(0);
    expect(classified.avoidedActions[0]).toContain("[-]");
    expect(classified.avoidedActions[0]).toContain("failed");
  });

  it("mixed deviations: [~] → stylePreferences, [-] → avoidedActions, no [+] (skipped is critical)", () => {
    const report: DeviationReport = {
      stepsPlanned: 3,
      stepsExecuted: 3,
      deviations: [
        {
          stepIndex: 0,
          planned: "Step A",
          actual: "Step A",
          deviationType: "modified", // [+]-eligible (non-critical)
        },
        {
          stepIndex: 1,
          planned: "Step B",
          actual: "Skipped",
          deviationType: "skipped", // critical → isExecutionSuccessful = false
        },
      ],
      overallAccuracy: 1.0,
    };

    const rules = extractRulesFromDeviation("task-mixed", report);
    const classified = classifyRulesForRoleSlots(rules);

    // isExecutionSuccessful: skipped is a critical deviation → no [+] added
    // [~]: 1 (modified → stylePreferences)
    // [-]: 1 (skipped → avoidedActions)
    // [+]: 0 (suppressed by critical deviation)
    expect(classified.stylePreferences.filter(r => r.startsWith("[+]"))).toHaveLength(0);
    expect(classified.stylePreferences.filter(r => r.startsWith("[~]"))).toHaveLength(1);
    expect(classified.avoidedActions.filter(r => r.startsWith("[-]"))).toHaveLength(1);
  });
});
