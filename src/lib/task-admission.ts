import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import type {
  Role,
  TaskRequirements,
  TaskRequirementPath,
  AdmissionWarning,
  AdmissionFailure,
  AdmissionSuccess,
  AdmissionResult,
} from "../shared/types.js";
import { OS_CAPABILITY_IDS, type RoleOsCapability } from "../shared/os-capabilities.js";
import { getKnownToolNames } from "../shared/tools.js";
import { getRole, listRoles } from "../store/roles.js";
import { getRoleTaskTypePerformance } from "../store/role-scores.js";
import { ensureRoleWorkspace, getRoleWorkspacePath } from "../store/role-workspace.js";
import { resolveRolePluginCapabilities } from "./role-capabilities.js";
import { isSystemMcpTool } from "../manager/role-mcp-registry.js";

const KNOWN_TOOL_NAMES = new Set(getKnownToolNames());

export const TaskRequirementsSchema = z.object({
  tools: z.array(
    z.string().refine((tool) => KNOWN_TOOL_NAMES.has(tool), { message: "Unknown tool" }),
  ).optional(),
  paths: z.array(z.object({
    path: z.string().refine((p) => p.startsWith("/") || p.startsWith("~"), {
      message: "path must be absolute or tilde-prefixed",
    }),
    access: z.enum(["ro", "rw"]),
  })).optional(),
  osCapabilities: z.array(z.object({
    id: z.enum(OS_CAPABILITY_IDS),
    targets: z.array(z.string()).optional(),
  })).optional(),
  network: z.boolean().optional(),
  plugins: z.array(z.string()).optional(),
});

interface RoleScope {
  path: string;
  access: "ro" | "rw";
}

function resolveHomePath(raw: string): string {
  return raw.startsWith("~") ? raw.replace(/^~/, homedir()) : raw;
}

export function normalizeRequirementPath(raw: string): string | null {
  const tildeResolved = resolveHomePath(raw);
  if (!tildeResolved.startsWith("/")) return null;
  return resolvePath(tildeResolved);
}

export function resolveRoleScopes(role: Role, roleWorkspacePath: string): RoleScope[] {
  const scopes: RoleScope[] = [{ path: resolvePath(roleWorkspacePath), access: "rw" }];
  for (const dir of role.additionalDirectories ?? []) {
    scopes.push({
      path: resolvePath(resolveHomePath(dir.path)),
      access: dir.mode ?? "rw",
    });
  }
  return scopes;
}

export function pathCovered(req: TaskRequirementPath, scopes: RoleScope[]): boolean {
  const normalized = normalizeRequirementPath(req.path);
  if (!normalized) return false;
  const ancestors = scopes
    .filter((scope) => normalized === scope.path || normalized.startsWith(`${scope.path}/`))
    .sort((a, b) => b.path.length - a.path.length);
  if (ancestors.length === 0) return false;
  const winner = ancestors[0];
  if (req.access === "rw") return winner.access === "rw";
  return true;
}

export function toolsCovered(reqTools: string[] | undefined, roleAllowed: string[] | undefined): string[] {
  if (!reqTools?.length) return [];
  const allowed = new Set(roleAllowed ?? []);
  // A required tool is covered when it's explicitly in roleAllowed OR when it
  // belongs to a system-MCP namespace Adam injects on every task (see
  // SYSTEM_MCP_PREFIXES in role-mcp-registry.ts). Without this carve-out,
  // admission flags system-MCP-required tasks as missing tools even though
  // runtime would allow them.
  return reqTools.filter((tool) => !allowed.has(tool) && !isSystemMcpTool(tool));
}

export function osCapsCovered(
  req: RoleOsCapability[] | undefined,
  roleCaps: RoleOsCapability[] | undefined,
): RoleOsCapability[] {
  if (!req?.length) return [];
  const haveIds = new Set((roleCaps ?? []).map((cap) => cap.id));
  return req.filter((cap) => !haveIds.has(cap.id));
}

export function pluginsCovered(req: string[] | undefined, resolvedRolePlugins: string[]): string[] {
  if (!req?.length) return [];
  const have = new Set(resolvedRolePlugins);
  return req.filter((plugin) => !have.has(plugin));
}

export function networkCovered(req: boolean | undefined, roleCaps: RoleOsCapability[] | undefined): boolean {
  if (!req) return true;
  return (roleCaps ?? []).some((cap) => cap.id === "local-network");
}

