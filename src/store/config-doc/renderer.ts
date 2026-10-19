/**
 * Config-doc renderer.
 *
 * Deterministic, read-only renderer that turns a set of template ids into a
 * config-doc text conforming to `docs/02-plarchitecture/config-doc-format.md`.
 *
 * Pipeline:
 *  1. Load templates via `getTaskTemplate`.
 *  2. Walk closure: explicit step.roleId, autoSelectRole.${ROLE_AUTOSELECT_<stepId>}
 *     placeholder, and template.rolePreference fallback.
 *  3. Dedupe roles by id.
 *  4. Build the three manifests (dependency, placeholder, ledger owners).
 *  5. For each role/template/step object, run `assertExhaustiveKeys` (the wired
 *     fail-closed drift guard): any top-level field not covered by the four
 *     classification lists in `types.ts` throws before anything is emitted.
 *     Fields then render by category:
 *       - VERBATIM_FIELD_PATHS → anchor block (byte length + sha256)
 *       - ENV_FIELD_PATHS → ${NAME} (name looked up from the placeholder
 *         manifest — the manifest is the single source of truth for names)
 *       - PORTABLE_INLINE_FIELD_PATHS → structured inline data
 *  6. Reuse `canonicalize` for stable inline JSON and
 *     `computeVersionedProjection` for the template scalar projection.
 *  7. Emit header (yaml fence) + body. The placeholder manifest is built ONCE
 *     and shared by header + body so every body `${NAME}` has a header entry.
 *  8. Final credential guard (Option A): assert no CREDENTIAL-shaped value
 *     survives in the HEADER + INLINE region (anchor content excluded). Env
 *     paths / model / channel ids are placeholdered in their designated fields
 *     but tolerated inside free-text (learnedRules / allowedBashPatterns) — only
 *     credential-shaped values block export. See `assertNoCredentialsLeaked`.
 *
 * Fail-closed: a field on Role/TaskTemplate/TaskStep not present in any
 * classification list throws (`assertExhaustiveKeys` in `types.ts`).
 */
import { createHash } from "node:crypto";

import { canonicalize, computeVersionedProjection } from "../template-versions.js";
import { getRole } from "../roles.js";
import { getTaskTemplate } from "../task-templates.js";
import { getDb } from "../db.js";
import type { Role, TaskStep, TaskTemplate } from "../../shared/types.js";

import {
  buildDependencyManifest,
  buildPlaceholderManifest,
  collectLedgerOwners,
} from "./manifest.js";
import { assertExhaustiveKeys, MACHINE_OPEN, MACHINE_CLOSE } from "./types.js";
import type {
  AnchorRef,
  DependencyEntry,
  PlaceholderEntry,
  PortableConfig,
  PortableRole,
  PortableTemplate,
  PortableStep,
} from "./types.js";

// ---------------------------------------------------------------------------
// Placeholder name lookup — the manifest is the SINGLE SOURCE OF TRUTH for
// placeholder names. The renderer never invents a name; it looks one up by the
// exact boundField it is emitting. A miss is a fail-closed bug (a body token
// with no manifest entry would be unresolvable on re-import).
// ---------------------------------------------------------------------------

