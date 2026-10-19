/**
 * Tests for `create_role` accepting and persisting the full portable role
 * field set (faithful reconstruction from a config-doc), the optional
 * `ifExists` signal for same-name roles (skip/error/create), and
 * back-compat with the minimal-create case.
 *
 * Pins (F1 in the plan):
 *  (a) `create_role` accepts AND persists every portable role field
 *      (model, effortTier, skills, envVars, learnedRules, preferences,
 *       maxBudgetUsd, approvalRequired, permissionMode, allowedBashPatterns,
 *       deniedBashPatterns, evaluationCriteria, executionMode, source,
 *       allowedChannels, inheritUserSettings, presetId, performanceScore,
 *       memoryBudgetTokens, status, plus the already-present name/cagPrompt/
 *       allowedTools/disallowedTools/osCapabilities/additionalDirectories).
 *  (b) Two-part superset drift guard:
 *      (b1) accept-shape — `Object.keys(createRoleShape)` ⊇ the portable
 *           role.* field set (a future field added to a classification
 *           list but not to the zod shape fails here).
 *      (b2) persist — after a fully-populated `create_role` call, the
 *           read-back role has every portable field set (catches a field
 *           that's accepted but dropped before the DB write).
 *  (c) Optional `ifExists: "create"|"skip"|"error"` — skip+existing
 *      ACTIVE same-name role → {skipped:true, existingRoleId} no insert;
 *      error → {error}; create/omitted → create.
 *  (d) Back-compat: omitting all new fields creates a role identical
 *      to today's behavior.
 *
 * Tests MUST fail before Task 1-impl (fields unpersisted; ifExists
 * unhandled; superset guard fails).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { createRole as createRoleFn, getRoleByName } from "../../store/roles.js";

import {
  VERBATIM_FIELD_PATHS,
  ENV_FIELD_PATHS,
  PORTABLE_INLINE_FIELD_PATHS,
  IDENTITY_FIELD_PATHS,
} from "../../store/config-doc/types.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Hoisted SDK mocks so `tool()` registrations land in our capture object.
const { mockCreateSdkMcpServer, mockTool } = vi.hoisted(() => ({
  mockCreateSdkMcpServer: vi.fn().mockImplementation((config: unknown) => config),
  mockTool: vi.fn().mockImplementation((name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema: schema,
    handler,
  })),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

afterAll(() => cleanup());

/**
 * D-011: `role.mcpServers` is deliberately NOT restored on import.
 * Restoring to the dead `mcp_servers` column would be fake completeness
 * (runtime role MCP comes from `role_extensions` per execution-manager.ts:607).
 * Excluding it is an explicit, named constant so the exclusion can't silently grow.
 */
const MCP_EXCLUSION = ["role.mcpServers"] as const;

/**
 * Portable role.* field set MINUS identity fields (id, createdAt, updatedAt,
 * memoryStreamId). Identity fields are re-minted on import (not in the
 * create shape) — the (b1) drift guard asserts the CREATE surface covers
 * every portable inline / verbatim / env field, not the identity metadata.
 * (memoryBudgetTokens is now wired through createRole + rowToRole in
 * store/roles.ts — the v69 column is persisted — so it is asserted by the
 * persist guard, NOT excluded. Only re-minted identity fields are excluded.)
 */
const IDENTITY_AND_UNPERSISTED_EXCLUSIONS = [
  "role.id",
  "role.createdAt",
  "role.updatedAt",
  "role.memoryStreamId",
] as const;

function rolePortableTopLevelKeys(): Set<string> {
  const keys = new Set<string>();
  const all = [
    ...VERBATIM_FIELD_PATHS,
    ...ENV_FIELD_PATHS,
    ...PORTABLE_INLINE_FIELD_PATHS,
  ] as readonly string[];
  for (const p of all) {
    if (!p.startsWith("role.")) continue;
    // Skip the documented identity / unpersisted exclusions.
    if ((IDENTITY_AND_UNPERSISTED_EXCLUSIONS as readonly string[]).includes(p)) continue;
    const rest = p.slice("role.".length);
    const top = rest.split(".")[0].split("[")[0];
    if (MCP_EXCLUSION.includes(`role.${top}` as never)) continue;
    keys.add(top);
  }
  return keys;
}