export function computeFitScore(
  role: Role,
  reqs: TaskRequirements,
  scopes: RoleScope[],
  resolvedRolePlugins: string[],
): number {
  const dims: number[] = [];
  if (reqs.tools?.length) {
    const missing = toolsCovered(reqs.tools, role.allowedTools).length;
    dims.push((reqs.tools.length - missing) / reqs.tools.length);
  }
  if (reqs.paths?.length) {
    const covered = reqs.paths.filter((pathReq) => pathCovered(pathReq, scopes)).length;
    dims.push(covered / reqs.paths.length);
  }
  if (reqs.osCapabilities?.length) {
    const missing = osCapsCovered(reqs.osCapabilities, role.osCapabilities).length;
    dims.push((reqs.osCapabilities.length - missing) / reqs.osCapabilities.length);
  }
  if (reqs.plugins?.length) {
    const missing = pluginsCovered(reqs.plugins, resolvedRolePlugins).length;
    dims.push((reqs.plugins.length - missing) / reqs.plugins.length);
  }
  if (reqs.network === true) {
    dims.push(networkCovered(reqs.network, role.osCapabilities) ? 1 : 0);
  }
  if (dims.length === 0) return 1;
  return dims.reduce((sum, value) => sum + value, 0) / dims.length;
}

export function detectApprovalWarnings(role: Role, reqs: TaskRequirements): AdmissionWarning[] {
  if (!reqs.tools?.length || !role.approvalRequired?.length) return [];
  const approval = new Set(role.approvalRequired);
  const intersect = reqs.tools.filter((tool) => approval.has(tool));
  if (!intersect.length) return [];
  const pathCount = reqs.paths?.filter((pathReq) => pathReq.access === "rw").length ?? 0;
  return [{
    code: "APPROVAL_WILL_TRIGGER",
    tools: intersect,
    expectedPromptCount: Math.max(intersect.length, pathCount || intersect.length),
  }];
}

function buildMissingForRole(
  role: Role,
  reqs: TaskRequirements,
  scopes: RoleScope[],
  resolvedRolePlugins: string[],
): AdmissionFailure["missing"] {
  const missingTools = toolsCovered(reqs.tools, role.allowedTools);
  const missingPaths = (reqs.paths ?? []).filter((pathReq) => !pathCovered(pathReq, scopes));
  const missingOsCapabilities = osCapsCovered(reqs.osCapabilities, role.osCapabilities);
  const missingPlugins = pluginsCovered(reqs.plugins, resolvedRolePlugins);
  const out: AdmissionFailure["missing"] = {};
  if (missingTools.length) out.tools = missingTools;
  if (missingPaths.length) out.paths = missingPaths;
  if (missingOsCapabilities.length) out.osCapabilities = missingOsCapabilities;
  if (missingPlugins.length) out.plugins = missingPlugins;
  if (reqs.network === true && !networkCovered(reqs.network, role.osCapabilities)) out.network = true;
  return out;
}

function evaluateRoleForRequirements(role: Role, reqs: TaskRequirements): AdmissionResult {
  ensureRoleWorkspace(role);
  const roleCwd = getRoleWorkspacePath(role.name);
  const scopes = resolveRoleScopes(role, roleCwd);
  const pluginCaps = resolveRolePluginCapabilities(role);
  const resolvedRolePlugins = pluginCaps.plugins.map((plugin) => plugin.name);

  const missingTools = toolsCovered(reqs.tools, role.allowedTools);
  if (missingTools.length) {
    return { ok: false, code: "ROLE_TOOL_MISMATCH", reason: `Missing tools: ${missingTools.join(", ")}`, missing: { tools: missingTools } };
  }

  const missingPaths = (reqs.paths ?? []).filter((pathReq) => !pathCovered(pathReq, scopes));
  if (missingPaths.length) {
    return {
      ok: false,
      code: "ROLE_PATH_SCOPE_MISMATCH",
      reason: `Missing path scope: ${missingPaths.map((item) => `${item.path} (${item.access})`).join(", ")}`,
      missing: { paths: missingPaths },
    };
  }

  const missingOsCaps = osCapsCovered(reqs.osCapabilities, role.osCapabilities);
  if (missingOsCaps.length) {
    return {
      ok: false,
      code: "ROLE_OS_CAPABILITY_MISMATCH",
      reason: `Missing OS capabilities: ${missingOsCaps.map((item) => item.id).join(", ")}`,
      missing: { osCapabilities: missingOsCaps },
    };
  }

  const missingPlugins = pluginsCovered(reqs.plugins, resolvedRolePlugins);
  if (missingPlugins.length) {
    return {
      ok: false,
      code: "ROLE_PLUGIN_MISMATCH",
      reason: `Missing plugins: ${missingPlugins.join(", ")}`,
      missing: { plugins: missingPlugins },
    };
  }

  if (reqs.network === true && !networkCovered(reqs.network, role.osCapabilities)) {
    return {
      ok: false,
      code: "ROLE_NETWORK_MISMATCH",
      reason: "Role lacks network capability (local-network)",
      missing: { network: true },
    };
  }

  return {
    ok: true,
    roleId: role.id,
    executionProfile: role,
    fitScore: computeFitScore(role, reqs, scopes, resolvedRolePlugins),
    warnings: detectApprovalWarnings(role, reqs),
  };
}

