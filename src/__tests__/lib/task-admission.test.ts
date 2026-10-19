import { describe, it, expect, vi, beforeEach } from "vitest";
import { homedir } from "node:os";
import type {
  Role,
  TaskRequirementPath,
} from "../../shared/types.js";
import type { RoleOsCapability } from "../../shared/os-capabilities.js";
import {
  normalizeRequirementPath,
  pathCovered,
  toolsCovered,
  osCapsCovered,
  computeFitScore,
  detectApprovalWarnings,
  admitTask,
  resolveRoleScopes,
  pluginsCovered,
  networkCovered,
} from "../../lib/task-admission.js";

// RoleScope is not exported — mirror the internal interface for local use
interface RoleScope {
  path: string;
  access: "ro" | "rw";
}
import { getRole, listRoles } from "../../store/roles.js";
import { ensureRoleWorkspace, getRoleWorkspacePath } from "../../store/role-workspace.js";
import { resolveRolePluginCapabilities } from "../../lib/role-capabilities.js";

vi.mock("../../store/roles.js");
vi.mock("../../store/role-workspace.js");
vi.mock("../../lib/role-capabilities.js");

const mockGetRole = vi.mocked(getRole);
const mockListRoles = vi.mocked(listRoles);
const mockEnsureRoleWorkspace = vi.mocked(ensureRoleWorkspace);
const mockGetRoleWorkspacePath = vi.mocked(getRoleWorkspacePath);
const mockResolveRolePluginCapabilities = vi.mocked(resolveRolePluginCapabilities);

const ROLE_WORKSPACE = "/home/.adam/roles/test-role";

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: "role-1",
    name: "TestRole",
    cagPrompt: "",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "ms-id",
    status: "active",
    preferences: {},
    createdAt: Date.now(),
    allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"],
    disallowedTools: [],
    source: "user",
    ...overrides,
  } as Role;
}

