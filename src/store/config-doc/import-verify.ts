/**
 * Post-build structural + role-field verification for config-doc import.
 *
 * `verifyImportedConfig` is the deterministic, READ-ONLY check that runs
 * AFTER ChatManager has rebuilt a template + role set from a config-doc.
 * It compares the built entities against the doc's structural contract
 * (the parsed `PortableConfig`) and returns `{ok, mismatches[]}`.
 *
 * Per Phase 2 plan §Task 8-impl:
 *  - template: step count, `dependsOn` edges, `outputAs` set, each step
 *    `roleId` === roleIdMap[sourceStepRoleId] and resolves
 *  - roles: each built role's portable fields match the expected
 *    projection (model, skills, effortTier, learnedRules, …; same
 *    role.* set as Task 1's drift guard, EXCLUDING `role.mcpServers`
 *    per D-011)
 *  - both: no residual `${...}` token in built template or roles
 *
 * Read-only: never mutates the built entities. A failed verify leaves
 * state for inspection / idempotent re-run.
 *
 * The thin wrapper in `manager/adam-tools.ts` (`verify_imported_config`)
 * resolves `docPath` via `parsePortableConfig` and calls this function
 * with the parsed expected config.
 */
import { getRole } from "../roles.js";
import { getTaskTemplate } from "../task-templates.js";
import {
  PORTABLE_INLINE_FIELD_PATHS,
  ENV_FIELD_PATHS,
  type PortableConfig,
  type PortableRole,
  type PortableStep,
  type PortableTemplate,
} from "./types.js";
import type { Role, TaskStep, TaskTemplate } from "../../shared/types.js";

/**
 * Roles with the mcpServers field excluded from the import-restore
 * surface (D-011: runtime role MCP comes from `role_extensions`, the
 * `mcp_servers` column is dead; see Phase 2 plan "Out of scope /
 * follow-ups"). Listed explicitly so the exclusion can't silently
 * grow when a future field is added.
 */
// `name` is excluded because import targets a FRESH namespace: roles.name has a
// UNIQUE constraint, so importing into a populated DB MUST rename (the original
// name is taken). The dev-guide's structural-verification definition (step count,
// dependsOn edges, outputAs set, roleId wiring, placeholders bound) does NOT
// include name — name is the intentionally-fresh identity, not a fidelity field.
const ROLE_FIELD_EXCLUSIONS = new Set<string>(["mcpServers", "name"]);

/**
 * A single verification mismatch. `path` is a stable identifier
 * ("template.steps.step-shape.dependsOn", "role.role-w.skills", …)
 * so callers can branch on the failing item; `message` is the human
 * detail.
 */
export interface VerifyMismatch {
  path: string;
  message: string;
}

export interface VerifyResult {
  ok: boolean;
  mismatches: VerifyMismatch[];
}

export interface VerifyInput {
  /** Built template id (from the create_template call). */
  builtTemplateId: string;
  /** Built role ids (from the create_role calls). */
  builtRoleIds: string[];
  /** The doc's structural contract — `parsePortableConfig(text)`. */
  expected: PortableConfig;
  /**
   * Source-id → built-id map for roles. After import ChatManager mints
   * new role ids; the verifier remaps every step's source `roleId`
   * through this map and asserts the remapped id resolves via getRole.
   */
  roleIdMap: Record<string, string>;
}

const PLACEHOLDER_RE = /\$\{[^}]+\}/;

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

function collectResidualPlaceholders(value: unknown, out: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    const m = value.match(PLACEHOLDER_RE);
    if (m) out.push(...m);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectResidualPlaceholders(item, out);
    return;
  }
  if (typeof value === "object") {
    for (const k of Object.keys(value as Record<string, unknown>)) {
      collectResidualPlaceholders((value as Record<string, unknown>)[k], out);
    }
  }
}

/**
 * Derive the role top-level keys used for portable-field equality.
 * Mirrors the classification logic in `assertExhaustiveKeys` but
 * reduced to the verified portable role.* set.
 *
 * Env fields (model, envVars, additionalDirectories) are EXCLUDED
 * from the equality check: on export they were rendered as `${TOKEN}`
 * placeholders, on import they are bound to concrete values. Equality
 * across the placeholder → bound-value transition is meaningless; the
 * verifier's residual-placeholder scan separately asserts that no
 * `${...}` survived in the built role (a binding miss).
 *
 * `mcpServers` is excluded per D-011.
 */
function portableRoleTopLevelKeys(): Set<string> {
  const keys = new Set<string>();
  for (const p of [...PORTABLE_INLINE_FIELD_PATHS] as string[]) {
    if (!p.startsWith("role.")) continue;
    keys.add(p.slice("role.".length).split(".")[0].split("[")[0]);
  }
  return keys;
}

/**
 * Top-level env fields excluded from equality (see `portableRoleTopLevelKeys`
 * for the rationale). The residual-placeholder scan covers them separately.
 */
const ENV_ROLE_FIELDS = new Set<string>(["model", "envVars", "additionalDirectories"]);

