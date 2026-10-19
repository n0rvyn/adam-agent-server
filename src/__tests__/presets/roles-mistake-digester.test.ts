import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";
import { MISTAKE_DIGESTER_PRESET } from "../../presets/roles/mistake-digester.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

describe("presets/roles/mistake-digester", () => {
  let cleanup: () => void;

  beforeEach(() => {
    const { cleanup: c } = setupTestDb();
    cleanup = c;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup!();
  });

  // -------------------------------------------------------------------------
  // Test 1: preset exists in ROLE_PRESETS
  // -------------------------------------------------------------------------

  it("Test 1: MISTAKE_DIGESTER_PRESET is included in getPresetRoles()", async () => {
    const { getPresetRoles } = await import("../../presets/index.js");
    const presets = getPresetRoles();
    expect(presets.some((p) => p.presetId === "mistake-digester")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: allowedTools / disallowedTools constraints
  // -------------------------------------------------------------------------

  it("Test 2: allowedTools contains mcp__audit-tools__aggregate_mistakes; disallowedTools includes Write/Edit/Bash", () => {
    expect(MISTAKE_DIGESTER_PRESET.allowedTools).toContain("mcp__audit-tools__aggregate_mistakes");
    expect(MISTAKE_DIGESTER_PRESET.disallowedTools).toContain("Write");
    expect(MISTAKE_DIGESTER_PRESET.disallowedTools).toContain("Edit");
    expect(MISTAKE_DIGESTER_PRESET.disallowedTools).toContain("Bash");
  });

  // -------------------------------------------------------------------------
  // Test 3: getSdkMcpServersForRole returns audit-tools server
  // -------------------------------------------------------------------------

  it("Test 3: getSdkMcpServersForRole({presetId:'mistake-digester'}) returns audit-tools", async () => {
    const { getSdkMcpServersForRole } = await import("../../manager/role-mcp-registry.js");
    const servers = getSdkMcpServersForRole({ id: "role-x", presetId: "mistake-digester" });
    expect(servers).toHaveProperty("audit-tools");
  });

  // -------------------------------------------------------------------------
  // Test 4: seedPresets creates the role; second call is idempotent
  // -------------------------------------------------------------------------

  it("Test 4: seedPresets() creates the role on first call; second call is idempotent", async () => {
    const { seedPresets } = await import("../../presets/index.js");
    const { getRoleByName } = await import("../../store/roles.js");

    // First call: creates role
    const r1 = seedPresets();
    expect(r1.rolesCreated).toBeGreaterThan(0);

    // The mistake-digester role should exist
    const role = getRoleByName(MISTAKE_DIGESTER_PRESET.name);
    expect(role).toBeDefined();
    expect(role!.presetId).toBe("mistake-digester");

    // Second call: should be idempotent (0 roles created)
    const r2 = seedPresets();
    expect(r2.rolesCreated).toBe(0);

    // Role still exists with same presetId
    const role2 = getRoleByName(MISTAKE_DIGESTER_PRESET.name);
    expect(role2).toBeDefined();
    expect(role2!.presetId).toBe("mistake-digester");
  });

  // -------------------------------------------------------------------------
  // Test 5: restorePreset preserves learnedRules / performanceScore
  // -------------------------------------------------------------------------

  it("Test 5: restorePreset('role','mistake-digester') overwrites preset fields but preserves learnedRules and performanceScore", async () => {
    const { seedPresets, restorePreset } = await import("../../presets/index.js");
    const { getRoleByName, updateRole } = await import("../../store/roles.js");

    // Seed first
    seedPresets();

    const role = getRoleByName(MISTAKE_DIGESTER_PRESET.name)!;

    // Simulate user editing: set learnedRules and performanceScore
    updateRole(role.id, {
      learnedRules: { stylePreferences: ["user-rule-1", "user-rule-2"], avoidedActions: [], pinnedParameters: [] },
      performanceScore: 0.85,
      cagPrompt: "user-modified CAG prompt",
    });

    // Restore the preset
    const result = restorePreset("role", "mistake-digester");
    expect(result.ok).toBe(true);

    // Verify: preset fields are restored
    const restored = getRoleByName(MISTAKE_DIGESTER_PRESET.name)!;
    expect(restored.cagPrompt).toBe(MISTAKE_DIGESTER_PRESET.cagPrompt);
    expect(restored.allowedTools).toEqual(MISTAKE_DIGESTER_PRESET.allowedTools);
    expect(restored.disallowedTools).toEqual(MISTAKE_DIGESTER_PRESET.disallowedTools);
    expect(restored.presetId).toBe("mistake-digester");

    // Verify: user fields are preserved
    expect(restored.learnedRules).toEqual({ stylePreferences: ["user-rule-1", "user-rule-2"], avoidedActions: [], pinnedParameters: [] });
    expect(restored.performanceScore).toBe(0.85);
  });
});
