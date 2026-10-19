/**
 * Tests for `verifyImportedConfig` in src/store/config-doc/import-verify.ts.
 *
 * The verifier is a deterministic, READ-ONLY check that runs AFTER
 * ChatManager has rebuilt a template + role set from a config-doc. It
 * compares the built entities against the doc's structural contract
 * (the parsed `PortableConfig`) and returns `{ok, mismatches[]}`.
 *
 * Pins (per Phase 2 plan §Task 8-tests):
 *  - template: step count, `dependsOn` edges, `outputAs` set, each step
 *    `roleId` === remapped new id and resolves
 *  - roles: each built role's portable fields match the expected
 *    projection (model, skills, effortTier, learnedRules, …; same
 *    role.* set as Task 1's drift guard, EXCLUDING `role.mcpServers`
 *    per D-011)
 *  - both: no residual `${...}` token remains in built template or
 *    roles (env placeholders are bound at import time)
 *  - corruption cases (each a distinct mismatch) name the exact
 *    step/edge/key/role-field in `mismatches[]`
 *
 * The function under test accepts the built entities as injected
 * arguments (so tests can use a freshly created template + roles
 * without going through adam-tools). It is read-only — never mutates.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { createRole, getRole } from "../../store/roles.js";
import { createTaskTemplate, getTaskTemplate } from "../../store/task-templates.js";
import { renderConfigDoc } from "../../store/config-doc/renderer.js";
import { parsePortableConfig } from "../../store/config-doc/parser.js";
import { verifyImportedConfig } from "../../store/config-doc/import-verify.js";
import type { Role, TaskStep, TaskTemplate } from "../../shared/types.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => cleanup());

let tmpExistingPath: string;

beforeEach(() => {
  clearTestDb();
  tmpExistingPath = mkdtempSync(join(tmpdir(), "adam-import-verify-"));
});

// ---------------------------------------------------------------------------
// Fixtures: small but realistic 2-role closure + 2-step template.
// The portable fields are populated so the verifier's role-field
// equality check has something to assert.
// ---------------------------------------------------------------------------

function makeRoleWorker(): Role {
  return {
    id: "role-w",
    name: "verify-worker",
    cagPrompt: "CAG-W: a worker that produces structured output.",
    learnedRules: { stylePreferences: ["代码质量优先"], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "mem-w",
    status: "active",
    preferences: { maxTurns: 25 },
    createdAt: 1700000000000,
    model: "claude-sonnet-4-6",
    effortTier: "high",
    skills: ["getnote", "synth-auto"],
    envVars: { MY_TOKEN: "value-not-secret" },
    additionalDirectories: [{ path: tmpExistingPath, mode: "rw" as const }],
  };
}

function makeRoleCoordinator(): Role {
  return {
    id: "role-c",
    name: "verify-coordinator",
    cagPrompt: "CAG-C: coordinates handoff.",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "mem-c",
    status: "active",
    preferences: {},
    createdAt: 1700000000000,
  };
}

function makeTemplate(workerId: string, coordId: string): TaskTemplate {
  const steps: TaskStep[] = [
    {
      id: "step-collect",
      prompt: "collect raw input",
      roleId: workerId,
      outputAs: "raw",
    },
    {
      id: "step-shape",
      prompt: "shape into deliverable",
      roleId: coordId,
      dependsOn: ["step-collect"],
      outputAs: "shaped",
    },
  ];
  return {
    id: "tpl-verify",
    name: "VerifyTemplate",
    trigger: { type: "manual" },
    steps,
    enabled: true,
    createdAt: 1700000000000,
    tags: ["verify"],
  };
}

/**
 * Simulate a faithful rebuild: create the template + roles with NEW ids
 * but with the same field content (the doc's portable values). Returns
 * the roleIdMap (source → new) for the verifier.
 *
 * If `skipInsertWhenPresent` is true (the happy-path identity-map case),
 * the function does NOT re-insert rows that already exist — the
 * caller pre-seeded them with the same ids.
 */
