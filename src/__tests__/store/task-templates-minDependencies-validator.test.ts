/**
 * Task 1b-tests: validateTemplateDefinition for minDependencies range checks.
 *
 * Tests:
 * (a) dependsOn=[A,B,C], minDependencies=2 → pass
 * (b) dependsOn=[A,B,C], minDependencies=0 → reject with "minDependencies"
 * (c) dependsOn=[A,B,C], minDependencies=4 → reject with "exceeds dependsOn length"
 *
 * Pre-impl: validator doesn't know about minDependencies → all three pass.
 */

import { afterAll, describe, expect, it, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { validateTemplateDefinition } from "../../store/task-templates.js";
import type { TaskTemplate } from "../../shared/types.js";

beforeEach(() => clearTestDb());
afterAll(() => cleanup());

function makeTemplate(steps: TaskTemplate["steps"]): Pick<TaskTemplate, "rolePreference" | "steps"> {
  return { rolePreference: "达芬奇", steps };
}

describe("validateTemplateDefinition — minDependencies range checks", () => {
  /**
   * (a) Valid: dependsOn=[A,B,C], minDependencies=2.
   * Should pass (no error thrown).
   * Pre-impl: passes (no validation for minDependencies exists yet).
   */
  it("(a) minDependencies=2 within range → passes validation", () => {
    const tmpl = makeTemplate([
      { id: "dep-A", prompt: "A" },
      { id: "dep-B", prompt: "B" },
      { id: "dep-C", prompt: "C" },
      {
        id: "step-X",
        prompt: "X",
        dependsOn: ["dep-A", "dep-B", "dep-C"],
        minDependencies: 2,
      },
    ]);
    expect(() => validateTemplateDefinition(tmpl)).not.toThrow();
  });

  /**
   * (b) Invalid: minDependencies=0 (must be >= 1).
   * Should throw with error message containing "minDependencies".
   * Pre-impl: no error thrown (field unknown to validator) → FAILS.
   */
  it("(b) minDependencies=0 → rejects with error mentioning minDependencies", () => {
    const tmpl = makeTemplate([
      { id: "dep-A", prompt: "A" },
      { id: "step-X", prompt: "X", dependsOn: ["dep-A"], minDependencies: 0 },
    ]);
    expect(() => validateTemplateDefinition(tmpl)).toThrow();
    expect(() => validateTemplateDefinition(tmpl)).toThrow(/minDependencies/i);
  });

  /**
   * (c) Invalid: minDependencies=4 > dependsOn.length=3.
   * Should throw with error containing "minDependencies" and "exceeds dependsOn length".
   * Pre-impl: no error thrown → FAILS.
   */
  it("(c) minDependencies=4 exceeds dependsOn length 3 → rejects with exceeds message", () => {
    const tmpl = makeTemplate([
      { id: "dep-A", prompt: "A" },
      { id: "dep-B", prompt: "B" },
      { id: "dep-C", prompt: "C" },
      {
        id: "step-X",
        prompt: "X",
        dependsOn: ["dep-A", "dep-B", "dep-C"],
        minDependencies: 4,
      },
    ]);
    expect(() => validateTemplateDefinition(tmpl)).toThrow();
    expect(() => validateTemplateDefinition(tmpl)).toThrow(/minDependencies/i);
    expect(() => validateTemplateDefinition(tmpl)).toThrow(/exceeds/i);
  });
});
