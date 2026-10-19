/**
 * Config-doc type model.
 *
 * The three exhaustive field-classification lists (`VERBATIM_FIELD_PATHS`,
 * `ENV_FIELD_PATHS`, `PORTABLE_INLINE_FIELD_PATHS`) together cover every
 * current `Role` / `TaskTemplate` / `TaskStep` field. A field present in a
 * live object but in NONE of the three lists triggers a fail-closed throw
 * at render time — this is the guard that catches future secret-bearing
 * schema additions before they leak.
 *
 * See `docs/02-architecture/config-doc-format.md` for the parser-first
 * format spec that these types implement.
 */

import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface ConfigDocHeader {
  schemaVersion: number;
  exportedAt: string; // ISO 8601
  templates: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string }>;
  dependencies: DependencyEntry[];
  placeholders: PlaceholderEntry[];
  ledgerOwners: string[];
}

export type DependencyKind = "plugin" | "skill" | "mcpServer";

export interface DependencyEntry {
  pluginId: string;
  source: string; // marketplace / install source, or "unknown"
  kind: DependencyKind;
}

export type PlaceholderKind = "channel" | "model" | "path" | "secret" | "env";

export interface PlaceholderEntry {
  name: string;
  kind: PlaceholderKind;
  boundField: string;
}

export interface AnchorBlock {
  id: string; // stable scope path, e.g. "role.<id>.cagPrompt"
  bytes: number; // byte length of verbatim content
  sha256: string; // lowercase hex
}

export interface ParsedConfigDoc {
  header: ConfigDocHeader;
  /**
   * Locate and byte-extract an anchor block by id. Throws on:
   * - missing id
   * - sha256 mismatch
   * - bytes length mismatch
   * - missing close marker
   */
  getAnchorBytes(id: string): Buffer;
  /** Inventory of every anchor id declared in the body. */
  anchorIds: string[];
}

export interface ConfigDoc {
  header: ConfigDocHeader;
  body: string; // raw text after the header yaml fence
}

// ---------------------------------------------------------------------------
// EXPORT_DIR resolver
// ---------------------------------------------------------------------------

/**
 * The single allowed export dir for config-docs. Read tools
 * (`read_config_doc`, anchor-ref params on `create_role` / `create_template`)
 * reject any `docPath` that does not resolve inside this dir.
 */
export function resolveExportDir(): string {
  const override = process.env.ADAM_CONFIG_EXPORT_DIR;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), ".adam", "config-exports");
}

/**
 * Convenience constant for tests / direct use. Callers that need a writable
 * override should use `resolveExportDir()`.
 */
export const EXPORT_DIR: string = resolveExportDir();

// ---------------------------------------------------------------------------
// Exhaustive field-classification lists
// ---------------------------------------------------------------------------
//
// These three lists TOGETHER cover every current `Role` / `TaskTemplate` /
// `TaskStep` field. A field present in a live object but in NONE of the
// three lists triggers a fail-closed throw at render time. This is the
// guard that catches future secret-bearing schema additions before they leak.
//
// `PORTABLE_INLINE_FIELD_PATHS` is an EXPLICIT ENUMERATION, never a default
// sink. The "all current fields are enumerated" invariant is locked by a
// unit test (Task 4: every key of a freshly-loaded podcast role/template/
// step is classified).
//
// Identity fields (`id`, `createdAt`, `updatedAt`, `memoryStreamId`,
// `sourceSessionId`) are re-minted on import and are NOT in any of the three
// lists — they are exported as metadata only, not reconstructed from the
// body.

/**
 * Verbatim fields — wrapped in anchor blocks. Content is opaque to the parser.
 */
export const VERBATIM_FIELD_PATHS = [
  "role.cagPrompt",
  "template.step.prompt",
  "template.step.persona.speakAs",
  "template.step.outputContract.customAssertions",
] as const;

/**
 * Env-specific fields — replaced with `${PLACEHOLDER}` and listed in the
 * header's `placeholders` manifest.
 */
export const ENV_FIELD_PATHS = [
  "template.step.deliverTo.channelId",
  "template.step.deliverTo.chatId",
  "template.step.deliverTo.sessionId",
  "template.step.reportTo.channelId",
  "template.step.reportTo.chatId",
  "template.step.reportTo.sessionId",
  "template.deliverTo.channelId",
  "template.deliverTo.chatId",
  "template.deliverTo.sessionId",
  "template.reportTo.channelId",
  "template.reportTo.chatId",
  "template.reportTo.sessionId",
  "role.additionalDirectories.path",
  "role.envVars.value",
  "role.mcpServers.value",
  "role.model",
  "template.config.env.value",
  // template.config carries the same credential-shaped sub-objects as the role
  // level — mcpServers values are secret-bearing and MUST be placeholdered
  // symmetrically (not serialized wholesale via canonicalize(config)).
  "template.config.mcpServers.value",
] as const;