function rebuild(
  source: { template: TaskTemplate; roles: Role[]; portable: ReturnType<typeof parsePortableConfig> },
  options: { skipInsertWhenPresent?: boolean } = {},
): { newTemplateId: string; newRoleIds: string[]; roleIdMap: Record<string, string> } {
  const roleIdMap: Record<string, string> = {};
  const newRoleIds: string[] = [];
  for (const sourceRole of source.roles) {
    // Reuse the source id so getRole(sourceRole.id) resolves — the
    // verifier reads by id. In a real import path ChatManager mints
    // new ids; here we use the source ids so the assertions below
    // can pin the structural contract.
    if (!options.skipInsertWhenPresent || !getRole(sourceRole.id)) {
      createRole(sourceRole);
    }
    roleIdMap[sourceRole.id] = sourceRole.id;
    newRoleIds.push(sourceRole.id);
  }
  // Rebuild the template (it has the same id too; ChatManager would
  // generate a new one, but the verifier works on the doc's expected
  // step structure regardless of template id).
  if (!options.skipInsertWhenPresent || !getTaskTemplate(source.template.id)) {
    createTaskTemplate(source.template);
  }
  return {
    newTemplateId: source.template.id,
    newRoleIds,
    roleIdMap,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("verifyImportedConfig — happy path", () => {
  it("returns ok:true with no mismatches when built entities match the doc", () => {
    // Seed + render a doc from the source closure.
    const w = makeRoleWorker();
    const c = makeRoleCoordinator();
    createRole(w);
    createRole(c);
    const tpl = makeTemplate(w.id, c.id);
    createTaskTemplate(tpl);

    const docText = renderConfigDoc([tpl.id]);
    const portable = parsePortableConfig(docText);

    // Rebuild (re-create the same closure; id map is identity for this test).
    const { newTemplateId, newRoleIds, roleIdMap } = rebuild(
      { template: tpl, roles: [w, c], portable },
      { skipInsertWhenPresent: true },
    );

    const result = verifyImportedConfig({
      builtTemplateId: newTemplateId,
      builtRoleIds: newRoleIds,
      expected: portable,
      roleIdMap,
    });
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// autoSelectRole steps (PV-4 regression): a step with no fixed roleId (the
// runtime picks the role) must NOT be reported as dangling wiring. 1 prod
// template (PKOS全网新闻扫描导入) uses an autoselect step.
// ---------------------------------------------------------------------------

describe("verifyImportedConfig — autoSelectRole steps (PV-4 regression)", () => {
  function makeAutoselectTemplate(workerId: string): TaskTemplate {
    return {
      id: "tpl-autoselect",
      name: "AutoselectTemplate",
      trigger: { type: "manual" },
      enabled: true,
      createdAt: 1700000000000,
      steps: [
        { id: "step-fixed", prompt: "collect raw input", roleId: workerId, outputAs: "raw" },
        {
          id: "step-auto",
          prompt: "an auto-selected role shapes the deliverable",
          autoSelectRole: true,
          requirements: { tools: ["Read"] },
          dependsOn: ["step-fixed"],
          outputAs: "shaped",
        },
      ],
    };
  }

  it("does NOT false-positive an autoSelectRole step as dangling wiring", () => {
    const w = makeRoleWorker();
    createRole(w);
    const tpl = makeAutoselectTemplate(w.id);
    createTaskTemplate(tpl);

    const docText = renderConfigDoc([tpl.id]);
    const portable = parsePortableConfig(docText);
    const { newTemplateId, newRoleIds, roleIdMap } = rebuild(
      { template: tpl, roles: [w], portable },
      { skipInsertWhenPresent: true },
    );

    const result = verifyImportedConfig({
      builtTemplateId: newTemplateId,
      builtRoleIds: newRoleIds,
      expected: portable,
      roleIdMap,
    });
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it("flags an autoSelectRole step that was rebuilt as a fixed-role step", () => {
    const w = makeRoleWorker();
    createRole(w);
    // The DOC declares step-auto as autoselect …
    const tpl = makeAutoselectTemplate(w.id);
    createTaskTemplate(tpl);
    const docText = renderConfigDoc([tpl.id]);
    const portable = parsePortableConfig(docText);
    // … but the BUILT template (distinct id) wires step-auto to a fixed role instead.
    const builtTpl: TaskTemplate = {
      ...tpl,
      id: "tpl-autoselect-built",
      steps: [
        tpl.steps[0],
        { id: "step-auto", prompt: "an auto-selected role shapes the deliverable", roleId: w.id, dependsOn: ["step-fixed"], outputAs: "shaped" },
      ],
    };
    createTaskTemplate(builtTpl);

    const result = verifyImportedConfig({
      builtTemplateId: builtTpl.id,
      builtRoleIds: [w.id],
      expected: portable,
      roleIdMap: { [w.id]: w.id },
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => /autoSelectRole/.test(m.path) || /autoSelectRole/.test(m.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Template-structure corruption cases — each must name the exact failure
// ---------------------------------------------------------------------------

describe("verifyImportedConfig — fresh-namespace rename (name excluded)", () => {
  it("roles+template rebuilt under DIFFERENT names do NOT mismatch on name", () => {
    // roles.name is UNIQUE, so importing into a populated DB MUST rename.
    // verify must treat the rename as expected (name is not a fidelity field).
    const w = makeRoleWorker();
    const c = makeRoleCoordinator();
    createRole(w);
    createRole(c);
    const tpl = makeTemplate(w.id, c.id);
    createTaskTemplate(tpl);
    const docText = renderConfigDoc([tpl.id]);
    const portable = parsePortableConfig(docText);

    // Faithful rebuild EXCEPT new ids + new names (fresh namespace).
    const wNew: Role = { ...w, id: "role-w-e2e", name: "verify-worker [E2E]", memoryStreamId: "mem-w-e2e" };
    const cNew: Role = { ...c, id: "role-c-e2e", name: "verify-coordinator [E2E]", memoryStreamId: "mem-c-e2e" };
    createRole(wNew);
    createRole(cNew);
    const roleIdMap: Record<string, string> = { [w.id]: wNew.id, [c.id]: cNew.id };
    const builtTpl: TaskTemplate = {
      ...tpl,
      id: "tpl-verify-e2e",
      name: "VerifyTemplate [E2E]",
      steps: tpl.steps.map((s) => ({ ...s, roleId: s.roleId ? roleIdMap[s.roleId] : s.roleId })),
    };
    createTaskTemplate(builtTpl);

    const result = verifyImportedConfig({
      builtTemplateId: builtTpl.id,
      builtRoleIds: [wNew.id, cNew.id],
      expected: portable,
      roleIdMap,
    });
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
  });
});

describe("verifyImportedConfig — template structure mismatches", () => {
  it("step count mismatch names the missing step", () => {
    const w = makeRoleWorker();
    const c = makeRoleCoordinator();
    createRole(w);
    createRole(c);
    const tpl = makeTemplate(w.id, c.id);
    createTaskTemplate(tpl);
    const docText = renderConfigDoc([tpl.id]);
    const portable = parsePortableConfig(docText);

    // Create a TEMPLATE WITH ONE STEP MISSING — simulate a partial import.
    const broken: TaskTemplate = {
      ...tpl,
      steps: [tpl.steps[0]], // only step-collect, step-shape is missing
    };
    // Need to delete the old template first (UNIQUE id); sqlite uses INSERT OR IGNORE.
    getTestDb().prepare("DELETE FROM task_templates WHERE id = ?").run(broken.id);
    createTaskTemplate(broken);

    const result = verifyImportedConfig({
      builtTemplateId: tpl.id,
      builtRoleIds: [w.id, c.id],
      expected: portable,
      roleIdMap: { [w.id]: w.id, [c.id]: c.id },
    });
    expect(result.ok).toBe(false);
    const ids = result.mismatches.map((m) => m.message);
    expect(ids.some((m) => /step-shape/.test(m))).toBe(true);
    expect(ids.some((m) => /missing|step count|expected 2 steps/i.test(m))).toBe(true);
  });

  it("dependsOn edge mismatch names the affected step + the missing edge", () => {
    const w = makeRoleWorker();
    const c = makeRoleCoordinator();
    createRole(w);
    createRole(c);
    const tpl = makeTemplate(w.id, c.id);
    createTaskTemplate(tpl);
    const docText = renderConfigDoc([tpl.id]);
    const portable = parsePortableConfig(docText);

    // Drop the dependsOn edge on step-shape — should fail.
    const broken: TaskTemplate = {
      ...tpl,
      steps: tpl.steps.map((s) =>
        s.id === "step-shape" ? { ...s, dependsOn: [] } : s,
      ),
    };
    getTestDb().prepare("DELETE FROM task_templates WHERE id = ?").run(broken.id);
    createTaskTemplate(broken);

    const result = verifyImportedConfig({
      builtTemplateId: tpl.id,
      builtRoleIds: [w.id, c.id],
      expected: portable,
      roleIdMap: { [w.id]: w.id, [c.id]: c.id },
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) =>
      /step-shape/.test(m.message) && /dependsOn/.test(m.message),
    )).toBe(true);
  });

  it("outputAs mismatch names the step + the wrong value", () => {
    const w = makeRoleWorker();
    const c = makeRoleCoordinator();
    createRole(w);
    createRole(c);
    const tpl = makeTemplate(w.id, c.id);
    createTaskTemplate(tpl);
    const docText = renderConfigDoc([tpl.id]);
    const portable = parsePortableConfig(docText);

    // Corrupt outputAs on step-shape.
    const broken: TaskTemplate = {
      ...tpl,
      steps: tpl.steps.map((s) =>
        s.id === "step-shape" ? { ...s, outputAs: "WRONG" } : s,
      ),
    };
    getTestDb().prepare("DELETE FROM task_templates WHERE id = ?").run(broken.id);
    createTaskTemplate(broken);

    const result = verifyImportedConfig({
      builtTemplateId: tpl.id,
      builtRoleIds: [w.id, c.id],
      expected: portable,
      roleIdMap: { [w.id]: w.id, [c.id]: c.id },
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) =>
      /step-shape/.test(m.message) && /outputAs/.test(m.message) && /shaped/.test(m.message),
    )).toBe(true);
  });

  it("unmapped step roleId names the dangling step", () => {
    const w = makeRoleWorker();
    const c = makeRoleCoordinator();
    createRole(w);
    createRole(c);
    const tpl = makeTemplate(w.id, c.id);
    createTaskTemplate(tpl);
    const docText = renderConfigDoc([tpl.id]);
    const portable = parsePortableConfig(docText);

    // Build the roles with DIFFERENT ids (a real import mints new ids) and
    // pass a roleIdMap that does NOT include the step's source roleId.
    const builtRoleIds = [w.id, c.id];
    // roleIdMap intentionally drops the entry for role-w (simulating a
    // remap mistake).
    const result = verifyImportedConfig({
      builtTemplateId: tpl.id,
      builtRoleIds,
      expected: portable,
      roleIdMap: { [c.id]: c.id }, // w is unmapped
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) =>
      /step-collect/.test(m.message) && /roleId/.test(m.message) && /role-w/.test(m.message),
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Role-field corruption cases — must catch a create_role field drop
// ---------------------------------------------------------------------------

describe("verifyImportedConfig — role field mismatches", () => {
  it("built role missing a portable-inline field (effortTier) names the role + the field", () => {
    const w = makeRoleWorker();
    const c = makeRoleCoordinator();
    createRole(w);
    createRole(c);
    const tpl = makeTemplate(w.id, c.id);
    createTaskTemplate(tpl);
    const docText = renderConfigDoc([tpl.id]);
    const portable = parsePortableConfig(docText);

    // Simulate a field drop: rewrite the role without `effortTier`.
    // (model/envVars/additionalDirectories are env fields and bound at
    // import time; the verifier's residual-placeholder scan covers
    // those, not the equality check. effortTier is a portable-inline
    // field that round-trips verbatim — dropping it must fail the
    // equality check.)
    const broken: Role = { ...w };
    delete (broken as Partial<Role>).effortTier;
    getTestDb().prepare("DELETE FROM roles WHERE id = ?").run(broken.id);
    createRole(broken);

    const result = verifyImportedConfig({
      builtTemplateId: tpl.id,
      builtRoleIds: [w.id, c.id],
      expected: portable,
      roleIdMap: { [w.id]: w.id, [c.id]: c.id },
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) =>
      /role-w/.test(m.message) && /effortTier/.test(m.message),
    )).toBe(true);
  });

  it("built role missing `skills` names the role + the field", () => {
    const w = makeRoleWorker();
    const c = makeRoleCoordinator();
    createRole(w);
    createRole(c);
    const tpl = makeTemplate(w.id, c.id);
    createTaskTemplate(tpl);
    const docText = renderConfigDoc([tpl.id]);
    const portable = parsePortableConfig(docText);

    const broken: Role = { ...w };
    delete (broken as Partial<Role>).skills;
    getTestDb().prepare("DELETE FROM roles WHERE id = ?").run(broken.id);
    createRole(broken);

    const result = verifyImportedConfig({
      builtTemplateId: tpl.id,
      builtRoleIds: [w.id, c.id],
      expected: portable,
      roleIdMap: { [w.id]: w.id, [c.id]: c.id },
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) =>
      /role-w/.test(m.message) && /skills/.test(m.message),
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Residual-placeholder scan — must catch an unbound ${TOKEN} in a built role
// ---------------------------------------------------------------------------

describe("verifyImportedConfig — residual ${TOKEN} scan", () => {
  it("an unbound ${...} in a built role is named in mismatches", () => {
    const w = makeRoleWorker();
    const c = makeRoleCoordinator();
    createRole(w);
    createRole(c);
    const tpl = makeTemplate(w.id, c.id);
    createTaskTemplate(tpl);
    const docText = renderConfigDoc([tpl.id]);
    const portable = parsePortableConfig(docText);

    // Inject a residual ${LEAKED} into the built role's cagPrompt. This
    // simulates an import path that forgot to bind a placeholder.
    getTestDb().prepare(
      "UPDATE roles SET cag_prompt = ? WHERE id = ?",
    ).run("CAG-W with ${LEAKED} placeholder", w.id);

    const result = verifyImportedConfig({
      builtTemplateId: tpl.id,
      builtRoleIds: [w.id, c.id],
      expected: portable,
      roleIdMap: { [w.id]: w.id, [c.id]: c.id },
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) =>
      /LEAKED|unbound|residual|\\\$\\{/.test(m.message),
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Read-only contract — the verifier does not mutate built entities
// ---------------------------------------------------------------------------

describe("verifyImportedConfig — read-only", () => {
  it("does not mutate the built template or roles", () => {
    const w = makeRoleWorker();
    const c = makeRoleCoordinator();
    createRole(w);
    createRole(c);
    const tpl = makeTemplate(w.id, c.id);
    createTaskTemplate(tpl);
    const docText = renderConfigDoc([tpl.id]);
    const portable = parsePortableConfig(docText);

    const beforeRole = getRole(w.id);
    const beforeTpl = getTaskTemplate(tpl.id);

    verifyImportedConfig({
      builtTemplateId: tpl.id,
      builtRoleIds: [w.id, c.id],
      expected: portable,
      roleIdMap: { [w.id]: w.id, [c.id]: c.id },
    });

    const afterRole = getRole(w.id);
    const afterTpl = getTaskTemplate(tpl.id);
    expect(afterRole).toEqual(beforeRole);
    expect(afterTpl).toEqual(beforeTpl);
  });
});

// ---------------------------------------------------------------------------
// Module-location smoke
// ---------------------------------------------------------------------------

describe("import-verify module location", () => {
  it("verifyImportedConfig is exported from src/store/config-doc/import-verify.ts", async () => {
    const mod = await import("../../store/config-doc/import-verify.js");
    expect(typeof mod.verifyImportedConfig).toBe("function");
  });
});