function makePlaceholderLookup(placeholders: PlaceholderEntry[]): (boundField: string) => string {
  const byField = new Map<string, string>();
  for (const p of placeholders) byField.set(p.boundField, p.name);
  return (boundField: string): string => {
    const name = byField.get(boundField);
    if (!name) {
      throw new Error(
        `config-doc: no placeholder manifest entry for boundField "${boundField}". ` +
          `Renderer and manifest disagree — refusing to emit an unresolvable token.`,
      );
    }
    return name;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function getSchemaVersion(): number {
  const row = getDb()
    .prepare("SELECT schema_version FROM server_state WHERE id = 1")
    .get() as { schema_version: number } | undefined;
  return row?.schema_version ?? 0;
}

// ---------------------------------------------------------------------------
// Closure walk
// ---------------------------------------------------------------------------

interface ClosureResult {
  templates: TaskTemplate[];
  roles: Map<string, Role>;
  /** Step IDs that used `autoSelectRole` (cannot be deterministically resolved). */
  autoSelectStepIds: string[];
  /** Plain list of `template.rolePreference` ids (may or may not exist in roles). */
  rolePreferenceIds: string[];
}

function walkClosure(templateIds: string[]): ClosureResult {
  const templates: TaskTemplate[] = [];
  const roles = new Map<string, Role>();
  const autoSelectStepIds: string[] = [];
  const rolePreferenceIds: string[] = [];

  for (const tid of templateIds) {
    const t = getTaskTemplate(tid);
    if (!t) {
      throw new Error(`config-doc: template "${tid}" not found`);
    }
    templates.push(t);
    if (t.rolePreference) rolePreferenceIds.push(t.rolePreference);
    for (const step of t.steps) {
      if (step.roleId) {
        if (!roles.has(step.roleId)) {
          const r = getRole(step.roleId);
          if (r) roles.set(step.roleId, r);
        }
      }
      if (step.autoSelectRole) {
        autoSelectStepIds.push(step.id);
        // requirements are not a concrete role — record the step id, do NOT
        // attempt to invent a role. The placeholder manifest does not
        // include autoSelect (it is a runtime decision, not a secret).
      }
    }
  }
  // Also resolve rolePreference ids (if they exist in the roles table)
  for (const rid of rolePreferenceIds) {
    if (!roles.has(rid)) {
      const r = getRole(rid);
      if (r) roles.set(rid, r);
    }
  }

  return { templates, roles, autoSelectStepIds, rolePreferenceIds };
}

// ---------------------------------------------------------------------------
// Anchor block emission
// ---------------------------------------------------------------------------

function emitAnchor(scope: string, content: string): string {
  const buf = Buffer.from(content, "utf8");
  const bytes = buf.length;
  const sha = sha256Hex(buf);
  // The anchor block format the parser expects:
  //   <!-- adam:field id="<scope>" bytes="<n>" sha256="<hex>" -->
  //   <exactly n bytes>
  //   <!-- /adam:field id="<scope>" -->
  return (
    `<!-- adam:field id="${scope}" bytes="${bytes}" sha256="${sha}" -->\n` +
    buf.toString("utf8") +
    `\n<!-- /adam:field id="${scope}" -->`
  );
}

// ---------------------------------------------------------------------------
// Field-by-field role render
// ---------------------------------------------------------------------------

function renderRoleSection(role: Role, phName: (boundField: string) => string): string {
  // Fail-closed drift guard: any unknown top-level key throws before we emit.
  assertExhaustiveKeys("role", role as unknown as Record<string, unknown>);
  const lines: string[] = [];
  lines.push(`## role ${role.id}`);
  // Identity / metadata (NOT classified — recorded as metadata)
  lines.push(`name: ${JSON.stringify(role.name)}`);
  // VERBATIM: cagPrompt
  lines.push("cagPrompt:");
  lines.push(emitAnchor(`role.${role.id}.cagPrompt`, role.cagPrompt ?? ""));
  // PORTABLE_INLINE (exhaustive enumeration)
  lines.push(`learnedRules: ${canonicalize(role.learnedRules ?? {})}`);
  lines.push(`preferences: ${canonicalize(role.preferences ?? {})}`);
  if (role.allowedTools) lines.push(`allowedTools: ${canonicalize(role.allowedTools)}`);
  if (role.disallowedTools) lines.push(`disallowedTools: ${canonicalize(role.disallowedTools)}`);
  if (role.evaluationCriteria) lines.push(`evaluationCriteria: ${canonicalize(role.evaluationCriteria)}`);
  if (role.executionMode) lines.push(`executionMode: ${JSON.stringify(role.executionMode)}`);
  if (typeof role.maxBudgetUsd === "number") lines.push(`maxBudgetUsd: ${role.maxBudgetUsd}`);
  if (role.approvalRequired) lines.push(`approvalRequired: ${canonicalize(role.approvalRequired)}`);
  if (role.source) lines.push(`source: ${JSON.stringify(role.source)}`);
  if (role.allowedChannels) lines.push(`allowedChannels: ${canonicalize(role.allowedChannels)}`);
  if (role.inheritUserSettings !== undefined) lines.push(`inheritUserSettings: ${role.inheritUserSettings}`);
  if (role.permissionMode) lines.push(`permissionMode: ${JSON.stringify(role.permissionMode)}`);
  if (role.allowedBashPatterns) lines.push(`allowedBashPatterns: ${canonicalize(role.allowedBashPatterns)}`);
  if (role.deniedBashPatterns) lines.push(`deniedBashPatterns: ${canonicalize(role.deniedBashPatterns)}`);
  if (role.presetId) lines.push(`presetId: ${JSON.stringify(role.presetId)}`);
  if (role.osCapabilities) lines.push(`osCapabilities: ${canonicalize(role.osCapabilities)}`);
  if (role.effortTier) lines.push(`effortTier: ${JSON.stringify(role.effortTier)}`);
  // skills is portable inline (handle "all" sentinel explicitly — it's a string)
  lines.push(`skills: ${canonicalize(role.skills ?? [])}`);
  if (typeof role.memoryBudgetTokens === "number") lines.push(`memoryBudgetTokens: ${role.memoryBudgetTokens}`);
  if (role.status) lines.push(`status: ${JSON.stringify(role.status)}`);
  if (typeof role.performanceScore === "number") lines.push(`performanceScore: ${role.performanceScore}`);
  // ENV: model, additionalDirectories.path, envVars values, mcpServers values
  // Each becomes a ${PLACEHOLDER} token; the actual values are recorded in
  // the placeholder manifest. The header manifest is the source of truth.
  if (role.model) {
    lines.push(`model: \${${phName(`role.${role.id}.model`)}}`);
  }
  if (role.additionalDirectories) {
    role.additionalDirectories.forEach((d, i) => {
      if (d?.path) lines.push(`additionalDirectories[${i}].path: \${${phName(`role.${role.id}.additionalDirectories[${i}].path`)}}`);
    });
  }
  if (role.envVars) {
    for (const k of Object.keys(role.envVars)) {
      lines.push(`envVars.${k}: \${${phName(`role.${role.id}.envVars.${k}`)}}`);
    }
  }
  if (role.mcpServers) {
    for (const k of Object.keys(role.mcpServers)) {
      lines.push(`mcpServers.${k}: \${${phName(`role.${role.id}.mcpServers.${k}`)}}`);
    }
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Field-by-field template render
// ---------------------------------------------------------------------------

function renderTemplateSection(t: TaskTemplate, phName: (boundField: string) => string): string {
  // Fail-closed drift guard for the template object (steps walked separately below).
  assertExhaustiveKeys("template", t as unknown as Record<string, unknown>);
  const lines: string[] = [];
  lines.push(`## template ${t.id}`);
  // Use the canonicalized versioned projection for the structured inline
  // data — the renderer treats the scalar projection as the source of truth.
  const projection = computeVersionedProjection(t);
  // Serialize the projection's structured fields. The projection omits volatile
  // bookkeeping (last_run_at) but keeps all the content fields the user cares
  // about. Inline structured data:
  lines.push(`name: ${JSON.stringify(projection.name)}`);
  if (projection.description) lines.push(`description: ${JSON.stringify(projection.description)}`);
  lines.push(`trigger: ${canonicalize(projection.trigger)}`);
  if (projection.rolePreference) lines.push(`rolePreference: ${JSON.stringify(projection.rolePreference)}`);
  if (projection.config) {
    // Strip the secret-bearing sub-objects (`env`, `mcpServers`) before
    // canonicalizing — their values are emitted as ${PLACEHOLDER} tokens below.
    // Serializing them wholesale via canonicalize(config) would leak credentials.
    const configSansSecrets = { ...projection.config } as Record<string, unknown>;
    delete configSansSecrets.env;
    delete configSansSecrets.mcpServers;
    if (Object.keys(configSansSecrets).length > 0) {
      lines.push(`config: ${canonicalize(configSansSecrets)}`);
    }
  }
  if (projection.tags) lines.push(`tags: ${canonicalize(projection.tags)}`);
  lines.push(`enabled: ${t.enabled ?? true}`);
  if (t.goalIds) lines.push(`goalIds: ${canonicalize(t.goalIds)}`);
  if (t.retryPolicy) lines.push(`retryPolicy: ${canonicalize(t.retryPolicy)}`);
  if (t.isPreset) lines.push(`isPreset: ${t.isPreset}`);
  if (t.presetId) lines.push(`presetId: ${JSON.stringify(t.presetId)}`);
  // ENV: deliverTo / reportTo
  for (const list of ["deliverTo", "reportTo"] as const) {
    const targets = t[list];
    if (!targets) continue;
    targets.forEach((it: any, i) => {
      if (it.type === "channel") {
        if (it.channelId) lines.push(`${list}[${i}].channelId: \${${phName(`template.${t.id}.${list}[${i}].channelId`)}}`);
        if (it.chatId) lines.push(`${list}[${i}].chatId: \${${phName(`template.${t.id}.${list}[${i}].chatId`)}}`);
      } else if (it.type === "session" && it.sessionId) {
        lines.push(`${list}[${i}].sessionId: \${${phName(`template.${t.id}.${list}[${i}].sessionId`)}}`);
      }
    });
  }
  if (t.config?.env) {
    for (const k of Object.keys(t.config.env)) {
      lines.push(`config.env.${k}: \${${phName(`template.${t.id}.config.env.${k}`)}}`);
    }
  }
  if (t.config?.mcpServers) {
    for (const k of Object.keys(t.config.mcpServers as Record<string, unknown>)) {
      lines.push(`config.mcpServers.${k}: \${${phName(`template.${t.id}.config.mcpServers.${k}`)}}`);
    }
  }
  // Steps
  for (const step of t.steps) {
    // Fail-closed drift guard per step.
    assertExhaustiveKeys("step", step as unknown as Record<string, unknown>);
    lines.push(`\n### step ${step.id}`);
    // VERBATIM: prompt
    lines.push("prompt:");
    lines.push(emitAnchor(`template.${t.id}.step.${step.id}.prompt`, step.prompt ?? ""));
    // Inline step fields
    lines.push(`id: ${JSON.stringify(step.id)}`);
    if (step.dependsOn) lines.push(`dependsOn: ${canonicalize(step.dependsOn)}`);
    if (typeof step.minDependencies === "number") lines.push(`minDependencies: ${step.minDependencies}`);
    if (step.outputAs) lines.push(`outputAs: ${JSON.stringify(step.outputAs)}`);
    if (step.roleId) lines.push(`roleId: ${JSON.stringify(step.roleId)}`);
    if (step.requirements) lines.push(`requirements: ${canonicalize(step.requirements)}`);
    if (step.autoSelectRole) lines.push(`autoSelectRole: true`);
    if (step.config) lines.push(`config: ${canonicalize(step.config)}`);
    if (step.consumesFrom) lines.push(`consumesFrom: ${canonicalize(step.consumesFrom)}`);
    if (step.consumesFromOptional) lines.push(`consumesFromOptional: ${canonicalize(step.consumesFromOptional)}`);
    if (step.persona?.speakAs) {
      // VERBATIM: persona.speakAs
      lines.push("persona.speakAs:");
      lines.push(emitAnchor(`template.${t.id}.step.${step.id}.persona.speakAs`, step.persona.speakAs));
    }
    if (step.persona?.voiceConstraints) {
      lines.push(`persona.voiceConstraints: ${JSON.stringify(step.persona.voiceConstraints)}`);
    }
    if (step.outputContract) {
      if (step.outputContract.mustReferenceArtifacts !== undefined) {
        lines.push(`outputContract.mustReferenceArtifacts: ${step.outputContract.mustReferenceArtifacts}`);
      }
      if (step.outputContract.contractRules) {
        lines.push(`outputContract.contractRules: ${canonicalize(step.outputContract.contractRules)}`);
      }
      if (step.outputContract.customAssertions && step.outputContract.customAssertions.length > 0) {
        // VERBATIM: customAssertions — each is its own anchor block to keep
        // each assertion byte-exact. Use index-suffixed scope.
        for (let i = 0; i < step.outputContract.customAssertions.length; i++) {
          const ca = step.outputContract.customAssertions[i];
          lines.push(`outputContract.customAssertions[${i}]:`);
          lines.push(emitAnchor(
            `template.${t.id}.step.${step.id}.outputContract.customAssertions[${i}]`,
            ca,
          ));
        }
      }
    }
    if (step.assertions) lines.push(`assertions: ${canonicalize(step.assertions)}`);
    if (step.recordEditorScores) lines.push(`recordEditorScores: ${step.recordEditorScores}`);
    if (step.candidateId) lines.push(`candidateId: ${JSON.stringify(step.candidateId)}`);
    if (step.briefPerturbation) lines.push(`briefPerturbation: ${canonicalize(step.briefPerturbation)}`);
    if (step.kind) lines.push(`kind: ${JSON.stringify(step.kind)}`);
    // Ledger fields (portable inline)
    for (const f of [
      "settlementLedgerOwner",
      "publishesClaimsTo",
      "settlesPredictionsFor",
      "openLedgerOwner",
    ] as const) {
      const v = (step as any)[f];
      if (typeof v === "string" && v.length > 0) {
        lines.push(`${f}: ${JSON.stringify(v)}`);
      }
    }
    if (typeof step.openLedgerLookbackDays === "number") {
      lines.push(`openLedgerLookbackDays: ${step.openLedgerLookbackDays}`);
    }
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Header assembly
// ---------------------------------------------------------------------------

function renderHeader(
  templates: TaskTemplate[],
  roles: Role[],
  autoSelectStepIds: string[],
  rolePreferenceIds: string[],
  dependencies: DependencyEntry[],
  placeholders: PlaceholderEntry[],
  ledgerOwners: string[],
): string {
  const schemaVersion = getSchemaVersion();
  const exportedAt = new Date().toISOString();

  const lines: string[] = [];
  lines.push("```yaml");
  lines.push(`schema_version: ${schemaVersion}`);
  lines.push(`exported_at: ${JSON.stringify(exportedAt)}`);
  lines.push("templates:");
  for (const t of templates) {
    lines.push(`  - id: ${JSON.stringify(t.id)}`);
    lines.push(`    name: ${JSON.stringify(t.name)}`);
  }
  lines.push("roles:");
  for (const r of roles.values()) {
    lines.push(`  - id: ${JSON.stringify(r.id)}`);
    lines.push(`    name: ${JSON.stringify(r.name)}`);
  }
  lines.push("dependencies:");
  if (dependencies.length === 0) lines.push("  []");
  else {
    for (const d of dependencies) {
      lines.push(`  - pluginId: ${JSON.stringify(d.pluginId)}`);
      lines.push(`    source: ${JSON.stringify(d.source)}`);
      lines.push(`    kind: ${JSON.stringify(d.kind)}`);
    }
  }
  lines.push("placeholders:");
  if (placeholders.length === 0) lines.push("  []");
  else {
    for (const p of placeholders) {
      lines.push(`  - name: ${JSON.stringify(p.name)}`);
      lines.push(`    kind: ${JSON.stringify(p.kind)}`);
      lines.push(`    boundField: ${JSON.stringify(p.boundField)}`);
    }
  }
  lines.push("ledger_owners:");
  if (ledgerOwners.length === 0) lines.push("  []");
  else for (const o of ledgerOwners) lines.push(`  - ${JSON.stringify(o)}`);
  // Auxiliary metadata (not parsed by the header parser into the typed header,
  // but useful for human readers and for round-trip sanity checks)
  if (autoSelectStepIds.length > 0) {
    lines.push("auto_select_step_ids:");
    for (const sid of autoSelectStepIds) lines.push(`  - ${JSON.stringify(sid)}`);
  }
  if (rolePreferenceIds.length > 0) {
    lines.push("role_preference_ids:");
    for (const rid of rolePreferenceIds) lines.push(`  - ${JSON.stringify(rid)}`);
  }
  lines.push("```");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Final secret guard
// ---------------------------------------------------------------------------

/**
 * Heuristic: does a value look like a CREDENTIAL (API key / token / secret)
 * rather than a benign config value? The backstop hard-fails only on these.
 *
 * Per the secret model (decision 2026-06-07, Option A — credentials-only
 * hard-fail): env-specific PATHS, model names, and channel ids are placeholdered
 * in their designated fields but are tolerated if they recur inside free-text
 * fields (learnedRules, allowedBashPatterns). Only credential-shaped values are
 * dangerous enough to block export. This also avoids substring false-positives
 * on short/benign env values (e.g. a numeric budget "20000", a workspace name
 * "Health Insights").
 */
const CREDENTIAL_PREFIXES = /(sk-|gk_|ntn_|ghp_|gho_|github_pat_|xox[bpas]-|AIza|ya29\.|Bearer |aws_|AKIA)/;

export function looksLikeCredential(v: string): boolean {
  if (typeof v !== "string") return false;
  if (CREDENTIAL_PREFIXES.test(v)) return true;
  // High-entropy token shape: long, mixes letters with digits/symbols, not prose.
  if (v.length < 16) return false;
  if (/^\d+$/.test(v)) return false; // pure number (e.g. a budget)
  if (/\s/.test(v.trim())) return false; // contains internal whitespace → prose, not a token
  return /[A-Za-z]/.test(v) && /[0-9_\-./+]/.test(v);
}

function assertNoCredentialsLeaked(
  inlineText: string,
  templates: TaskTemplate[],
  roles: Role[],
): void {
  const leaks: string[] = [];
  const checkValue = (label: string, v: unknown): void => {
    if (typeof v === "string" && looksLikeCredential(v) && inlineText.includes(v)) {
      leaks.push(label);
    } else if (v && typeof v === "object") {
      // mcpServers entries are objects that may embed credential strings (e.g.
      // env.TOKEN). Walk leaf strings.
      for (const leaf of JSON.stringify(v).split(/["{},:]+/)) {
        if (looksLikeCredential(leaf) && inlineText.includes(leaf)) {
          leaks.push(label);
          break;
        }
      }
    }
  };

  for (const t of templates) {
    const cfgEnv = (t.config?.env ?? {}) as Record<string, unknown>;
    for (const v of Object.values(cfgEnv)) checkValue("config.env credential", v);
    const cfgMcp = (t.config?.mcpServers ?? {}) as Record<string, unknown>;
    for (const v of Object.values(cfgMcp)) checkValue("config.mcpServers credential", v);
  }
  for (const r of roles) {
    if (r.envVars) for (const v of Object.values(r.envVars)) checkValue("envVar credential", v);
    if (r.mcpServers) for (const v of Object.values(r.mcpServers)) checkValue("mcpServer credential", v);
  }

  if (leaks.length > 0) {
    throw new Error(
      `config-doc: CREDENTIAL leak detected in inline/header region: ${[...new Set(leaks)].join(", ")}. ` +
        `A credential-shaped value from a designated secret field also appears in a non-placeholdered ` +
        `(free-text) field. Refusing to export.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Machine block: structured portable config
// ---------------------------------------------------------------------------

/**
 * Build the structured portable config for a single role, used both by the
 * machine block (renderer) and (in the future) the parser. The projection
 * is driven by the classification lists so it stays exhaustive when new
 * portable fields are added.
 *
 * Verbatim fields (cagPrompt) become `{__anchor:"<id>"}` refs. Env fields
 * (model, envVars values, additionalDirectories[i].path) become `${TOKEN}`
 * strings using the manifest lookup. Identity fields are excluded (only
 * `sourceId` is exposed).
 */
export function computeRolePortableProjection(
  role: Role,
  phName: (boundField: string) => string,
): PortableRole {
  const proj: PortableRole = {
    sourceId: role.id,
    name: role.name,
    cagPrompt: { __anchor: `role.${role.id}.cagPrompt` } as AnchorRef,
  };
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
  // Env fields → ${TOKEN}
  if (role.model) proj.model = `\${${phName(`role.${role.id}.model`)}}`;
  if (role.envVars) {
    const envOut: Record<string, string> = {};
    for (const k of Object.keys(role.envVars)) {
      envOut[k] = `\${${phName(`role.${role.id}.envVars.${k}`)}}`;
    }
    proj.envVars = envOut;
  }
  if (role.additionalDirectories) {
    proj.additionalDirectories = role.additionalDirectories
      .filter((d) => d?.path)
      .map((d, i) => ({
        path: `\${${phName(`role.${role.id}.additionalDirectories[${i}].path`)}}`,
        ...(d.mode ? { mode: d.mode } : {}),
      }));
  }
  return proj;
}

function buildPortableStep(t: TaskTemplate, step: TaskStep, phName: (boundField: string) => string): PortableStep {
  const out: PortableStep = {
    id: step.id,
    prompt: { __anchor: `template.${t.id}.step.${step.id}.prompt` } as AnchorRef,
    roleId: step.roleId ?? "",
  };
  if (step.persona) {
    out.persona = {
      speakAs: { __anchor: `template.${t.id}.step.${step.id}.persona.speakAs` } as AnchorRef,
      ...(step.persona.voiceConstraints ? { voiceConstraints: step.persona.voiceConstraints } : {}),
    };
  }
  if (step.outputContract) {
    const oc = step.outputContract;
    out.outputContract = {
      ...(oc.mustReferenceArtifacts !== undefined ? { mustReferenceArtifacts: oc.mustReferenceArtifacts } : {}),
      ...(oc.contractRules ? { contractRules: oc.contractRules } : {}),
      ...(oc.customAssertions && oc.customAssertions.length > 0
        ? {
            customAssertions: oc.customAssertions.map(
              (_ca: string, i: number) =>
                ({
                  __anchor: `template.${t.id}.step.${step.id}.outputContract.customAssertions[${i}]`,
                }) as AnchorRef,
            ),
          }
        : {}),
    };
  }
  if (step.dependsOn) out.dependsOn = step.dependsOn;
  if (typeof step.minDependencies === "number") out.minDependencies = step.minDependencies;
  if (step.outputAs) out.outputAs = step.outputAs;
  if (step.requirements) out.requirements = step.requirements;
  if (step.autoSelectRole) out.autoSelectRole = step.autoSelectRole;
  if (step.config) out.config = step.config;
  if (step.consumesFrom) out.consumesFrom = step.consumesFrom;
  if (step.consumesFromOptional) out.consumesFromOptional = step.consumesFromOptional;
  if (step.assertions) out.assertions = step.assertions;
  if (step.recordEditorScores) out.recordEditorScores = step.recordEditorScores;
  if (step.candidateId) out.candidateId = step.candidateId;
  if (step.briefPerturbation) out.briefPerturbation = step.briefPerturbation;
  if (step.kind) out.kind = step.kind;
  if (step.settlementLedgerOwner) out.settlementLedgerOwner = step.settlementLedgerOwner;
  if (step.publishesClaimsTo) out.publishesClaimsTo = step.publishesClaimsTo;
  if (step.settlesPredictionsFor) out.settlesPredictionsFor = step.settlesPredictionsFor;
  if (step.openLedgerOwner) out.openLedgerOwner = step.openLedgerOwner;
  if (typeof step.openLedgerLookbackDays === "number") out.openLedgerLookbackDays = step.openLedgerLookbackDays;
  return out;
}

/**
 * Build the structured portable config for the closure, used by the
 * machine block emission. Returns `{templates, roles}`.
 */
export function buildPortableConfig(
  templates: TaskTemplate[],
  roles: Role[],
  phName: (boundField: string) => string,
): PortableConfig {
  return {
    templates: templates.map((t) => {
      const proj: PortableTemplate = {
        sourceId: t.id,
        name: t.name,
        steps: t.steps.map((s) => buildPortableStep(t, s, phName)),
      };
      if (t.description) proj.description = t.description;
      if (t.trigger) proj.trigger = t.trigger;
      if (t.rolePreference) proj.rolePreference = t.rolePreference;
      if (t.config) {
        // Strip the secret-bearing sub-objects (`env`, `mcpServers`) — their
        // values are emitted as ${PLACEHOLDER} tokens in the body, and the
        // machine block must mirror that (no credential leak in the JSON).
        const configSansSecrets = { ...t.config } as Record<string, unknown>;
        delete configSansSecrets.env;
        delete configSansSecrets.mcpServers;
        if (Object.keys(configSansSecrets).length > 0) proj.config = configSansSecrets;
      }
      if (t.tags) proj.tags = t.tags;
      if (typeof t.enabled === "boolean") proj.enabled = t.enabled;
      if (t.goalIds) proj.goalIds = t.goalIds;
      if (t.retryPolicy) proj.retryPolicy = t.retryPolicy;
      if (t.isPreset) proj.isPreset = t.isPreset;
      if (t.presetId) proj.presetId = t.presetId;
      return proj;
    }),
    roles: roles.map((r) => computeRolePortableProjection(r, phName)),
  };
}

function renderMachineBlock(config: PortableConfig): string {
  const json = JSON.stringify(config, null, 2);
  return `${MACHINE_OPEN}\n\`\`\`json\n${json}\n\`\`\`\n${MACHINE_CLOSE}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a config-doc for the given template ids.
 *
 * Throws on:
 * - unknown template id
 * - field classification failure (fail-closed, see `assertExhaustiveKeys`)
 * - secret leak in the header/inline region
 */
export function renderConfigDoc(templateIds: string[]): string {
  const { templates, roles, autoSelectStepIds, rolePreferenceIds } = walkClosure(templateIds);
  const rolesArr = Array.from(roles.values());

  // Build the manifests ONCE and share them between the header and the body so
  // placeholder names are guaranteed identical in both regions (single source
  // of truth — a body token always has a matching header manifest entry).
  const dependencies = buildDependencyManifest(templates, rolesArr);
  const placeholders = buildPlaceholderManifest(templates, rolesArr);
  const ledgerOwners = collectLedgerOwners(templates);
  const phName = makePlaceholderLookup(placeholders);

  const header = renderHeader(
    templates,
    rolesArr,
    autoSelectStepIds,
    rolePreferenceIds,
    dependencies,
    placeholders,
    ledgerOwners,
  );
  const bodyParts: string[] = [];
  for (const t of templates) bodyParts.push(renderTemplateSection(t, phName));
  for (const r of rolesArr) bodyParts.push(renderRoleSection(r, phName));
  const body = bodyParts.join("\n");

  // Final credential guard (Option A — credentials-only hard-fail): assert no
  // CREDENTIAL-shaped value from a designated secret field also survives in the
  // header + inline body. Env-specific paths/model/channel ids are placeholdered
  // in their designated fields but tolerated inside free-text (learnedRules /
  // allowedBashPatterns) — see assertNoCredentialsLeaked. Anchor content is
  // excluded (verbatim prompts legitimately mention paths).
  const inlineOnly = body.replace(
    /<!-- adam:field[\s\S]*?-->\n[\s\S]*?\n<!-- \/adam:field [^>]+-->/g,
    "",
  );
  assertNoCredentialsLeaked(header + "\n" + inlineOnly, templates, rolesArr);

  // Machine block: append the structured portable config after the human
  // body. Drift-safe (driven from classification lists via the projection
  // helpers), and reuses the same placeholder lookup so machine env
  // tokens resolve identically to the body. The credential guard
  // intentionally does NOT include the machine block (env are tokens,
  // not credentials — see assertNoCredentialsLeaked for the contract).
  const machineConfig = buildPortableConfig(templates, rolesArr, phName);
  const machineBlock = renderMachineBlock(machineConfig);

  return header + "\n\n" + body + "\n\n" + machineBlock;
}