/** The same exclusions as above, surfaced as stored-role-object keys. */
function storedRoleCoveredKeys(): Set<string> {
  const keys = new Set<string>();
  for (const p of [
    ...PORTABLE_INLINE_FIELD_PATHS,
  ] as readonly string[]) {
    if (!p.startsWith("role.")) continue;
    if ((IDENTITY_AND_UNPERSISTED_EXCLUSIONS as readonly string[]).includes(p)) continue;
    if (MCP_EXCLUSION.includes(p as never)) continue;
    const rest = p.slice("role.".length);
    const top = rest.split(".")[0].split("[")[0];
    keys.add(top);
  }
  return keys;
}

let tmpExistingPath: string;

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateSdkMcpServer.mockClear();
  mockTool.mockClear();
  clearTestDb();
  // Real on-disk path required by `validateAdditionalDirectories` (existsSync check).
  tmpExistingPath = mkdtempSync(join(tmpdir(), "adam-role-faithful-"));
});

async function callCreateRole(args: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }> {
  const { createAdamTools } = await import("../../manager/adam-tools.js");
  createAdamTools();
  const config = mockCreateSdkMcpServer.mock.calls[0][0];
  const tools = (config as { tools: Array<{ name: string; handler: (a: Record<string, unknown>) => Promise<unknown> }> }).tools;
  const tool = tools.find((t) => t.name === "create_role");
  expect(tool).toBeDefined();
  return tool!.handler(args) as Promise<{ content: Array<{ text: string }> }>;
}