function makeScopes(roleWorkspacePath: string, additional?: RoleScope[]): RoleScope[] {
  const scopes: RoleScope[] = [{ path: roleWorkspacePath, access: "rw" }];
  if (additional) {
    for (const s of additional) {
      scopes.push(s);
    }
  }
  return scopes;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureRoleWorkspace.mockReturnValue("");
  mockGetRoleWorkspacePath.mockReturnValue(ROLE_WORKSPACE);
  mockResolveRolePluginCapabilities.mockReturnValue({ plugins: [] });
  mockListRoles.mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// normalizeRequirementPath
// ---------------------------------------------------------------------------

describe("normalizeRequirementPath", () => {
  it("returns normalized absolute path", () => {
    const result = normalizeRequirementPath("/Users/example/Code/InfoHub");
    expect(result).toBe("/Users/example/Code/InfoHub");
  });

  it("resolves tilde to homedir", () => {
    const result = normalizeRequirementPath("~/Documents");
    expect(result).toBe(`${homedir()}/Documents`);
  });

  it("returns null for relative paths", () => {
    expect(normalizeRequirementPath("relative/path")).toBeNull();
    expect(normalizeRequirementPath("relative")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pathCovered — longest-prefix wins
// ---------------------------------------------------------------------------

describe("pathCovered", () => {
  it("rw requirement covered by matching rw scope", () => {
    const req: TaskRequirementPath = { path: "/Users/example/Code", access: "rw" };
    const scopes: RoleScope[] = [{ path: "/Users/example/Code", access: "rw" }];
    expect(pathCovered(req, scopes)).toBe(true);
  });

  it("rw requirement NOT covered by ro scope at same level", () => {
    const req: TaskRequirementPath = { path: "/Users/example/Code", access: "rw" };
    const scopes: RoleScope[] = [{ path: "/Users/example/Code", access: "ro" }];
    expect(pathCovered(req, scopes)).toBe(false);
  });

  it("ro requirement covered by ro scope at same level", () => {
    const req: TaskRequirementPath = { path: "/Users/example/Code", access: "ro" };
    const scopes: RoleScope[] = [{ path: "/Users/example/Code", access: "ro" }];
    expect(pathCovered(req, scopes)).toBe(true);
  });

  // D-001 / Task 1 verification: child rw wins over parent ro
  it("child rw overrides parent ro — parent ro does NOT override child rw", () => {
    const req: TaskRequirementPath = { path: "/Users/example/Code/InfoHub/config.yaml", access: "rw" };
    const scopes: RoleScope[] = [
      { path: "/Users/example/Code", access: "ro" },
      { path: "/Users/example/Code/InfoHub", access: "rw" },
    ];
    // Longest-prefix match: InfoHub/rw satisfies InfoHub/config.yaml/rw requirement
    expect(pathCovered(req, scopes)).toBe(true);
  });

  it("child ro is still ro even if parent is rw", () => {
    const req: TaskRequirementPath = { path: "/Users/example/Code/InfoHub/secrets", access: "rw" };
    const scopes: RoleScope[] = [
      { path: "/Users/example/Code", access: "rw" },
      { path: "/Users/example/Code/InfoHub/secrets", access: "ro" },
    ];
    expect(pathCovered(req, scopes)).toBe(false);
  });

  it("returns false for unlisted path", () => {
    const req: TaskRequirementPath = { path: "/etc/passwd", access: "ro" };
    const scopes: RoleScope[] = [{ path: "/Users/example/Code", access: "rw" }];
    expect(pathCovered(req, scopes)).toBe(false);
  });

  it("returns false for relative requirement path", () => {
    const req: TaskRequirementPath = { path: "relative/path", access: "ro" };
    const scopes: RoleScope[] = [{ path: "/", access: "rw" }];
    expect(pathCovered(req, scopes)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toolsCovered
// ---------------------------------------------------------------------------

describe("toolsCovered", () => {
  it("returns empty array when no tools required", () => {
    expect(toolsCovered(undefined, ["Read", "Write"])).toEqual([]);
    expect(toolsCovered([], ["Read", "Write"])).toEqual([]);
  });

  it("returns missing tools not in role's allowed list", () => {
    const missing = toolsCovered(["Read", "Write", "Bash"], ["Read", "Grep"]);
    expect(missing).toEqual(["Write", "Bash"]);
  });

  it("returns empty when all required tools are allowed", () => {
    const missing = toolsCovered(["Read", "Grep"], ["Read", "Grep", "Write"]);
    expect(missing).toEqual([]);
  });

  // System-MCP carve-out: Adam-injected MCP tools are always considered covered
  // even when the role's allowedTools doesn't list them, because the canUseTool
  // gate auto-allows them at runtime (see role-mcp-registry.ts SYSTEM_MCP_PREFIXES).
  it("treats system MCP tools as covered even when role.allowedTools lacks them", () => {
    const missing = toolsCovered(
      ["mcp__execution-tools__publish_artifact_file"],
      ["WebSearch"],
    );
    expect(missing).toEqual([]);
  });

  it("returns only the non-system missing tools from a mixed list", () => {
    const missing = toolsCovered(
      ["mcp__execution-tools__write_artifact", "Bash", "mcp__audit-tools__aggregate_mistakes"],
      ["WebSearch"],
    );
    // System tools are filtered out by the carve-out; only "Bash" remains as missing.
    expect(missing).toEqual(["Bash"]);
  });
});

// ---------------------------------------------------------------------------
// osCapsCovered
// ---------------------------------------------------------------------------

describe("osCapsCovered", () => {
  it("returns empty when no capabilities required", () => {
    expect(osCapsCovered(undefined, [{ id: "automation" }])).toEqual([]);
    expect(osCapsCovered([], [{ id: "automation" }])).toEqual([]);
  });

  it("returns missing OS capabilities", () => {
    const missing = osCapsCovered(
      [{ id: "automation" }, { id: "microphone" }],
      [{ id: "automation" }],
    );
    expect(missing).toEqual([{ id: "microphone" }]);
  });
});

// ---------------------------------------------------------------------------
// pluginsCovered
// ---------------------------------------------------------------------------

describe("pluginsCovered", () => {
  it("returns empty when no plugins required", () => {
    expect(pluginsCovered(undefined, ["plugin-a"])).toEqual([]);
    expect(pluginsCovered([], ["plugin-a"])).toEqual([]);
  });

  it("returns missing plugins", () => {
    const missing = pluginsCovered(["plugin-a", "plugin-b"], ["plugin-a"]);
    expect(missing).toEqual(["plugin-b"]);
  });
});

// ---------------------------------------------------------------------------
// networkCovered
// ---------------------------------------------------------------------------

describe("networkCovered", () => {
  it("returns true when network not required", () => {
    expect(networkCovered(undefined, [])).toBe(true);
    expect(networkCovered(false, [])).toBe(true);
  });

  it("returns true when role has local-network capability", () => {
    expect(networkCovered(true, [{ id: "local-network" }])).toBe(true);
  });

  it("returns false when role lacks local-network", () => {
    expect(networkCovered(true, [])).toBe(false);
    expect(networkCovered(true, [{ id: "automation" }])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeFitScore
// ---------------------------------------------------------------------------

describe("computeFitScore", () => {
  it("returns 1 when no requirements", () => {
    const role = makeRole();
    const scopes = makeScopes(ROLE_WORKSPACE);
    // Empty requirements stay valid for Template and legacy callers.
    // New ChatManager dispatch tools (dispatch_to_role / dispatch_by_requirements)
    // reject empty requirements before admission — this function itself must not.
    expect(computeFitScore(role, {}, scopes, [])).toBe(1);
  });

  it("computes score from tool coverage", () => {
    const role = makeRole({ allowedTools: ["Read", "Grep"] });
    const scopes = makeScopes(ROLE_WORKSPACE);
    const reqs = { tools: ["Read", "Grep", "Bash"] };
    const score = computeFitScore(role, reqs, scopes, []);
    // 2/3 tools covered
    expect(score).toBeCloseTo(2 / 3, 2);
  });

  it("computes score from path coverage", () => {
    const role = makeRole();
    const scopes = makeScopes(ROLE_WORKSPACE);
    const reqs = { paths: [{ path: ROLE_WORKSPACE, access: "rw" as const }] };
    expect(computeFitScore(role, reqs, scopes, [])).toBe(1);
  });

  it("returns lower score when paths are missing", () => {
    const role = makeRole();
    const scopes = makeScopes(ROLE_WORKSPACE);
    const reqs = {
      paths: [
        { path: ROLE_WORKSPACE, access: "rw" as const },
        { path: "/etc/secret", access: "ro" as const },
      ],
    };
    // 1/2 paths covered
    expect(computeFitScore(role, reqs, scopes, [])).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// detectApprovalWarnings
// ---------------------------------------------------------------------------

describe("detectApprovalWarnings", () => {
  it("returns empty array when no tools required", () => {
    const role = makeRole({ approvalRequired: ["Bash"] });
    expect(detectApprovalWarnings(role, {})).toEqual([]);
  });

  it("returns empty when required tools are not in approvalRequired", () => {
    const role = makeRole({ approvalRequired: ["Bash"] });
    const reqs = { tools: ["Read", "Grep"] };
    expect(detectApprovalWarnings(role, reqs)).toEqual([]);
  });

  it("returns warning when required tool is in approvalRequired", () => {
    const role = makeRole({ approvalRequired: ["Bash", "Edit"] });
    const reqs = { tools: ["Bash", "Edit"] };
    const warnings = detectApprovalWarnings(role, reqs);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("APPROVAL_WILL_TRIGGER");
    expect(warnings[0].tools).toEqual(["Bash", "Edit"]);
  });

  it("warning includes write-path count when applicable", () => {
    const role = makeRole({ approvalRequired: ["Bash"] });
    const reqs = {
      tools: ["Bash"],
      paths: [{ path: "/tmp/foo", access: "rw" as const }],
    };
    const warnings = detectApprovalWarnings(role, reqs);
    expect(warnings).toHaveLength(1);
    // pathCount (1) vs tools (1) -> max is 1
    expect(warnings[0].expectedPromptCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// admitTask — unit tests via mocked stores
// ---------------------------------------------------------------------------

describe("admitTask", () => {
  it("requires either roleId or autoSelectRole", async () => {
    const result = await admitTask({ taskId: "t1", requirements: {} });
    expect(result.ok).toBe(false);
    expect((result as any).code).toBe("REQUIREMENTS_MISSING");
  });

  it("autoSelectRole requires requirements", async () => {
    const result = await admitTask({ taskId: "t1", autoSelectRole: true });
    expect(result.ok).toBe(false);
    expect((result as any).code).toBe("REQUIREMENTS_MISSING");
    expect((result as any).reason).toContain("autoSelectRole requires");
  });

  it("rejects unknown roleId with ROLE_NOT_FOUND", async () => {
    mockGetRole.mockReturnValue(undefined);
    const result = await admitTask({
      taskId: "t1",
      roleId: "nonexistent",
      requirements: { tools: ["Read"] },
    });
    expect(result.ok).toBe(false);
    expect((result as any).code).toBe("ROLE_NOT_FOUND");
  });

  it("rejects inactive role with ROLE_NOT_FOUND", async () => {
    mockGetRole.mockReturnValue(makeRole({ status: "inactive" }));
    const result = await admitTask({
      taskId: "t1",
      roleId: "role-1",
      requirements: { tools: ["Read"] },
    });
    expect(result.ok).toBe(false);
    expect((result as any).code).toBe("ROLE_NOT_FOUND");
  });

  it("admits compatible role and returns executionProfile", async () => {
    const role = makeRole({ allowedTools: ["Read", "Write", "Bash"] });
    mockGetRole.mockReturnValue(role);

    const result = await admitTask({
      taskId: "t1",
      roleId: "role-1",
      requirements: { tools: ["Read"] },
    });

    expect(result.ok).toBe(true);
    const success = result as any;
    expect(success.roleId).toBe("role-1");
    expect(success.executionProfile).toBeDefined();
    expect(success.fitScore).toBeGreaterThan(0);
    expect(success.auditCandidates).toHaveLength(1);
    expect(success.auditCandidates[0].fits).toBe(true);
  });

  it("returns ROLE_TOOL_MISMATCH with missing tools when tools not allowed", async () => {
    const role = makeRole({ allowedTools: ["Read"] });
    mockGetRole.mockReturnValue(role);

    const result = await admitTask({
      taskId: "t1",
      roleId: "role-1",
      requirements: { tools: ["Read", "Write", "Bash"] },
    });

    expect(result.ok).toBe(false);
    expect((result as any).code).toBe("ROLE_TOOL_MISMATCH");
    const failure = result as any;
    expect(failure.missing.tools).toEqual(["Write", "Bash"]);
  });

  it("returns ROLE_TOOL_MISMATCH with candidates when requirements provided", async () => {
    const role = makeRole({ allowedTools: ["Read"] });
    mockGetRole.mockReturnValue(role);

    // Make two roles available: one compatible, one not
    const compatibleRole = makeRole({ id: "role-2", name: "CompatibleRole", allowedTools: ["Read", "Write", "Bash"] });
    mockListRoles.mockReturnValue([compatibleRole]);

    const result = await admitTask({
      taskId: "t1",
      roleId: "role-1",
      requirements: { tools: ["Write", "Bash"] },
    });

    expect(result.ok).toBe(false);
    expect((result as any).code).toBe("ROLE_TOOL_MISMATCH");
    const failure = result as any;
    // Candidates should be ranked
    expect(failure.candidates).toBeDefined();
    expect(failure.candidates.length).toBeGreaterThan(0);
  });

  it("returns ROLE_PATH_SCOPE_MISMATCH when role lacks required paths", async () => {
    const role = makeRole();
    mockGetRole.mockReturnValue(role);

    const result = await admitTask({
      taskId: "t1",
      roleId: "role-1",
      requirements: { paths: [{ path: "/etc/secret", access: "ro" }] },
    });

    expect(result.ok).toBe(false);
    expect((result as any).code).toBe("ROLE_PATH_SCOPE_MISMATCH");
    const failure = result as any;
    expect(failure.missing.paths).toHaveLength(1);
    expect(failure.missing.paths[0].path).toBe("/etc/secret");
  });

  it("autoSelectRole picks highest fitScore role", async () => {
    const readOnlyRole = makeRole({ id: "r1", name: "ReadOnly", allowedTools: ["Read"] });
    const fullRole = makeRole({ id: "r2", name: "FullAccess", allowedTools: ["Read", "Write", "Bash", "Edit", "Grep"] });
    // Both satisfy requirements (Read is present in both), but FullAccess has higher coverage
    mockListRoles.mockReturnValue([readOnlyRole, fullRole]);

    const result = await admitTask({
      taskId: "t1",
      autoSelectRole: true,
      requirements: { tools: ["Read", "Grep"] },
    });

    expect(result.ok).toBe(true);
    const success = result as any;
    // FullAccess has better fitScore (2/2) vs ReadOnly (1/2)
    expect(success.roleId).toBe("r2");
    expect(success.auditCandidates).toHaveLength(2);
  });

  it("autoSelectRole tie-break uses performanceScore", async () => {
    const roleA = makeRole({ id: "rA", name: "RoleA", allowedTools: ["Read"], performanceScore: 0.5 });
    const roleB = makeRole({ id: "rB", name: "RoleB", allowedTools: ["Read"], performanceScore: 0.8 });
    mockListRoles.mockReturnValue([roleA, roleB]);

    const result = await admitTask({
      taskId: "t1",
      autoSelectRole: true,
      requirements: { tools: ["Read"] },
    });

    expect(result.ok).toBe(true);
    const success = result as any;
    expect(success.roleId).toBe("rB"); // higher performanceScore wins tie-break
    expect(success.tieBreakReason).toContain("performanceScore");
  });

  it("autoSelectRole returns ROLE_SELECTION_AMBIGUOUS when no role matches", async () => {
    const role = makeRole({ allowedTools: ["Read"] });
    mockListRoles.mockReturnValue([role]);

    const result = await admitTask({
      taskId: "t1",
      autoSelectRole: true,
      requirements: { tools: ["Write", "Bash"] },
    });

    expect(result.ok).toBe(false);
    expect((result as any).code).toBe("ROLE_SELECTION_AMBIGUOUS");
    const failure = result as any;
    expect(failure.candidates).toHaveLength(1);
    // Missing tools are recorded in the candidate's missing field
    expect(failure.candidates[0].missing?.tools).toEqual(["Write", "Bash"]);
  });

  it("includes approval warning when required tool is in role approvalRequired", async () => {
    const role = makeRole({ allowedTools: ["Read", "Write", "Bash"], approvalRequired: ["Bash"] });
    mockGetRole.mockReturnValue(role);

    const result = await admitTask({
      taskId: "t1",
      roleId: "role-1",
      requirements: { tools: ["Bash"] },
    });

    expect(result.ok).toBe(true);
    const success = result as any;
    expect(success.warnings).toHaveLength(1);
    expect(success.warnings[0].code).toBe("APPROVAL_WILL_TRIGGER");
  });

  it("rejects ROLE_OS_CAPABILITY_MISMATCH when role lacks required capability", async () => {
    const role = makeRole({ osCapabilities: [{ id: "automation" }] });
    mockGetRole.mockReturnValue(role);

    const result = await admitTask({
      taskId: "t1",
      roleId: "role-1",
      requirements: { osCapabilities: [{ id: "automation" }, { id: "microphone" }] },
    });

    expect(result.ok).toBe(false);
    expect((result as any).code).toBe("ROLE_OS_CAPABILITY_MISMATCH");
  });

  it("rejects ROLE_NETWORK_MISMATCH when network required but not available", async () => {
    const role = makeRole({ osCapabilities: [{ id: "automation" }] });
    mockGetRole.mockReturnValue(role);

    const result = await admitTask({
      taskId: "t1",
      roleId: "role-1",
      requirements: { network: true },
    });

    expect(result.ok).toBe(false);
    expect((result as any).code).toBe("ROLE_NETWORK_MISMATCH");
  });

  it("admits when network required and local-network capability present", async () => {
    const role = makeRole({ osCapabilities: [{ id: "local-network" }] });
    mockGetRole.mockReturnValue(role);

    const result = await admitTask({
      taskId: "t1",
      roleId: "role-1",
      requirements: { network: true },
    });

    expect(result.ok).toBe(true);
  });

  it("admits active role with empty requirements (legacy/Template compatibility)", async () => {
    const role = makeRole();
    mockGetRole.mockReturnValue(role);

    const result = await admitTask({
      taskId: "t1",
      roleId: "role-1",
      requirements: {},
    });

    // Empty requirements stay valid at admission layer.
    // New ChatManager dispatch tools reject empty requirements higher up.
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveRoleScopes
// ---------------------------------------------------------------------------

describe("resolveRoleScopes", () => {
  it("includes role workspace as rw scope", () => {
    const role = makeRole();
    const scopes = resolveRoleScopes(role, ROLE_WORKSPACE);
    expect(scopes).toContainEqual({ path: ROLE_WORKSPACE, access: "rw" });
  });

  it("maps additionalDirectories to scopes with mode", () => {
    const role = makeRole({
      additionalDirectories: [
        { path: "/Users/example/Code", mode: "ro" },
        { path: "~/Downloads", mode: "rw" },
      ],
    });
    const scopes = resolveRoleScopes(role, ROLE_WORKSPACE);
    expect(scopes).toHaveLength(3); // workspace + 2 additional dirs
    const codeScope = scopes.find((s) => s.path === "/Users/example/Code");
    expect(codeScope?.access).toBe("ro");
  });
});
