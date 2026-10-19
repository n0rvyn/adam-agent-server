import { describe, it, expect } from "vitest";
import { computeEffectivePermissions } from "../../lib/permissions.js";
import type { DefaultsConfig, RolePermissions } from "../../shared/types.js";

const makeDefaults = (overrides?: Partial<DefaultsConfig>): DefaultsConfig => ({
  timeout: 600,
  maxTurns: 100,
  maxBudgetUsd: 5.0,
  effort: "high",
  model: "",
  settingSources: ["user", "project"],
  allowedTools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
  disallowedTools: ["rm"],
  approvalRequired: ["rm -rf", "git push"],
  approvalTimeout: 300,
  env: {},
  plugins: ["plugin-a"],
  ...overrides,
});

describe("computeEffectivePermissions", () => {
  it("returns defaults when agent has no permissions object", () => {
    const defaults = makeDefaults();
    const result = computeEffectivePermissions(defaults, undefined);

    expect(result.allowedTools).toEqual(["Read", "Write", "Edit", "Bash", "Grep", "Glob"]);
    expect(result.disallowedTools).toEqual(["rm"]);
    expect(result.approvalRequired).toEqual(["rm -rf", "git push"]);
    expect(result.maxBudgetUsd).toBe(5.0);
    expect(result.plugins).toEqual(["plugin-a"]);
  });

  it("returns defaults when agent permissions has all undefined fields", () => {
    const defaults = makeDefaults();
    const agentPerms: RolePermissions = {};
    const result = computeEffectivePermissions(defaults, agentPerms);

    expect(result.allowedTools).toEqual(["Read", "Write", "Edit", "Bash", "Grep", "Glob"]);
    expect(result.maxBudgetUsd).toBe(5.0);
  });

  it("intersects allowedTools — agent subset of defaults", () => {
    const defaults = makeDefaults();
    const agentPerms: RolePermissions = {
      allowedTools: ["Read", "Grep"],
    };
    const result = computeEffectivePermissions(defaults, agentPerms);

    expect(result.allowedTools).toEqual(["Read", "Grep"]);
  });

  it("clamps agent allowedTools that are not in defaults", () => {
    const defaults = makeDefaults();
    const agentPerms: RolePermissions = {
      allowedTools: ["Read", "WebSearch"], // WebSearch not in defaults
    };
    const result = computeEffectivePermissions(defaults, agentPerms);

    expect(result.allowedTools).toEqual(["Read"]); // WebSearch filtered out
  });

  it("unions disallowedTools — both defaults and agent denials apply", () => {
    const defaults = makeDefaults();
    const agentPerms: RolePermissions = {
      disallowedTools: ["curl"],
    };
    const result = computeEffectivePermissions(defaults, agentPerms);

    expect(result.disallowedTools).toEqual(["rm", "curl"]);
  });

  it("takes most restrictive maxBudgetUsd (min)", () => {
    const defaults = makeDefaults();
    const agentPerms: RolePermissions = {
      maxBudgetUsd: 2.0,
    };
    const result = computeEffectivePermissions(defaults, agentPerms);

    expect(result.maxBudgetUsd).toBe(2.0);
  });

  it("clamps agent maxBudgetUsd that tries to escalate beyond defaults", () => {
    const defaults = makeDefaults();
    const agentPerms: RolePermissions = {
      maxBudgetUsd: 10.0, // higher than defaults 5.0
    };
    const result = computeEffectivePermissions(defaults, agentPerms);

    expect(result.maxBudgetUsd).toBe(5.0); // clamped to defaults
  });

  it("treats maxBudgetUsd=0 as inherit from defaults (not $0 budget)", () => {
    const defaults = makeDefaults();
    const agentPerms: RolePermissions = {
      maxBudgetUsd: 0, // 0 means "no override", inherit defaults
    };
    const result = computeEffectivePermissions(defaults, agentPerms);

    expect(result.maxBudgetUsd).toBe(5.0); // inherits defaults, not 0
  });

  it("unions approvalRequired", () => {
    const defaults = makeDefaults();
    const agentPerms: RolePermissions = {
      approvalRequired: ["npm publish"],
    };
    const result = computeEffectivePermissions(defaults, agentPerms);

    expect(result.approvalRequired).toEqual(["rm -rf", "git push", "npm publish"]);
  });

  it("unions plugins", () => {
    const defaults = makeDefaults();
    const agentPerms: RolePermissions = {
      plugins: ["plugin-b"],
    };
    const result = computeEffectivePermissions(defaults, agentPerms);

    expect(result.plugins).toEqual(["plugin-a", "plugin-b"]);
  });

  it("empty array [] restricts allowedTools to none", () => {
    const defaults = makeDefaults();
    const agentPerms: RolePermissions = {
      allowedTools: [], // explicitly restrict to no tools
    };
    const result = computeEffectivePermissions(defaults, agentPerms);

    expect(result.allowedTools).toEqual([]);
  });

  it("handles defaults with no plugins field", () => {
    const defaults = makeDefaults({ plugins: undefined });
    const agentPerms: RolePermissions = {
      plugins: ["plugin-x"],
    };
    const result = computeEffectivePermissions(defaults, agentPerms);

    expect(result.plugins).toEqual(["plugin-x"]);
  });

  it("handles defaults with empty allowedTools (no restriction)", () => {
    const defaults = makeDefaults({ allowedTools: [] });
    const agentPerms: RolePermissions = {
      allowedTools: ["Read", "Write"],
    };
    const result = computeEffectivePermissions(defaults, agentPerms);

    // defaults empty = no restriction, agent list used as-is
    expect(result.allowedTools).toEqual(["Read", "Write"]);
  });
});