/**
 * Compare a built role against the doc's expected portable role. The
 * `expected` projection is the parsed machine-block entry — verbatim
 * fields are anchor refs (not compared at the field level; the
 * `getAnchorBytes` byte-equality contract is enforced by the anchor
 * itself, not the verifier), env fields are now-bound strings (the
 * residual scan below catches an unbound `${TOKEN}`).
 *
 * `sourceId` is the doc's role identity (NOT a re-mapped new id). We
 * look it up in `expected.roles` by `sourceId`.
 */
function verifyRole(
  builtId: string,
  sourceId: string,
  expectedRoles: PortableRole[],
  mismatches: VerifyMismatch[],
): void {
  const expected = expectedRoles.find((r) => r.sourceId === sourceId);
  if (!expected) {
    mismatches.push({
      path: `role.${sourceId}`,
      message: `role.${sourceId}: no expected entry in doc (roleIdMap points to a role the doc does not declare)`,
    });
    return;
  }
  const built = getRole(builtId);
  if (!built) {
    mismatches.push({
      path: `role.${sourceId}`,
      message: `role.${sourceId} (built id ${builtId}): built role not found in DB`,
    });
    return;
  }
  const keys = portableRoleTopLevelKeys();
  for (const k of keys) {
    if (ROLE_FIELD_EXCLUSIONS.has(k)) continue;
    if (ENV_ROLE_FIELDS.has(k)) continue; // env → residual scan, not equality
    const expectedVal = (expected as unknown as Record<string, unknown>)[k];
    const builtVal = (built as unknown as Record<string, unknown>)[k];
    if (expectedVal === undefined) {
      // The source role didn't carry this field; skip.
      continue;
    }
    if (!deepEqual(builtVal, expectedVal)) {
      mismatches.push({
        path: `role.${sourceId}.${k}`,
        message: `role.${sourceId}.${k}: built value ${JSON.stringify(builtVal)} does not match expected ${JSON.stringify(expectedVal)}`,
      });
    }
  }
  // Residual-placeholder scan over the built role's serialised form
  const residual: string[] = [];
  collectResidualPlaceholders(built, residual);
  if (residual.length > 0) {
    mismatches.push({
      path: `role.${sourceId}.residual`,
      message: `role.${sourceId}: residual unbound placeholder(s) ${residual.join(", ")} — env was not bound at import time`,
    });
  }
}

function verifyTemplate(
  builtId: string,
  expectedTemplate: PortableTemplate,
  roleIdMap: Record<string, string>,
  expectedRoles: PortableRole[],
  mismatches: VerifyMismatch[],
): void {
  const built = getTaskTemplate(builtId);
  if (!built) {
    mismatches.push({
      path: `template.${expectedTemplate.sourceId}`,
      message: `template.${expectedTemplate.sourceId} (built id ${builtId}): built template not found in DB`,
    });
    return;
  }
  const expectedStepIds = new Set(expectedTemplate.steps.map((s) => s.id));
  const builtStepIds = new Set(built.steps.map((s) => s.id));

  // Step count + step id parity
  if (built.steps.length !== expectedTemplate.steps.length) {
    mismatches.push({
      path: `template.${expectedTemplate.sourceId}.steps`,
      message: `template.${expectedTemplate.sourceId}: built has ${built.steps.length} steps, expected ${expectedTemplate.steps.length}`,
    });
  }
  for (const id of expectedStepIds) {
    if (!builtStepIds.has(id)) {
      mismatches.push({
        path: `template.${expectedTemplate.sourceId}.steps.${id}`,
        message: `template.${expectedTemplate.sourceId}: expected step "${id}" is missing in built template`,
      });
    }
  }
  for (const id of builtStepIds) {
    if (!expectedStepIds.has(id)) {
      mismatches.push({
        path: `template.${expectedTemplate.sourceId}.steps.${id}`,
        message: `template.${expectedTemplate.sourceId}: built step "${id}" is not in the doc (extra step in built template)`,
      });
    }
  }

  // Per-step: dependsOn edges, outputAs, roleId
  for (const expectedStep of expectedTemplate.steps) {
    const builtStep = built.steps.find((s) => s.id === expectedStep.id);
    if (!builtStep) continue;
    verifyStep(expectedStep, builtStep, built, expectedRoles, roleIdMap, expectedTemplate.sourceId, mismatches);
  }

  // Residual-placeholder scan over the built template's serialised form
  const residual: string[] = [];
  collectResidualPlaceholders(built, residual);
  if (residual.length > 0) {
    mismatches.push({
      path: `template.${expectedTemplate.sourceId}.residual`,
      message: `template.${expectedTemplate.sourceId}: residual unbound placeholder(s) ${residual.join(", ")} — env was not bound at import time`,
    });
  }
}

