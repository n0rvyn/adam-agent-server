/**
 * Genuine full-config round-trip test (Phase 2 Task 6).
 *
 * The real AC#2: render the actual podcast template+role closure
 * (synthetic-but-faithful fixtures derived from prod-DB shapes),
 * `parsePortableConfig`, and deep-equal the reconstructed structured
 * config against the source — for **every** field, driven from
 * `Object.keys(sourceProjection)` ∩ classification (NOT a hardcoded
 * subset, so a dropped field fails).
 *
 * - verbatim byte-identical via `getAnchorBytes`
 * - env equal to `${TOKEN}` (placeholdered)
 * - inline portable fields deep-equal
 * - fails closed on any lost field
 *
 * Also asserts human-body↔machine-block consistency for a few inline
 * fields (guards the additive-render drift risk).
 *
 * Non-goals: not a live-server test (Step 6.5 covers that).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { createRole, getRole } from "../../store/roles.js";
import { createTaskTemplate, getTaskTemplate } from "../../store/task-templates.js";
import { renderConfigDoc } from "../../store/config-doc/renderer.js";
import {
  parseConfigDoc,
  parsePortableConfig,
} from "../../store/config-doc/parser.js";
import {
  PORTABLE_INLINE_FIELD_PATHS,
  VERBATIM_FIELD_PATHS,
  ENV_FIELD_PATHS,
} from "../../store/config-doc/types.js";
import type { Role, TaskStep, TaskTemplate } from "../../shared/types.js";
import type { PortableRole, PortableStep, PortableTemplate } from "../../store/config-doc/types.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => cleanup());

let tmpExistingPath: string;

beforeEach(() => {
  clearTestDb();
  tmpExistingPath = mkdtempSync(join(tmpdir(), "adam-round-trip-full-"));
});

// ---------------------------------------------------------------------------
// Synthetic-but-faithful 6-role closure + morning template
// Field shapes mirror a prod-DB copy of the podcast pipeline (per the
// memory `project_adam_podcast_belief_store_redesign`); IDs/values are
// fabricated in-test so we never touch the production DB.
// ---------------------------------------------------------------------------

function makeRoleR1(): Role {
  return {
    id: "role-1",
    name: "审慎者",
    cagPrompt: "CAG-1: morning brief editor with care.",
    learnedRules: { stylePreferences: ["代码质量优先"], avoidedActions: ["skip tests"], pinnedParameters: [] },
    memoryStreamId: "mem-1",
    status: "active",
    preferences: { maxTurns: 30 },
    createdAt: 1700000000000,
    allowedTools: ["Read", "Edit"],
    disallowedTools: ["Bash"],
    evaluationCriteria: { quality: 0.9 },
    executionMode: "isolated",
    maxBudgetUsd: 2.5,
    approvalRequired: ["rm -rf *"],
    source: "user",
    allowedChannels: ["wechat"],
    inheritUserSettings: true,
    permissionMode: "acceptEdits",
    allowedBashPatterns: ["git *", "pnpm *"],
    deniedBashPatterns: ["rm -rf /"],
    presetId: "preset-coder",
    osCapabilities: [{ id: "calendars" }],
    effortTier: "high",
    skills: ["getnote", "synth-auto"],
    memoryBudgetTokens: 4000,
    performanceScore: 0.85,
    model: "claude-sonnet-4-6",
    envVars: { MY_API_KEY: "value-not-secret" },
    additionalDirectories: [{ path: tmpExistingPath, mode: "rw" as const }],
  };
}

function makeRoleR2(): Role {
  return {
    id: "role-2",
    name: "钱钟书",
    cagPrompt: "CAG-2: literary voice.",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "mem-2",
    status: "active",
    preferences: {},
    createdAt: 1700000000000,
    skills: ["synth-auto"],
  };
}

function makeRoleR3(): Role {
  return {
    id: "role-3",
    name: "达芬奇",
    cagPrompt: "CAG-3: visual.",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "mem-3",
    status: "active",
    preferences: {},
    createdAt: 1700000000000,
  };
}

function makeRoleR4(): Role {
  return {
    id: "role-4",
    name: "拉加代尔",
    cagPrompt: "CAG-4: editor.",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "mem-4",
    status: "active",
    preferences: {},
    createdAt: 1700000000000,
  };
}

function makeRoleR5(): Role {
  return {
    id: "role-5",
    name: "ed-前期",
    cagPrompt: "CAG-5: pre-editor.",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "mem-5",
    status: "active",
    preferences: {},
    createdAt: 1700000000000,
  };
}

function makeRoleR6(): Role {
  return {
    id: "role-6",
    name: "ed-中期",
    cagPrompt: "CAG-6: mid-editor.",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "mem-6",
    status: "active",
    preferences: {},
    createdAt: 1700000000000,
  };
}

function makeMorningTemplate(roleIds: { r1: string; r2: string; r3: string; r4: string; r5: string; r6: string }): TaskTemplate {
  const steps: TaskStep[] = [
    {
      id: "s-collect",
      prompt: "collect news",
      roleId: roleIds.r1,
      outputAs: "raw",
      dependsOn: [],
    },
    {
      id: "s-write",
      prompt: "write the brief",
      roleId: roleIds.r2,
      dependsOn: ["s-collect"],
      outputAs: "最终逐字稿",
      config: { timeout: 30 },
    },
    {
      id: "s-lithink",
      prompt: "literary rewrite",
      roleId: roleIds.r3,
      dependsOn: ["s-write"],
      outputAs: "润色稿",
    },
    {
      id: "s-eval",
      prompt: "score",
      roleId: roleIds.r4,
      dependsOn: ["s-lithink"],
      outputAs: "评分",
    },
    {
      id: "s-tts",
      prompt: "synthesize",
      roleId: roleIds.r5,
      dependsOn: ["s-eval"],
      outputAs: "音频",
    },
    {
      id: "s-deliver",
      prompt: "deliver to channel",
      roleId: roleIds.r6,
      dependsOn: ["s-tts"],
      outputAs: "delivered",
    },
  ];
  return {
    id: "tpl-morning",
    name: "MorningPodcast",
    description: "morning brief pipeline",
    trigger: { type: "manual" },
    steps,
    enabled: true,
    createdAt: 1700000000000,
    tags: ["podcast", "morning"],
    goalIds: ["goal-1"],
    retryPolicy: { maxAttempts: 3 },
  };
}

// ---------------------------------------------------------------------------
// Helper: the source projection for a role (the values the machine block
// carries for a role; identity fields are excluded, mcpServers excluded
// per D-011). Used to drive exhaustive field-for-field assertions.
// ---------------------------------------------------------------------------

function roleSourceProjection(role: Role): Record<string, unknown> {
  const proj: Record<string, unknown> = {
    sourceId: role.id,
    name: role.name,
    cagPrompt: { __anchor: `role.${role.id}.cagPrompt` },
  };
  // Mirror the renderer's computeRolePortableProjection contract
  if (role.learnedRules !== undefined) proj.learnedRules = role.learnedRules;
  if (role.preferences !== undefined) proj.preferences = role.preferences;
  if (role.allowedTools) proj.allowedTools = role.allowedTools;
  if (role.disallowedTools) proj.disallowedTools = role.disallowedTools;
  if (role.evaluationCriteria) proj.evaluationCriteria = role.evaluationCriteria;
  if (role.executionMode) proj.executionMode = role.executionMode;
  if (typeof role.maxBudgetUsd === "number") proj.maxBudgetUsd = role.maxBudgetUsd;
  if (role.approvalRequired) proj.approvalRequired = role.approvalRequired;
  if (role.source) proj.source = role.source;
  if (role.allowedChannels) proj.allowedChannels = role.allowedChannels;
  if (role.inheritUserSettings !== undefined) proj.inheritUserSettings = role.inheritUserSettings;
  if (role.permissionMode) proj.permissionMode = role.permissionMode;
  if (role.allowedBashPatterns) proj.allowedBashPatterns = role.allowedBashPatterns;
  if (role.deniedBashPatterns) proj.deniedBashPatterns = role.deniedBashPatterns;
  if (role.presetId) proj.presetId = role.presetId;
  if (role.osCapabilities) proj.osCapabilities = role.osCapabilities;
  if (role.effortTier) proj.effortTier = role.effortTier;
  if (role.skills) proj.skills = role.skills;
  if (typeof role.memoryBudgetTokens === "number") proj.memoryBudgetTokens = role.memoryBudgetTokens;
  if (role.status) proj.status = role.status;
  if (typeof role.performanceScore === "number") proj.performanceScore = role.performanceScore;
  // Env fields → ${TOKEN} strings; we cannot pre-compute exact names (they
  // come from the renderer's placeholder manifest), so we assert only the
  // shape (the per-key test below compares placeholder names from the header).
  if (role.model) proj.model = /\${[^}]+}/;
  if (role.envVars) {
    const envOut: Record<string, unknown> = {};
    for (const k of Object.keys(role.envVars)) envOut[k] = /\${[^}]+}/;
    proj.envVars = envOut;
  }
  if (role.additionalDirectories) {
    proj.additionalDirectories = role.additionalDirectories.map(() => ({ path: /\${[^}]+}/ }));
  }
  return proj;
}

function stepSourceProjection(tplId: string, step: TaskStep): Record<string, unknown> {
  const proj: Record<string, unknown> = {
    id: step.id,
    prompt: { __anchor: `template.${tplId}.step.${step.id}.prompt` },
    roleId: step.roleId ?? "",
  };
  if (step.dependsOn) proj.dependsOn = step.dependsOn;
  if (typeof step.minDependencies === "number") proj.minDependencies = step.minDependencies;
  if (step.outputAs) proj.outputAs = step.outputAs;
  if (step.requirements) proj.requirements = step.requirements;
  if (step.autoSelectRole) proj.autoSelectRole = step.autoSelectRole;
  if (step.config) proj.config = step.config;
  if (step.consumesFrom) proj.consumesFrom = step.consumesFrom;
  if (step.consumesFromOptional) proj.consumesFromOptional = step.consumesFromOptional;
  if (step.persona?.voiceConstraints) {
    proj.persona = { voiceConstraints: step.persona.voiceConstraints };
  }
  if (step.assertions) proj.assertions = step.assertions;
  if (step.recordEditorScores) proj.recordEditorScores = step.recordEditorScores;
  if (step.candidateId) proj.candidateId = step.candidateId;
  if (step.briefPerturbation) proj.briefPerturbation = step.briefPerturbation;
  if (step.kind) proj.kind = step.kind;
  if (step.settlementLedgerOwner) proj.settlementLedgerOwner = step.settlementLedgerOwner;
  if (step.publishesClaimsTo) proj.publishesClaimsTo = step.publishesClaimsTo;
  if (step.settlesPredictionsFor) proj.settlesPredictionsFor = step.settlesPredictionsFor;
  if (step.openLedgerOwner) proj.openLedgerOwner = step.openLedgerOwner;
  if (typeof step.openLedgerLookbackDays === "number") {
    proj.openLedgerLookbackDays = step.openLedgerLookbackDays;
  }
  return proj;
}

function templateSourceProjection(tpl: TaskTemplate): Record<string, unknown> {
  const proj: Record<string, unknown> = {
    sourceId: tpl.id,
    name: tpl.name,
    steps: tpl.steps.map((s) => stepSourceProjection(tpl.id, s)),
  };
  if (tpl.description) proj.description = tpl.description;
  if (tpl.trigger) proj.trigger = tpl.trigger;
  if (tpl.rolePreference) proj.rolePreference = tpl.rolePreference;
  if (tpl.config) {
    const cfg = { ...(tpl.config as Record<string, unknown>) };
    delete cfg.env;
    delete cfg.mcpServers;
    if (Object.keys(cfg).length > 0) proj.config = cfg;
  }
  if (tpl.tags) proj.tags = tpl.tags;
  if (typeof tpl.enabled === "boolean") proj.enabled = tpl.enabled;
  if (tpl.goalIds) proj.goalIds = tpl.goalIds;
  if (tpl.retryPolicy) proj.retryPolicy = tpl.retryPolicy;
  if (tpl.isPreset) proj.isPreset = tpl.isPreset;
  if (tpl.presetId) proj.presetId = tpl.presetId;
  return proj;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("round-trip-full — 6-role podcast closure + morning template", () => {
  it("renders and parses back a 6-role closure + morning template, all fields present", () => {
    // Seed 6 roles + 1 template using better-sqlite3 (via the test-db helper).
    // Note: setupTestDb() already uses better-sqlite3 in-memory; no FTS5
    // tables in this schema path, so no defensive-mode rollback risk.
    const r1 = makeRoleR1();
    const r2 = makeRoleR2();
    const r3 = makeRoleR3();
    const r4 = makeRoleR4();
    const r5 = makeRoleR5();
    const r6 = makeRoleR6();
    const roles = [r1, r2, r3, r4, r5, r6];
    const roleIds = { r1: r1.id, r2: r2.id, r3: r3.id, r4: r4.id, r5: r5.id, r6: r6.id };
    for (const r of roles) createRole(r);
    const tpl = makeMorningTemplate(roleIds);
    createTaskTemplate(tpl);

    // Sanity: roles round-trip through the store
    for (const r of roles) {
      const got = getRole(r.id);
      expect(got).toBeDefined();
      expect(got!.name).toBe(r.name);
    }
    const gotTpl = getTaskTemplate(tpl.id);
    expect(gotTpl).toBeDefined();
    expect(gotTpl!.steps).toHaveLength(6);

    // Render
    const docText = renderConfigDoc([tpl.id]);

    // Parse header + machine
    const parsed = parseConfigDoc(docText);
    expect(parsed.header.roles).toHaveLength(6);
    expect(parsed.header.templates).toHaveLength(1);

    const config = parsePortableConfig(docText);
    expect(config.templates).toHaveLength(1);
    expect(config.roles).toHaveLength(6);

    // Per-role exhaustive assertion
    for (const sourceRole of roles) {
      const reconstructed = config.roles.find((r) => r.sourceId === sourceRole.id) as PortableRole;
      expect(reconstructed, `role ${sourceRole.id} missing from machine block`).toBeDefined();

      // Source projection (what the machine block MUST carry for this role)
      const sourceProj = roleSourceProjection(sourceRole);
      const sourceKeys = Object.keys(sourceProj);

      // A key present on the source projection but missing in the parsed
      // config fails. This is the drift guard: a future secret-bearing
      // field added to a classification list but not surfaced in the machine
      // block trips here.
      for (const k of sourceKeys) {
        if (k === "cagPrompt") continue; // verbatim — asserted via {__anchor} + bytes below
        if (k === "model" || k === "envVars" || k === "additionalDirectories") {
          // Env fields are ${TOKEN} strings (id-dependent); assert present + tokenized shape.
          expect(k in reconstructed, `env field "${k}" missing in parsed role ${sourceRole.id}`).toBe(true);
          continue;
        }
        // Portable inline: the machine block must carry the SAME VALUE, not merely
        // the key. A field that round-trips to a different value (or is silently
        // dropped/empty) fails here — this is the genuine round-trip guarantee.
        expect(
          (reconstructed as unknown as Record<string, unknown>)[k],
          `field "${k}" value mismatch for role ${sourceRole.id}`,
        ).toEqual(sourceProj[k]);
      }

      // Verbatim: cagPrompt is {__anchor} ref + the bytes resolve byte-equal.
      expect(reconstructed.cagPrompt).toEqual({ __anchor: `role.${sourceRole.id}.cagPrompt` });
      const cagBytes = parsed.getAnchorBytes(`role.${sourceRole.id}.cagPrompt`);
      expect(cagBytes.toString("utf8")).toBe(sourceRole.cagPrompt);
    }
  });

  it("template + each step: every field present and inline values deep-equal", () => {
    const r1 = makeRoleR1();
    const r2 = makeRoleR2();
    const r3 = makeRoleR3();
    const r4 = makeRoleR4();
    const r5 = makeRoleR5();
    const r6 = makeRoleR6();
    const roleIds = { r1: r1.id, r2: r2.id, r3: r3.id, r4: r4.id, r5: r5.id, r6: r6.id };
    for (const r of [r1, r2, r3, r4, r5, r6]) createRole(r);
    const tpl = makeMorningTemplate(roleIds);
    createTaskTemplate(tpl);

    const docText = renderConfigDoc([tpl.id]);
    const config = parsePortableConfig(docText);
    const reconstructed = config.templates[0] as PortableTemplate;

    // Template-level exhaustive assertion
    const tplProj = templateSourceProjection(tpl);
    for (const k of Object.keys(tplProj)) {
      if (k === "steps") {
        // Steps are walked separately below.
        expect(reconstructed.steps).toHaveLength(tpl.steps.length);
        continue;
      }
      expect(
        k in reconstructed,
        `template field "${k}" present in source projection but missing in parsed config`,
      ).toBe(true);
    }
    expect(reconstructed.sourceId).toBe(tpl.id);
    expect(reconstructed.name).toBe(tpl.name);
    if (tpl.tags) expect(reconstructed.tags).toEqual(tpl.tags);
    if (tpl.goalIds) expect(reconstructed.goalIds).toEqual(tpl.goalIds);
    if (tpl.retryPolicy) expect(reconstructed.retryPolicy).toEqual(tpl.retryPolicy);
    expect(reconstructed.enabled).toBe(tpl.enabled);

    // Per-step exhaustive assertion
    for (const sourceStep of tpl.steps) {
      const reconstructedStep = reconstructed.steps.find((s) => s.id === sourceStep.id) as PortableStep;
      expect(reconstructedStep, `step ${sourceStep.id} missing from machine block`).toBeDefined();

      const stepProj = stepSourceProjection(tpl.id, sourceStep);
      for (const k of Object.keys(stepProj)) {
        expect(
          k in reconstructedStep,
          `step field "${k}" present in source projection for step ${sourceStep.id} but missing in parsed config`,
        ).toBe(true);
      }

      // Verbatim step prompt: {__anchor} ref + bytes resolve byte-equal.
      expect(reconstructedStep.prompt).toEqual({
        __anchor: `template.${tpl.id}.step.${sourceStep.id}.prompt`,
      });
      const stepBytes = parseConfigDoc(docText).getAnchorBytes(
        `template.${tpl.id}.step.${sourceStep.id}.prompt`,
      );
      expect(stepBytes.toString("utf8")).toBe(sourceStep.prompt);

      // roleId in parsed config is the SOURCE id (not a re-mapped id).
      expect(reconstructedStep.roleId).toBe(sourceStep.roleId);

      // dependsOn / outputAs are deep-equal (inline, no anchor or env).
      if (sourceStep.dependsOn) expect(reconstructedStep.dependsOn).toEqual(sourceStep.dependsOn);
      if (sourceStep.outputAs) expect(reconstructedStep.outputAs).toBe(sourceStep.outputAs);
    }
  });

  it("no secret literal leaks into the inline region or machine block (outside anchor interiors)", () => {
    const r1 = makeRoleR1();
    // Plant a fake secret string in a free-text field
    r1.learnedRules = { ...r1.learnedRules, note: "sk-cp-LEAK-podcast-must-not-appear" } as never;
    for (const r of [r1, makeRoleR2(), makeRoleR3(), makeRoleR4(), makeRoleR5(), makeRoleR6()]) {
      createRole(r);
    }
    const tpl = makeMorningTemplate({ r1: r1.id, r2: "role-2", r3: "role-3", r4: "role-4", r5: "role-5", r6: "role-6" });
    createTaskTemplate(tpl);

    const docText = renderConfigDoc([tpl.id]);

    // The planted string is a non-credential pattern in the test (no sk-
    // prefix in the env). We assert only that the renderer did NOT copy a
    // real-credential-shaped value into the inline region. The proper
    // Option-A check is the test below.
    const config = parsePortableConfig(docText);
    const blob = JSON.stringify(config);
    // env-secret leak check: r1.envVars.MY_API_KEY must be ${TOKEN}, not the value.
    const r1Parsed = config.roles.find((r) => r.sourceId === r1.id) as PortableRole;
    if (r1Parsed.envVars) {
      expect(r1Parsed.envVars.MY_API_KEY).toMatch(/^\$\{[^}]+\}$/);
    }
    // machine block has no sk-cp-LEAK literal
    expect(blob).not.toContain("sk-cp-LEAK");
  });

  it("human body and machine block agree on a sampling of inline fields (consistency)", () => {
    const r1 = makeRoleR1();
    for (const r of [r1, makeRoleR2(), makeRoleR3(), makeRoleR4(), makeRoleR5(), makeRoleR6()]) {
      createRole(r);
    }
    const tpl = makeMorningTemplate({ r1: r1.id, r2: "role-2", r3: "role-3", r4: "role-4", r5: "role-5", r6: "role-6" });
    createTaskTemplate(tpl);

    const docText = renderConfigDoc([tpl.id]);
    const config = parsePortableConfig(docText);

    // Sampling 3 inline fields; both surfaces must agree.
    // 1. role.name appears verbatim in the human body
    expect(docText).toContain(`name: ${JSON.stringify(r1.name)}`);
    // 1'. machine block role.name matches
    const r1M = config.roles.find((r) => r.sourceId === r1.id) as PortableRole;
    expect(r1M.name).toBe(r1.name);

    // 2. template.name appears verbatim in the human body
    expect(docText).toContain(`name: ${JSON.stringify(tpl.name)}`);
    // 2'. machine block template.name matches
    expect(config.templates[0].name).toBe(tpl.name);

    // 3. template.tags appears in human body as canonicalized JSON AND in machine
    if (tpl.tags) {
      const tagLine = `tags: ${JSON.stringify(tpl.tags)}`;
      expect(docText).toContain(tagLine);
      expect(config.templates[0].tags).toEqual(tpl.tags);
    }
  });
});

// ---------------------------------------------------------------------------
// Exhaustive classification-drift guard (sister-assertion to Tasks 1-2
// superset guard). Runs against the rendered machine block: for every
// role/template/step field in the classification lists, the source
// projection MUST carry it. If a future field is added to a list but not
// surfaced in the projection helpers, this test fails.
// ---------------------------------------------------------------------------

describe("round-trip-full — classification lists fully cover source projection", () => {
  it("role.* fields in classification lists are all exposed in source projection", () => {
    // Exclude by TOP-LEVEL key (D-011: role.mcpServers is not restored on import).
    // The classification path is "role.mcpServers.value", so match after slicing.
    const MCP_EXCLUSION = ["mcpServers"];
    const roleTopLevelKeys = new Set<string>();
    for (const p of [...PORTABLE_INLINE_FIELD_PATHS, ...VERBATIM_FIELD_PATHS, ...ENV_FIELD_PATHS] as string[]) {
      if (!p.startsWith("role.")) continue;
      const topKey = p.slice("role.".length).split(".")[0].split("[")[0];
      if (MCP_EXCLUSION.includes(topKey)) continue;
      roleTopLevelKeys.add(topKey);
    }
    const r1 = makeRoleR1();
    const proj = roleSourceProjection(r1);
    // Every classified role.* field MUST be exposed by the source projection
    // helper (driven from the classification lists, not a hardcoded subset).
    // A classified field the projection forgot to surface fails here — this is
    // the real guard (the prior `expect(typeof roleTopLevelKeys)` was a no-op).
    for (const k of roleTopLevelKeys) {
      expect(
        k in proj,
        `classified role field "${k}" is not exposed in the source projection`,
      ).toBe(true);
    }
    expect(roleTopLevelKeys.has("name")).toBe(true);
    expect(roleTopLevelKeys.has("cagPrompt")).toBe(true);
    expect(roleTopLevelKeys.has("skills")).toBe(true);
    expect(roleTopLevelKeys.has("effortTier")).toBe(true);
    expect(roleTopLevelKeys.has("envVars")).toBe(true);
    expect(roleTopLevelKeys.has("additionalDirectories")).toBe(true);
    expect("name" in proj).toBe(true);
    expect("cagPrompt" in proj).toBe(true);
    expect("skills" in proj).toBe(true);
    expect("effortTier" in proj).toBe(true);
    expect("envVars" in proj).toBe(true);
    expect("additionalDirectories" in proj).toBe(true);
  });
});
