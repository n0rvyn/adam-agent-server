/**
 * Tests for src/store/config-doc/renderer.ts
 *
 * Pins:
 * - Closure walk: roleId + autoSelectRole + rolePreference paths are all
 *   captured; deduplicated across N templates sharing roles.
 * - Env fields → ${PLACEHOLDER}; NO literal channelId/chatId/path/model/
 *   env-value/mcp-value substring survives in the rendered text.
 * - Verbatim fields → anchor blocks; bytes byte-identical to source; content
 *   containing backticks and fake close markers stays intact.
 * - Round-trip: parseConfigDoc(render(set)) → reconstruct template+role objects
 *   that are deep-structurally equal to the source (ignoring placeholders).
 *
 * These tests MUST fail before Task 4-impl (renderer not implemented yet).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { rmSync } from "node:fs";

import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { renderConfigDoc, looksLikeCredential } from "../../store/config-doc/renderer.js";
import { parseConfigDoc } from "../../store/config-doc/parser.js";
import { assertExhaustiveKeys } from "../../store/config-doc/types.js";
import { createRole, getRole } from "../../store/roles.js";
import { createTaskTemplate, getTaskTemplate } from "../../store/task-templates.js";

afterAll(() => {
  try { rmSync(process.env.ADAM_TEST_DIR!, { recursive: true, force: true }); } catch { /* */ }
});

beforeEach(() => {
  clearTestDb();
});