/**
 * Portable inline fields — emitted as structured data in the body. This is
 * an EXPLICIT ENUMERATION, never a default sink.
 */
export const PORTABLE_INLINE_FIELD_PATHS = [
  // Role portable inline fields
  "role.name",
  "role.learnedRules",
  "role.preferences",
  "role.allowedTools",
  "role.disallowedTools",
  "role.evaluationCriteria",
  "role.executionMode",
  "role.maxBudgetUsd",
  "role.approvalRequired",
  "role.source",
  "role.allowedChannels",
  "role.inheritUserSettings",
  "role.permissionMode",
  "role.allowedBashPatterns",
  "role.deniedBashPatterns",
  "role.presetId",
  "role.osCapabilities",
  "role.effortTier",
  // `skills` is portable inline (handles the "all" sentinel explicitly)
  "role.skills",
  "role.memoryBudgetTokens",
  "role.status",
  "role.performanceScore",

  // TaskTemplate portable inline fields
  "template.name",
  "template.description",
  "template.trigger",
  "template.rolePreference",
  "template.config",
  "template.tags",
  "template.enabled",
  "template.goalIds",
  "template.retryPolicy",
  "template.isPreset",
  "template.presetId",

  // TaskStep portable inline fields
  "step.id",
  "step.dependsOn",
  "step.minDependencies",
  "step.outputAs",
  "step.roleId",
  "step.requirements",
  "step.autoSelectRole",
  "step.config",
  "step.consumesFrom",
  "step.consumesFromOptional",
  // `persona.voiceConstraints` is portable inline (free-text but NOT a verbatim
  // anchor — it's a style hint, not a contract-defining field)
  "step.persona.voiceConstraints",
  "step.outputContract.mustReferenceArtifacts",
  // `contractRules` is structured data, serialized inline
  "step.outputContract.contractRules",
  "step.assertions",
  "step.recordEditorScores",
  "step.candidateId",
  "step.briefPerturbation",
  "step.kind",
  // Ledger fields (Phase 1.5 / 2)
  "step.settlementLedgerOwner",
  "step.publishesClaimsTo",
  "step.settlesPredictionsFor",
  "step.openLedgerOwner",
  "step.openLedgerLookbackDays",
] as const;

/**
 * Identity / metadata-only fields that are NEVER reconstructed from the
 * body on import. These are exported as metadata only (e.g. in the header
 * inventories) and re-minted on import.
 *
 * They are NOT in any of the three lists above, which is correct: the lists
 * cover fields that DO flow into the export body's structured data or anchor
 * blocks. Identity fields are out of scope of the field-classification guard
 * because they are deliberately not in the body.
 */
export const IDENTITY_FIELD_PATHS = [
  "role.id",
  "role.createdAt",
  "role.updatedAt",
  "role.memoryStreamId",
  "template.id",
  "template.createdAt",
  "template.updatedAt",
  "template.sourceSessionId",
] as const;

// ---------------------------------------------------------------------------
// Fail-closed helpers
// ---------------------------------------------------------------------------

/** Entity kinds the exhaustiveness guard understands. */
export type ConfigDocEntity = "role" | "template" | "step";

/**
 * Structural container keys that are NOT classified field paths because they
 * are walked separately by the renderer (their children are classified).
 * `template.steps` is the array of steps — each step is rendered + guarded on
 * its own.
 */
const STRUCTURAL_CONTAINER_KEYS: Record<ConfigDocEntity, readonly string[]> = {
  role: [],
  template: ["steps"],
  step: [],
};

/**
 * Derive the set of KNOWN top-level keys for an entity from the four field
 * lists. The lists use mixed granularity/prefixes (`role.x`, `template.x`,
 * `template.step.x`, `step.x`, plus sub-paths like `role.envVars.value`); this
 * reduces every relevant entry to its top-level key under the entity.
 */
function knownTopLevelKeys(entity: ConfigDocEntity): Set<string> {
  const keys = new Set<string>(STRUCTURAL_CONTAINER_KEYS[entity]);
  const all = [
    ...VERBATIM_FIELD_PATHS,
    ...ENV_FIELD_PATHS,
    ...PORTABLE_INLINE_FIELD_PATHS,
    ...IDENTITY_FIELD_PATHS,
  ] as readonly string[];
  for (const p of all) {
    let rest: string | null = null;
    if (entity === "step") {
      if (p.startsWith("template.step.")) rest = p.slice("template.step.".length);
      else if (p.startsWith("step.")) rest = p.slice("step.".length);
    } else if (entity === "template") {
      // top-level template fields only — exclude the per-step namespace
      if (p.startsWith("template.") && !p.startsWith("template.step.")) {
        rest = p.slice("template.".length);
      }
    } else {
      if (p.startsWith("role.")) rest = p.slice("role.".length);
    }
    if (rest) keys.add(rest.split(".")[0].split("[")[0]);
  }
  return keys;
}