function verifyStep(
  expected: PortableStep,
  built: TaskStep,
  builtTemplate: TaskTemplate,
  expectedRoles: PortableRole[],
  roleIdMap: Record<string, string>,
  tplSourceId: string,
  mismatches: VerifyMismatch[],
): void {
  // dependsOn parity (deep equal as sets of strings)
  const expectedDeps = expected.dependsOn ?? [];
  const builtDeps = built.dependsOn ?? [];
  if (!arraySetEqual(expectedDeps, builtDeps)) {
    mismatches.push({
      path: `template.${tplSourceId}.steps.${expected.id}.dependsOn`,
      message: `template.${tplSourceId}.steps.${expected.id}.dependsOn: built has ${JSON.stringify(builtDeps)}, expected ${JSON.stringify(expectedDeps)}`,
    });
  }
  // outputAs parity
  if ((expected.outputAs ?? null) !== (built.outputAs ?? null)) {
    mismatches.push({
      path: `template.${tplSourceId}.steps.${expected.id}.outputAs`,
      message: `template.${tplSourceId}.steps.${expected.id}.outputAs: built has ${JSON.stringify(built.outputAs)}, expected ${JSON.stringify(expected.outputAs)}`,
    });
  }
  // autoSelectRole steps have no fixed roleId — the runtime selects the role at
  // dispatch time (`roleId` is emitted as "" in the machine block). Skip roleId-wiring
  // verification; just assert the built step is also autoselect (a doc autoselect step
  // rebuilt as a fixed-role step is a mismatch).
  if (expected.autoSelectRole) {
    if (!built.autoSelectRole) {
      mismatches.push({
        path: `template.${tplSourceId}.steps.${expected.id}.autoSelectRole`,
        message: `template.${tplSourceId}.steps.${expected.id}: doc step uses autoSelectRole but built step does not`,
      });
    }
    void builtTemplate;
    return;
  }
  // roleId: remap source roleId via roleIdMap and assert it resolves to an
  // actual built role (and the role was declared in the doc).
  const remappedRoleId = roleIdMap[expected.roleId];
  if (!remappedRoleId) {
    mismatches.push({
      path: `template.${tplSourceId}.steps.${expected.id}.roleId`,
      message: `template.${tplSourceId}.steps.${expected.id}.roleId: source roleId "${expected.roleId}" is not in roleIdMap (dangling wiring)`,
    });
  } else if (built.roleId !== remappedRoleId) {
    mismatches.push({
      path: `template.${tplSourceId}.steps.${expected.id}.roleId`,
      message: `template.${tplSourceId}.steps.${expected.id}.roleId: built has roleId "${built.roleId}", expected remapped id "${remappedRoleId}" for source "${expected.roleId}"`,
    });
  } else {
    // The remapped roleId must resolve to a real role + be in the doc.
    const resolved = getRole(remappedRoleId);
    if (!resolved) {
      mismatches.push({
        path: `template.${tplSourceId}.steps.${expected.id}.roleId`,
        message: `template.${tplSourceId}.steps.${expected.id}.roleId: remapped roleId "${remappedRoleId}" does not resolve via getRole`,
      });
    } else {
      const sourceDeclared = expectedRoles.find((r) => r.sourceId === expected.roleId);
      if (!sourceDeclared) {
        mismatches.push({
          path: `template.${tplSourceId}.steps.${expected.id}.roleId`,
          message: `template.${tplSourceId}.steps.${expected.id}.roleId: source roleId "${expected.roleId}" not declared in doc roles[]`,
        });
      }
    }
  }
  // Reference builtTemplate so the parameter is intentionally consumed
  // (kept for future per-template-level field checks without changing
  // the call site).
  void builtTemplate;
}

function arraySetEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const v of b) if (!sa.has(v)) return false;
  return true;
}

/**
 * Verify a freshly built template + role set against the doc's
 * structural contract. Read-only. Returns `{ok, mismatches[]}`.
 *
 * - `ok = mismatches.length === 0`
 * - Each `mismatches[]` entry names the exact step/edge/key/role-field
 *   (`path`) and a human-readable detail (`message`).
 */
export function verifyImportedConfig(input: VerifyInput): VerifyResult {
  const mismatches: VerifyMismatch[] = [];

  if (input.expected.templates.length !== 1) {
    mismatches.push({
      path: "expected.templates",
      message: `expected.templates: verifier expects exactly 1 template per call, got ${input.expected.templates.length}`,
    });
  }
  if (input.expected.templates.length > 0) {
    verifyTemplate(
      input.builtTemplateId,
      input.expected.templates[0]!,
      input.roleIdMap,
      input.expected.roles,
      mismatches,
    );
  }

  // Role-field verification: for each built role, find the doc's
  // source role id via the inverse roleIdMap.
  const inverseMap: Record<string, string> = {};
  for (const [src, built] of Object.entries(input.roleIdMap)) {
    inverseMap[built] = src;
  }
  for (const builtId of input.builtRoleIds) {
    const sourceId = inverseMap[builtId];
    if (!sourceId) {
      mismatches.push({
        path: `role.${builtId}`,
        message: `built role id "${builtId}" is not in roleIdMap (built role not traced to a doc source)`,
      });
      continue;
    }
    verifyRole(builtId, sourceId, input.expected.roles, mismatches);
  }

  return { ok: mismatches.length === 0, mismatches };
}