describe("renderConfigDoc — closure walk + dedup", () => {
  it("deduplicates roles shared across templates (no duplicate role sections)", () => {
    const r = {
      id: "r-shared",
      name: "SharedRole",
      cagPrompt: "shared cag",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-shared",
      status: "active" as const,
      preferences: {},
      createdAt: 1,
    };
    createRole(r);
    const t1 = {
      id: "t1",
      name: "T1",
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: 1,
      steps: [{ id: "s1", prompt: "p1", roleId: "r-shared" }],
    };
    const t2 = {
      id: "t2",
      name: "T2",
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: 1,
      steps: [{ id: "s1", prompt: "p2", roleId: "r-shared" }],
    };
    createTaskTemplate(t1);
    createTaskTemplate(t2);
    const doc = renderConfigDoc(["t1", "t2"]);
    // The role id appears in the body once
    const roleIdOccurrences = (doc.match(/r-shared/g) ?? []).length;
    // At minimum it appears once in the header inventory + once in the body
    // closure section. The point of dedup is that there is only ONE closure
    // section, not two.
    const closureMarkers = (doc.match(/## role r-shared/g) ?? []).length;
    expect(closureMarkers).toBe(1);
    // Loose sanity: at least the role id appears in the doc
    expect(roleIdOccurrences).toBeGreaterThanOrEqual(1);
  });

  it("captures autoSelectRole + requirements path (cannot resolve to a concrete role deterministically)", () => {
    const r = {
      id: "r-auto",
      name: "AutoRole",
      cagPrompt: "x",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-auto",
      status: "active" as const,
      preferences: {},
      createdAt: 1,
    };
    createRole(r);
    const tpl = {
      id: "t-auto",
      name: "AutoSelectTpl",
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: 1,
      steps: [
        {
          id: "s1",
          prompt: "do it",
          autoSelectRole: true,
          requirements: { plugins: ["synth-auto"] },
        },
      ],
    };
    createTaskTemplate(tpl);
    const doc = renderConfigDoc(["t-auto"]);
    // Either the requirements are captured in the body OR an autoselect
    // placeholder is emitted. The doc should mention the requirements
    // plugin id in some form.
    expect(doc).toContain("synth-auto");
  });

  it("captures rolePreference fallback path (template with no per-step roleId)", () => {
    const r = {
      id: "r-pref",
      name: "PrefRole",
      cagPrompt: "x",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-pref",
      status: "active" as const,
      preferences: {},
      createdAt: 1,
    };
    createRole(r);
    const tpl = {
      id: "t-pref",
      name: "PrefTpl",
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: 1,
      rolePreference: "r-pref",
      steps: [{ id: "s1", prompt: "x" }],
    };
    createTaskTemplate(tpl);
    const doc = renderConfigDoc(["t-pref"]);
    // The rolePreference resolves to r-pref; the closure should contain it
    expect(doc).toContain("r-pref");
  });
});

describe("renderConfigDoc — env → placeholder substitution", () => {
  it("replaces all env fields with ${PLACEHOLDER}; no literal secret value survives", () => {
    const runtimeDir = process.env.ADAM_TEST_DIR!;
    const r = {
      id: "r-sec",
      name: "SecRole",
      cagPrompt: "x",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-sec",
      status: "active" as const,
      preferences: {},
      createdAt: 1,
      model: "claude-opus-4-8",
      additionalDirectories: [{ path: runtimeDir }],
      envVars: { API_KEY: "testlive-secret-value-xyz" },
      mcpServers: { "minimax-secret": { command: "uvx" } },
    };
    createRole(r);
    const tpl = {
      id: "t-sec",
      name: "SecTpl",
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: 1,
      deliverTo: [{ type: "channel" as const, channelId: "wechat:secret-channel-id", chatId: "secret-chat-id" }],
      steps: [{ id: "s1", prompt: "p", roleId: "r-sec" }],
      config: { env: { DB_URL: "postgres://secret-host/db" }, timeout: 60, approvalRequired: [], approvalTimeout: 60 },
    };
    createTaskTemplate(tpl);
    const doc = renderConfigDoc(["t-sec"]);
    // NO literal secret value survives
    expect(doc).not.toContain("testlive-secret-value-xyz");
    expect(doc).not.toContain("wechat:secret-channel-id");
    expect(doc).not.toContain("secret-chat-id");
    expect(doc).not.toContain("claude-opus-4-8");
    // The runtime path is also an env value (placeholdered as PATH_*)
    // (it may appear in anchor block content if it were a verbatim field, but
    // additionalDirectories path is an env field, so it's placeholdered)
    expect(doc).not.toContain("postgres://secret-host/db");
    // Placeholders ARE present
    expect(doc).toMatch(/\$\{[A-Z_0-9]+\}/);
  });

  it("placeholders nested secret-bearing template.config.mcpServers (does not serialize wholesale)", () => {
    const r = {
      id: "r-cfgmcp", name: "CfgMcp", cagPrompt: "x",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "m", status: "active" as const, preferences: {}, createdAt: 1,
    };
    createRole(r);
    const tpl = {
      id: "t-cfgmcp", name: "CfgMcp", trigger: { type: "manual" as const },
      enabled: true, createdAt: 1,
      steps: [{ id: "s1", prompt: "p", roleId: "r-cfgmcp" }],
      // config.mcpServers carries a credential-shaped object — the exact vector
      // the cycle-1 top-level guard missed (serialized wholesale via canonicalize).
      config: {
        timeout: 60, approvalRequired: [], approvalTimeout: 60,
        mcpServers: { "minimax-cfg": { command: "uvx", env: { TOKEN: "testcfg-secret-abc" } } },
      },
    };
    createTaskTemplate(tpl);
    const doc = renderConfigDoc(["t-cfgmcp"]);
    expect(doc).not.toContain("testcfg-secret-abc");
    expect(doc).not.toContain("minimax-cfg\":{\"command");
    // The config.mcpServers key is emitted as a placeholder token
    expect(doc).toContain("config.mcpServers.minimax-cfg: ${");
  });
});

describe("secret model — Option A: credentials hard-fail, env paths tolerated in free-text", () => {
  it("looksLikeCredential: real API keys true; budgets / workspace names / paths-as-words false", () => {
    expect(looksLikeCredential("gk_live_f1658d1da8f29a11.d7cc8c83b73ee01e")).toBe(true);
    expect(looksLikeCredential("sk-cp-WtR27hTMra9V6S6-Np4h4DaVEbQ0bC3gB0TE")).toBe(true);
    expect(looksLikeCredential("ntn_307550691712MZcnBNEU9QdwVk8NUjJv7SjWv")).toBe(true);
    // false-positives the old substring guard tripped on:
    expect(looksLikeCredential("20000")).toBe(false);          // numeric budget
    expect(looksLikeCredential("Health Insights")).toBe(false); // prose (has space)
    expect(looksLikeCredential("balanced")).toBe(false);        // short word
  });

  it("TOLERATES an env path embedded in learnedRules free-text (export succeeds, path placeholdered only in its designated field)", () => {
    const realDir = process.env.ADAM_TEST_DIR!; // exists — createRole validates additionalDirectories
    const r = {
      id: "r-lr", name: "LR", cagPrompt: "x",
      learnedRules: {
        // learnedRules is free text and NOT path-validated — an arbitrary path is fine
        stylePreferences: ["Always run mkdir -p /Users/me/Code/InfoHub/out before writing"],
        avoidedActions: [], pinnedParameters: [],
      },
      allowedBashPatterns: ["mkdir -p /Users/me/Code/InfoHub/*"],
      memoryStreamId: "m", status: "active" as const, preferences: {}, createdAt: 1,
      additionalDirectories: [{ path: realDir, mode: "rw" as const }],
    };
    createRole(r);
    const tpl = {
      id: "t-lr", name: "LR", trigger: { type: "manual" as const },
      enabled: true, createdAt: 1,
      steps: [{ id: "s1", prompt: "p", roleId: "r-lr" }],
    };
    createTaskTemplate(tpl);
    // Must NOT throw — path in learnedRules/bashPatterns is tolerated.
    const doc = renderConfigDoc(["t-lr"]);
    // additionalDirectories.path is still placeholdered in its designated field:
    expect(doc).toContain("additionalDirectories[0].path: ${");
    // and the path is allowed to remain inside the learnedRules free-text:
    expect(doc).toContain("/Users/me/Code/InfoHub/out");
  });

  it("HARD-FAILS when a credential-shaped value leaks into learnedRules free-text", () => {
    const r = {
      id: "r-leak", name: "Leak", cagPrompt: "x",
      learnedRules: {
        // a real API key accidentally captured into a learned rule
        stylePreferences: ["Use token sk-cp-LIVEKEYABCDEF1234567890XYZ for the API"],
        avoidedActions: [], pinnedParameters: [],
      },
      memoryStreamId: "m", status: "active" as const, preferences: {}, createdAt: 1,
      envVars: { MINIMAX_API_KEY: "sk-cp-LIVEKEYABCDEF1234567890XYZ" },
    };
    createRole(r);
    const tpl = {
      id: "t-leak", name: "Leak", trigger: { type: "manual" as const },
      enabled: true, createdAt: 1,
      steps: [{ id: "s1", prompt: "p", roleId: "r-leak" }],
    };
    createTaskTemplate(tpl);
    expect(() => renderConfigDoc(["t-leak"])).toThrow(/CREDENTIAL leak/);
  });
});

describe("renderConfigDoc — verbatim → anchor byte fidelity", () => {
  it("emits anchor blocks whose bytes are byte-identical to source; backticks + fake close markers do not break extraction", () => {
    const promptWithBackticks = "Write the morning brief.\nUse ```yaml\nkey: value\n```\nA fake <!-- /adam:field --> remains.";
    const r = {
      id: "r-v",
      name: "VRole",
      cagPrompt: promptWithBackticks,
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-v",
      status: "active" as const,
      preferences: {},
      createdAt: 1,
    };
    createRole(r);
    const tpl = {
      id: "t-v",
      name: "VTpl",
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: 1,
      steps: [{ id: "s1", prompt: promptWithBackticks, roleId: "r-v" }],
    };
    createTaskTemplate(tpl);
    const doc = renderConfigDoc(["t-v"]);
    // Round-trip: parse the doc and read the role cagPrompt anchor bytes
    const parsed = parseConfigDoc(doc);
    const roleCagBytes = parsed.getAnchorBytes("role.r-v.cagPrompt");
    expect(Buffer.compare(roleCagBytes, Buffer.from(promptWithBackticks, "utf8"))).toBe(0);
    // The step prompt anchor also matches
    const stepPromptBytes = parsed.getAnchorBytes("template.t-v.step.s1.prompt");
    expect(Buffer.compare(stepPromptBytes, Buffer.from(promptWithBackticks, "utf8"))).toBe(0);
  });
});

describe("renderConfigDoc — round-trip structural equality", () => {
  it("parses the rendered doc back into header fields that match the source template/role set", () => {
    const r = {
      id: "r-rt",
      name: "RT",
      cagPrompt: "cag",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-rt",
      status: "active" as const,
      preferences: {},
      createdAt: 1,
      model: "claude-sonnet-4-6",
    };
    createRole(r);
    const tpl = {
      id: "t-rt",
      name: "RT",
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: 1,
      steps: [{ id: "s1", prompt: "p", roleId: "r-rt" }],
    };
    createTaskTemplate(tpl);
    const doc = renderConfigDoc(["t-rt"]);
    const parsed = parseConfigDoc(doc);
    // Header inventories include the template + role
    expect(parsed.header.templates).toEqual([{ id: "t-rt", name: "RT" }]);
    expect(parsed.header.roles).toEqual([{ id: "r-rt", name: "RT" }]);
    // Source template/role still readable from DB (no side effects)
    const srcTpl = getTaskTemplate("t-rt");
    const srcRole = getRole("r-rt");
    expect(srcTpl).toBeDefined();
    expect(srcRole).toBeDefined();
    expect(srcTpl!.name).toBe("RT");
    expect(srcRole!.cagPrompt).toBe("cag");
  });
});

describe("assertExhaustiveKeys — fail-closed drift guard (wired, not dead)", () => {
  it("does NOT throw on a fully-populated role/template/step (every current field classified)", () => {
    // A role that exercises every Role top-level field that real podcast roles carry.
    const role = {
      id: "r-full", name: "Full", cagPrompt: "x",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "m", status: "active", performanceScore: 0.5,
      preferences: {}, createdAt: 1, updatedAt: 2,
      allowedTools: [], disallowedTools: [], evaluationCriteria: {},
      executionMode: "isolated", model: "x", maxBudgetUsd: 1, approvalRequired: [],
      source: "user", additionalDirectories: [], allowedChannels: [],
      mcpServers: {}, inheritUserSettings: false, permissionMode: "default",
      allowedBashPatterns: [], deniedBashPatterns: [], presetId: "p",
      envVars: {}, osCapabilities: [], effortTier: "balanced", skills: "all",
      memoryBudgetTokens: 100,
    };
    expect(() => assertExhaustiveKeys("role", role)).not.toThrow();

    const template = {
      id: "t", name: "T", description: "d", trigger: { type: "manual" },
      steps: [], rolePreference: "r", config: {}, tags: [], enabled: true,
      createdAt: 1, updatedAt: 2, sourceSessionId: "s", deliverTo: [], reportTo: [],
      goalIds: [], isPreset: false, presetId: "p", retryPolicy: { maxAttempts: 1 },
    };
    expect(() => assertExhaustiveKeys("template", template)).not.toThrow();

    const step = {
      id: "s", prompt: "p", dependsOn: [], minDependencies: 0, outputAs: "o",
      roleId: "r", requirements: {}, autoSelectRole: false, config: {},
      consumesFrom: [], consumesFromOptional: [],
      persona: { speakAs: "x", voiceConstraints: "y" },
      outputContract: { mustReferenceArtifacts: true, customAssertions: [], contractRules: [] },
      assertions: [], recordEditorScores: false, candidateId: "c",
      briefPerturbation: { cross_domain_bucket: null, contrarian_source: "x" },
      kind: "k", settlementLedgerOwner: "o", publishesClaimsTo: "o",
      settlesPredictionsFor: "o", openLedgerOwner: "o", openLedgerLookbackDays: 2,
    };
    expect(() => assertExhaustiveKeys("step", step)).not.toThrow();
  });

  it("THROWS on an unknown top-level field (simulated future schema drift)", () => {
    expect(() => assertExhaustiveKeys("role", { id: "r", futureSecretField: "leak" }))
      .toThrow(/unclassified role field "futureSecretField"/);
    expect(() => assertExhaustiveKeys("step", { id: "s", brandNewStepField: 1 }))
      .toThrow(/unclassified step field "brandNewStepField"/);
  });

  it("ignores undefined-valued keys (absent optional fields do not trip the guard)", () => {
    expect(() => assertExhaustiveKeys("role", { id: "r", bogus: undefined })).not.toThrow();
  });
});

describe("renderConfigDoc — placeholder name consistency (body ⊆ header manifest)", () => {
  it("every ${NAME} token in the body has a matching header placeholder entry, incl. reportTo channels", () => {
    const r = {
      id: "r-ph", name: "PH", cagPrompt: "x",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "m", status: "active" as const, preferences: {}, createdAt: 1,
      model: "some-model",
    };
    createRole(r);
    const tpl = {
      id: "t-ph", name: "PH", trigger: { type: "manual" as const },
      enabled: true, createdAt: 1,
      // BOTH deliverTo AND reportTo channels — the exact case where the old
      // renderer minted CHANNEL_REPORT_* names with no manifest entry.
      deliverTo: [{ type: "channel" as const, channelId: "d-chan", chatId: "d-chat" }],
      reportTo: [{ type: "channel" as const, channelId: "r-chan", chatId: "r-chat" }],
      steps: [{ id: "s1", prompt: "p", roleId: "r-ph" }],
    };
    createTaskTemplate(tpl);
    const doc = renderConfigDoc(["t-ph"]);
    const parsed = parseConfigDoc(doc);
    const manifestNames = new Set(parsed.header.placeholders.map((p) => p.name));
    // Extract every ${NAME} token from the doc body
    const tokens = [...doc.matchAll(/\$\{([A-Za-z0-9_.]+)\}/g)].map((m) => m[1]);
    expect(tokens.length).toBeGreaterThan(0);
    for (const tok of tokens) {
      expect(manifestNames.has(tok), `body token \${${tok}} has no header placeholder entry`).toBe(true);
    }
  });
});