export function rankRoles(reqs: TaskRequirements, taskType?: string): Array<{
  role: Role;
  evaluation: AdmissionResult;
  fitScore: number;
  missing?: AdmissionFailure["missing"];
}> {
  return listRoles("active", 100, 0)
    .filter((role) => role.source !== "system")
    .map((role) => {
      ensureRoleWorkspace(role);
      const scopes = resolveRoleScopes(role, getRoleWorkspacePath(role.name));
      const pluginCaps = resolveRolePluginCapabilities(role);
      const resolvedRolePlugins = pluginCaps.plugins.map((plugin) => plugin.name);
      const evaluation = evaluateRoleForRequirements(role, reqs);
      return {
        role,
        evaluation,
        fitScore: computeFitScore(role, reqs, scopes, resolvedRolePlugins),
        missing: buildMissingForRole(role, reqs, scopes, resolvedRolePlugins),
      };
    })
    .sort((a, b) => {
      const fitDiff = b.fitScore - a.fitScore;
      if (fitDiff !== 0) return fitDiff;
      // Secondary tiebreaker: per-task-type success rate (only if history exists)
      if (taskType) {
        const perfA = getRoleTaskTypePerformance(a.role.id, taskType);
        const perfB = getRoleTaskTypePerformance(b.role.id, taskType);
        if (perfA.totalTasks > 0 && perfB.totalTasks > 0) {
          const rateDiff = perfB.successRate - perfA.successRate;
          if (rateDiff !== 0) return rateDiff;
        }
        // Zero-history: skip task-type tiebreak, fall through to global performanceScore
      }
      return (b.role.performanceScore ?? 0) - (a.role.performanceScore ?? 0);
    });
}

export interface AdmitTaskInput {
  taskId: string;
  requirements?: TaskRequirements;
  roleId?: string;
  autoSelectRole?: boolean;
  /** Task type for per-task-type performance tiebreaking. */
  taskType?: string;
}

export async function admitTask(input: AdmitTaskInput): Promise<AdmissionResult> {
  const { requirements, roleId, autoSelectRole, taskType } = input;

  if (!roleId && !autoSelectRole) {
    return { ok: false, code: "REQUIREMENTS_MISSING", reason: "Must provide either roleId or autoSelectRole=true" };
  }

  if (requirements) {
    const parsed = TaskRequirementsSchema.safeParse(requirements);
    if (!parsed.success) {
      return { ok: false, code: "REQUIREMENTS_MISSING", reason: z.prettifyError(parsed.error) };
    }
  }

  if (autoSelectRole && !requirements) {
    return { ok: false, code: "REQUIREMENTS_MISSING", reason: "autoSelectRole requires a requirements object" };
  }

  const effectiveRequirements = requirements ?? {};

  if (roleId && !autoSelectRole) {
    const role = getRole(roleId);
    if (!role || role.status !== "active") {
      return { ok: false, code: "ROLE_NOT_FOUND", reason: `Role not found or not active: ${roleId}` };
    }
    const evaluation = evaluateRoleForRequirements(role, effectiveRequirements);
    if (!evaluation.ok) {
      if (requirements) {
        evaluation.candidates = rankRoles(requirements, taskType).map((item) => ({
          roleId: item.role.id,
          name: item.role.name,
          fitScore: item.fitScore,
          missing: item.missing,
        }));
      }
      return evaluation;
    }
    evaluation.auditCandidates = [{
      roleId: role.id,
      name: role.name,
      fitScore: evaluation.fitScore,
      fits: true,
    }];
    return evaluation;
  }

  const ranked = rankRoles(requirements!, taskType);
  const fits = ranked.filter((item) => item.evaluation.ok);
  if (!fits.length) {
    return {
      ok: false,
      code: "ROLE_SELECTION_AMBIGUOUS",
      reason: "No role covers the requirements",
      candidates: ranked.map((item) => ({
        roleId: item.role.id,
        name: item.role.name,
        fitScore: item.fitScore,
        missing: item.missing,
      })),
    };
  }

  const chosen = fits[0];
  const success = chosen.evaluation as AdmissionSuccess;
  const next = fits[1];
  if (next && next.fitScore === chosen.fitScore) {
    success.tieBreakReason = `fitScore tie at ${chosen.fitScore}; chose ${chosen.role.name} by performanceScore`;
  }
  success.auditCandidates = ranked.map((item) => ({
    roleId: item.role.id,
    name: item.role.name,
    fitScore: item.fitScore,
    fits: item.evaluation.ok,
  }));
  return success;
}