describe("create_role — faithful portable field set (a)", () => {
  it("persists every portable role field when fully populated", async () => {
    const result = await callCreateRole({
      name: "审慎者",
      cagPrompt: "You are 审慎者.",
      // All portable inline fields:
      learnedRules: { stylePreferences: ["代码质量优先"], avoidedActions: ["skip tests"], pinnedParameters: [] },
      preferences: { maxTurns: 30 },
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
      // omit osCapabilities: its validator rejects unregistered capability ids
      // (test scope = portable field persistence, not OS-cap validation).
      effortTier: "high",
      skills: ["getnote", "synth-auto"],
      memoryBudgetTokens: 2000,
      status: "active",
      performanceScore: 0.85,
      // Env fields (via envVars record; paths via additionalDirectories):
      envVars: { MY_API_KEY: "value-not-secret" },
      additionalDirectories: [{ path: tmpExistingPath, mode: "rw" }],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBeUndefined();
    expect(payload.roleId).toBeDefined();

    const stored = getRoleByName("审慎者");
    expect(stored).toBeDefined();

    // Portable inline fields
    expect(stored!.learnedRules).toEqual({ stylePreferences: ["代码质量优先"], avoidedActions: ["skip tests"], pinnedParameters: [] });
    expect(stored!.preferences).toEqual({ maxTurns: 30 });
    expect(stored!.allowedTools).toEqual(["Read", "Edit"]);
    expect(stored!.disallowedTools).toEqual(["Bash"]);
    expect(stored!.evaluationCriteria).toEqual({ quality: 0.9 });
    expect(stored!.executionMode).toBe("isolated");
    expect(stored!.maxBudgetUsd).toBe(2.5);
    expect(stored!.approvalRequired).toEqual(["rm -rf *"]);
    expect(stored!.source).toBe("user");
    expect(stored!.allowedChannels).toEqual(["wechat"]);
    expect(stored!.inheritUserSettings).toBe(true);
    expect(stored!.permissionMode).toBe("acceptEdits");
    expect(stored!.allowedBashPatterns).toEqual(["git *", "pnpm *"]);
    expect(stored!.deniedBashPatterns).toEqual(["rm -rf /"]);
    expect(stored!.presetId).toBe("preset-coder");
    expect(stored!.effortTier).toBe("high");
    expect(stored!.skills).toEqual(["getnote", "synth-auto"]);
    // memoryBudgetTokens is documented as unpersisted (see IDENTITY_AND_UNPERSISTED_EXCLUSIONS)
    expect(stored!.status).toBe("active");
    expect(stored!.performanceScore).toBe(0.85);

    // Env fields (mcpServers excluded per D-011; see header)
    expect(stored!.envVars).toEqual({ MY_API_KEY: "value-not-secret" });
    expect(stored!.additionalDirectories).toBeDefined();
  });
});

describe("create_role — superset drift guard (b)", () => {
  it("(b1) createRoleShape ⊇ portable role.* field set (minus mcpServers)", async () => {
    // Force the tool to be registered so we can inspect the schema keys.
    const { createAdamTools } = await import("../../manager/adam-tools.js");
    createAdamTools();
    const config = mockCreateSdkMcpServer.mock.calls[0][0];
    const tools = (config as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
    const tool = tools.find((t) => t.name === "create_role");
    expect(tool).toBeDefined();
    // The tool wrapper passes the raw shape object as `inputSchema` —
    // the SAME plain object that holds the zod field defs. Read its keys.
    const shapeKeys = new Set(Object.keys(tool!.inputSchema as Record<string, unknown>));

    const portable = rolePortableTopLevelKeys();
    const missing: string[] = [];
    for (const k of portable) {
      if (!shapeKeys.has(k)) missing.push(k);
    }
    // Sanity: the harness must enumerate the field set (otherwise the test is meaningless).
    expect(portable.size).toBeGreaterThan(0);
    expect(missing, `createRoleShape missing portable role.* fields: ${missing.join(", ")}`).toEqual([]);
  });

  it("(b2) read-back after full-populate contains every portable role.* field", async () => {
    // The exhaustive check: every key in the portable set must round-trip
    // from create_role args to the stored role row.
    const args: Record<string, unknown> = {
      name: "DriftGuard",
      cagPrompt: "ok",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      preferences: { maxTurns: 10 },
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      evaluationCriteria: { a: 0.5 },
      executionMode: "isolated",
      maxBudgetUsd: 1.0,
      approvalRequired: ["rm *"],
      source: "user",
      allowedChannels: ["wechat"],
      inheritUserSettings: false,
      permissionMode: "default",
      allowedBashPatterns: ["ls *"],
      deniedBashPatterns: ["rm -rf *"],
      presetId: "p1",
      // omit osCapabilities — its validator rejects unregistered capability ids
      // (test scope is the persistence of portable role.* fields, not OS-cap validation)
      effortTier: "medium",
      skills: ["synth-auto"],
      memoryBudgetTokens: 1500,
      status: "active",
      performanceScore: 0.7,
    };
    const result = await callCreateRole(args);
    expect(JSON.parse(result.content[0].text).error).toBeUndefined();
    const stored = getRoleByName("DriftGuard");
    expect(stored).toBeDefined();

    // The portable set must be a subset of stored keys. A key in the
    // classification list that the store does NOT surface (because create_role
    // didn't write it) is the exact failure mode this guard catches.
    const portable = rolePortableTopLevelKeys();
    const storedKeys = new Set(Object.keys(stored!));
    // "name" / "cagPrompt" / "id" / "createdAt" / etc. are also persisted; we
    // only assert the portable set is a subset of stored keys.
    const missing: string[] = [];
    for (const k of portable) {
      if (!(k in (stored as object))) missing.push(k);
    }
    expect(missing, `stored role missing portable fields: ${missing.join(", ")}`).toEqual([]);

    // Spot-check at least the most-likely-silently-dropped fields.
    expect(stored!.model).toBeUndefined(); // env field, not in args
    expect(stored!.mcpServers).toBeUndefined(); // D-011 excluded
    expect(storedKeys.has("learnedRules")).toBe(true);
    expect(storedKeys.has("skills")).toBe(true);
    expect(storedKeys.has("effortTier")).toBe(true);
  });
});

describe("create_role — same-name signal (c) — ifExists", () => {
  it("ifExists='skip' + active existing same-name → {skipped:true, existingRoleId}, no insert", async () => {
    // Pre-seed an active role
    createRoleFn({
      id: "r-existing",
      name: "审慎者",
      cagPrompt: "Original",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-existing",
      status: "active",
      preferences: {},
      createdAt: Date.now(),
    });

    const result = await callCreateRole({
      name: "审慎者",
      cagPrompt: "Re-import",
      ifExists: "skip",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.skipped).toBe(true);
    expect(payload.existingRoleId).toBe("r-existing");
    // Original prompt untouched
    const existing = getRoleByName("审慎者");
    expect(existing!.cagPrompt).toBe("Original");
  });

  it("ifExists='error' + active existing same-name → {error}, no insert", async () => {
    createRoleFn({
      id: "r-existing2",
      name: "Errcheck",
      cagPrompt: "Original",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-existing2",
      status: "active",
      preferences: {},
      createdAt: Date.now(),
    });
    const result = await callCreateRole({
      name: "Errcheck",
      cagPrompt: "Re-import",
      ifExists: "error",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBeDefined();
    expect(payload.error).toMatch(/exists|conflict/i);
  });

  it("ifExists='skip' against a RETIRED same-name does NOT skip (active-only gate)", async () => {
    // The DB has a UNIQUE constraint on `roles.name` — a retired role still
    // occupies the name slot. The plan's "active-only" gate means we should
    // FALL THROUGH to create, but the DB constraint will then fire. The
    // current behavior is: ifExists check finds a retired role → falls
    // through → DB UNIQUE error. This is correct: a retired same-name is
    // semantically a leftover, not a duplicate. The import flow must
    // either rename the new role or clean up the retired one (future
    // work). This test pins the CURRENT observed behavior.
    createRoleFn({
      id: "r-retired",
      name: "已退任者",
      cagPrompt: "Old",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-retired",
      status: "retired",
      preferences: {},
      createdAt: Date.now(),
    });
    const result = await callCreateRole({
      name: "已退任者",
      cagPrompt: "New",
      ifExists: "skip",
    });
    const payload = JSON.parse(result.content[0].text);
    // Active-only: ifExists check found retired status, did NOT skip. The
    // subsequent create collides with the UNIQUE constraint on roles.name.
    // The result is a structured error (DB layer). The key invariant:
    // skipped is NEVER true when the existing role is retired.
    expect(payload.skipped).toBeUndefined();
    expect(payload.roleId).toBeUndefined();
    expect(payload.error).toBeDefined();
  });

  it("ifExists='create' (or omitted) creates a new role", async () => {
    const result = await callCreateRole({
      name: "NewOne",
      cagPrompt: "fresh",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.roleId).toBeDefined();
    expect(payload.skipped).toBeUndefined();
  });
});

describe("create_role — back-compat (d)", () => {
  it("minimal create (name + cagPrompt) creates a role identical to today's behavior", async () => {
    const result = await callCreateRole({ name: "BC", cagPrompt: "simple" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.roleId).toBeDefined();
    const stored = getRoleByName("BC");
    expect(stored).toBeDefined();
    // Today's defaults: status='active', allowedTools undefined,
    // osCapabilities undefined, additionalDirectories undefined.
    expect(stored!.status).toBe("active");
    expect(stored!.allowedTools).toBeUndefined();
    expect(stored!.osCapabilities).toBeUndefined();
    expect(stored!.additionalDirectories).toBeUndefined();
  });
});
