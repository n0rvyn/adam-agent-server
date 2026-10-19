import { describe, it, expect, vi } from "vitest";
import { extractRulesFromDeviation } from "../../agent/learner.js";
import type { DeviationReport } from "../../shared/types.js";

// extractRulesFromDeviation calls getTask() internally, so we mock the DB
vi.mock("../../store/db.js", async () => {
  const { setupTestDb } = await import("../helpers/test-db.js");
  const { db } = setupTestDb();
  return { getDb: () => db };
});

describe("agent/learner", () => {
  describe("extractRulesFromDeviation", () => {
    it("generates positive rule for successful execution", () => {
      const report: DeviationReport = {
        stepsPlanned: 3,
        stepsExecuted: 3,
        deviations: [],
        overallAccuracy: 1.0,
      };

      const rules = extractRulesFromDeviation("task-1", report);
      expect(rules.some(r => r.startsWith("[+]"))).toBe(true);
      expect(rules.some(r => r.includes("sourceTaskId:task-1"))).toBe(true);
    });

    it("generates negative rule for skipped steps", () => {
      const report: DeviationReport = {
        stepsPlanned: 2,
        stepsExecuted: 1,
        deviations: [
          { stepIndex: 1, planned: "Run tests", actual: "Not executed", deviationType: "skipped" },
        ],
        overallAccuracy: 0.5,
      };

      const rules = extractRulesFromDeviation("task-2", report);
      expect(rules.some(r => r.startsWith("[-]") && r.includes("skipped"))).toBe(true);
    });

    it("generates rule for failed steps", () => {
      const report: DeviationReport = {
        stepsPlanned: 1,
        stepsExecuted: 1,
        deviations: [
          { stepIndex: 0, planned: "Write file", actual: "PERMISSION DENIED: Write", deviationType: "failed" },
        ],
        overallAccuracy: 0,
      };

      const rules = extractRulesFromDeviation("task-3", report);
      expect(rules.some(r => r.startsWith("[-]") && r.includes("failed"))).toBe(true);
    });

    it("generates rule for added (unplanned) steps", () => {
      const report: DeviationReport = {
        stepsPlanned: 1,
        stepsExecuted: 2,
        deviations: [
          { stepIndex: -1, planned: "", actual: "Grep: searched codebase", deviationType: "added" },
        ],
        overallAccuracy: 1.0,
      };

      const rules = extractRulesFromDeviation("task-4", report);
      expect(rules.some(r => r.startsWith("[~]") && r.includes("Unplanned"))).toBe(true);
    });
  });
});
