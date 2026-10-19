import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { validateTemplateRoleConfig, TemplateRoleConfigError } from "../../store/task-templates.js";
import { createRole } from "../../store/roles.js";
import type { TaskTemplate, Role } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function makeRole(overrides: Partial<Role> = {}): Role {
  const suffix = Math.random().toString(36).slice(2);
  return {
    id: `role-${suffix}`,
    name: `Template Test Role ${suffix}`,
    cagPrompt: "Test prompt",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `mem-${suffix}`,
    status: "active",
    preferences: {},
    createdAt: Date.now(),
    ...overrides,
  };
}

function tmpl(overrides: Partial<Pick<TaskTemplate, "rolePreference" | "steps">>): Pick<TaskTemplate, "rolePreference" | "steps"> {
  return {
    rolePreference: undefined,
    steps: [],
    ...overrides,
  };
}

describe("validateTemplateRoleConfig", () => {
  it("passes when template.rolePreference is set (no per-step role needed)", () => {
    expect(() =>
      validateTemplateRoleConfig(
        tmpl({
          rolePreference: "role-x",
          steps: [{ id: "s1", prompt: "do" }],
        }),
      ),
    ).not.toThrow();
  });

  it("passes when every step has roleId", () => {
    const roleA = makeRole({ id: "role-a" });
    const roleB = makeRole({ id: "role-b" });
    createRole(roleA);
    createRole(roleB);

    expect(() =>
      validateTemplateRoleConfig(
        tmpl({
          steps: [
            { id: "s1", prompt: "a", roleId: "role-a" },
            { id: "s2", prompt: "b", roleId: "role-b" },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("passes when every step has autoSelectRole=true", () => {
    expect(() =>
      validateTemplateRoleConfig(
        tmpl({
          steps: [
            { id: "s1", prompt: "a", autoSelectRole: true, requirements: {} },
            { id: "s2", prompt: "b", autoSelectRole: true, requirements: {} },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("passes mixed: step1 has roleId + step2 has autoSelectRole + no rolePreference", () => {
    createRole(makeRole({ id: "role-a" }));

    expect(() =>
      validateTemplateRoleConfig(
        tmpl({
          steps: [
            { id: "s1", prompt: "a", roleId: "role-a" },
            { id: "s2", prompt: "b", autoSelectRole: true, requirements: {} },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("fails when a step has neither roleId nor autoSelectRole AND no rolePreference", () => {
    createRole(makeRole({ id: "role-a" }));

    try {
      validateTemplateRoleConfig(
        tmpl({
          steps: [
            { id: "s1", prompt: "a", roleId: "role-a" },
            { id: "s2", prompt: "b" }, // bad
            { id: "s3", prompt: "c" }, // bad
          ],
        }),
      );
      expect.fail("Expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateRoleConfigError);
      expect((err as TemplateRoleConfigError).code).toBe("TEMPLATE_INVALID_ROLE_CONFIG");
      expect((err as TemplateRoleConfigError).failingStepIds).toEqual(["s2", "s3"]);
    }
  });

  it("passes empty steps array when rolePreference is set (edge case)", () => {
    expect(() =>
      validateTemplateRoleConfig(tmpl({ rolePreference: "role-x", steps: [] })),
    ).not.toThrow();
  });

  it("passes empty steps array when no rolePreference (nothing to fail on)", () => {
    // Vacuously true: forall steps, predicate holds when steps is empty
    expect(() => validateTemplateRoleConfig(tmpl({ steps: [] }))).not.toThrow();
  });

  it("rejects roleId as empty string (treated as missing)", () => {
    try {
      validateTemplateRoleConfig(
        tmpl({ steps: [{ id: "s1", prompt: "a", roleId: "" }] }),
      );
      expect.fail("Expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateRoleConfigError);
      expect((err as TemplateRoleConfigError).failingStepIds).toEqual(["s1"]);
    }
  });

  it("rejects autoSelectRole=false as missing", () => {
    try {
      validateTemplateRoleConfig(
        tmpl({ steps: [{ id: "s1", prompt: "a", autoSelectRole: false }] }),
      );
      expect.fail("Expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateRoleConfigError);
      expect((err as TemplateRoleConfigError).failingStepIds).toEqual(["s1"]);
    }
  });

  it("rejects autoSelectRole=true when requirements are omitted", () => {
    try {
      validateTemplateRoleConfig(
        tmpl({ steps: [{ id: "s1", prompt: "a", autoSelectRole: true }] }),
      );
      expect.fail("Expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateRoleConfigError);
      expect((err as TemplateRoleConfigError).code).toBe("STEP_AUTOSELECT_NEEDS_REQUIREMENTS");
      expect((err as TemplateRoleConfigError).failingStepIds).toEqual(["s1"]);
    }
  });

  it("allows autoSelectRole=true when requirements is an empty object", () => {
    expect(() =>
      validateTemplateRoleConfig(
        tmpl({ steps: [{ id: "s1", prompt: "a", autoSelectRole: true, requirements: {} }] }),
      ),
    ).not.toThrow();
  });

  it("rejects an explicit roleId that does not resolve to an active role", () => {
    try {
      validateTemplateRoleConfig(
        tmpl({ steps: [{ id: "s1", prompt: "a", roleId: "missing-role" }] }),
      );
      expect.fail("Expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateRoleConfigError);
      expect((err as TemplateRoleConfigError).code).toBe("STEP_ROLE_NOT_FOUND");
      expect((err as TemplateRoleConfigError).failingStepIds).toEqual(["s1"]);
    }
  });

  it("rejects a retired explicit roleId", () => {
    createRole(makeRole({ id: "role-retired", status: "retired" }));

    try {
      validateTemplateRoleConfig(
        tmpl({ steps: [{ id: "s1", prompt: "a", roleId: "role-retired" }] }),
      );
      expect.fail("Expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateRoleConfigError);
      expect((err as TemplateRoleConfigError).code).toBe("STEP_ROLE_NOT_FOUND");
      expect((err as TemplateRoleConfigError).failingStepIds).toEqual(["s1"]);
    }
  });

  it("returns the first detected failure category in step order", () => {
    createRole(makeRole({ id: "role-valid" }));

    try {
      validateTemplateRoleConfig(
        tmpl({
          rolePreference: "role-valid",
          steps: [
            { id: "s1", prompt: "a", autoSelectRole: true },
            { id: "s2", prompt: "b", roleId: "missing-role" },
            { id: "s3", prompt: "c", autoSelectRole: true },
          ],
        }),
      );
      expect.fail("Expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateRoleConfigError);
      expect((err as TemplateRoleConfigError).code).toBe("STEP_AUTOSELECT_NEEDS_REQUIREMENTS");
      expect((err as TemplateRoleConfigError).failingStepIds).toEqual(["s1", "s3"]);
    }
  });
});