/** Machine-block region markers (F2 in the Phase 2 plan). */
export const MACHINE_OPEN = "<!-- adam:machine -->";
export const MACHINE_CLOSE = "<!-- /adam:machine -->";

/**
 * Anchor reference — points into the same doc's anchor blocks.
 * Used in the machine block for verbatim fields (cagPrompt, step.prompt,
 * persona.speakAs, customAssertions).
 */
export interface AnchorRef {
  __anchor: string;
}

/**
 * Portable structured config emitted in the machine block. This is the
 * single source of truth for the import path: every field the importer
 * needs to reconstruct a Role or Template (except verbatim bytes, which
 * come from anchor refs) lives here.
 */
export interface PortableConfig {
  templates: PortableTemplate[];
  roles: PortableRole[];
}

export interface PortableTemplate {
  sourceId: string;
  name: string;
  description?: string;
  trigger?: unknown;
  rolePreference?: string;
  config?: unknown;
  tags?: string[];
  enabled?: boolean;
  goalIds?: string[];
  retryPolicy?: { maxAttempts: number };
  isPreset?: boolean;
  presetId?: string;
  steps: PortableStep[];
}

export interface PortableStep {
  id: string;
  // Verbatim fields use AnchorRef.
  prompt: AnchorRef;
  persona?: {
    speakAs: AnchorRef;
    voiceConstraints?: string;
  };
  outputContract?: {
    mustReferenceArtifacts?: boolean;
    contractRules?: unknown[];
    customAssertions?: AnchorRef[];
  };
  dependsOn?: string[];
  minDependencies?: number;
  outputAs?: string;
  roleId: string;
  requirements?: unknown;
  autoSelectRole?: boolean;
  config?: unknown;
  consumesFrom?: string[];
  consumesFromOptional?: string[];
  assertions?: string[];
  recordEditorScores?: boolean;
  candidateId?: string;
  briefPerturbation?: { cross_domain_bucket: string | null; contrarian_source: string };
  kind?: string;
  settlementLedgerOwner?: string;
  publishesClaimsTo?: string;
  settlesPredictionsFor?: string;
  openLedgerOwner?: string;
  openLedgerLookbackDays?: number;
}

export interface PortableRole {
  sourceId: string;
  name: string;
  // Verbatim cagPrompt → AnchorRef
  cagPrompt: AnchorRef;
  // Portable inline fields
  learnedRules?: unknown;
  preferences?: unknown;
  allowedTools?: string[];
  disallowedTools?: string[];
  evaluationCriteria?: Record<string, number>;
  executionMode?: "isolated" | "inline";
  maxBudgetUsd?: number;
  approvalRequired?: string[];
  source?: "system" | "user";
  allowedChannels?: string[];
  inheritUserSettings?: boolean;
  permissionMode?: string;
  allowedBashPatterns?: string[];
  deniedBashPatterns?: string[];
  presetId?: string;
  osCapabilities?: Array<{ id: string; targets?: string[] }>;
  effortTier?: "low" | "medium" | "high";
  skills?: unknown;
  memoryBudgetTokens?: number;
  status?: string;
  performanceScore?: number;
  // Env fields (rendered as ${TOKEN} in the body; the JSON keeps them
  // as plain ${...} strings to keep the structure identical to runtime
  // values post-bind)
  model?: string;
  envVars?: Record<string, string>;
  additionalDirectories?: Array<{ path: string; mode?: "ro" | "rw" }>;
}

/**
 * Fail-closed exhaustiveness guard: throw if `obj` has any own enumerable key
 * (with a defined value) that is NOT a known top-level field of `entity`. This
 * is the wired drift guard — a future secret-bearing field added to the
 * Role/TaskTemplate/TaskStep schema trips this before it can silently leak or
 * be silently dropped. `undefined`-valued keys are ignored (absent fields).
 */
export function assertExhaustiveKeys(
  entity: ConfigDocEntity,
  obj: Record<string, unknown>,
): void {
  const known = knownTopLevelKeys(entity);
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) continue;
    if (!known.has(k)) {
      throw new Error(
        `config-doc: unclassified ${entity} field "${k}". ` +
          `Add "${entity}.${k}" (or its sub-paths) to a field list in ` +
          `src/store/config-doc/types.ts. ` +
          `Refusing to export to prevent silent schema-drift secret leaks.`,
      );
    }
  }
}
