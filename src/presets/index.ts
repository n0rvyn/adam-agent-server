/**
 * Preset registry index.
 *
 * Provides a centralized registry of canonical Role and Template presets,
 * plus idempotent seeding and restore functions.
 *
 * Architecture: each preset lives in its own TS module under src/presets/roles/
 * or src/presets/templates/. This index aggregates them.
 */

import { v4 as uuidv4 } from "uuid";
import { createRole, getRole, getRoleByName, listRoles, updateRole } from "../store/roles.js";
import { createTaskTemplate, getTaskTemplate, listTaskTemplates, updateTaskTemplate } from "../store/task-templates.js";
import { ensureRoleWorkspace } from "../store/role-workspace.js";
import type { Role, TaskTemplate, TaskStep } from "../shared/types.js";
import type { PresetRole, PresetTemplate } from "./types.js";

// -----------------------------------------------------------------------
// Role presets
// -----------------------------------------------------------------------
import { ENGINEER_PRESET } from "./roles/engineer.js";
import { REVIEWER_PRESET } from "./roles/reviewer.js";
import { RESEARCHER_PRESET } from "./roles/researcher.js";
import { WRITER_PRESET } from "./roles/writer.js";
import { CHAT_MANAGER_PRESET } from "./roles/chat-manager.js";
import { ADAM_AUTOMATOR_PRESET } from "./roles/adam-automator.js";
import { FEATURE_MINER_PRESET } from "./roles/feature-miner.js";
import { MISTAKE_DIGESTER_PRESET } from "./roles/mistake-digester.js";

/** All registered Role presets, in canonical order. */
export const ROLE_PRESETS: PresetRole[] = [
  ENGINEER_PRESET,
  REVIEWER_PRESET,
  RESEARCHER_PRESET,
  WRITER_PRESET,
  CHAT_MANAGER_PRESET,
  ADAM_AUTOMATOR_PRESET,
  FEATURE_MINER_PRESET,
  MISTAKE_DIGESTER_PRESET,
];

/** Adam Automator preset — exported for backwards compatibility. */
export { ADAM_AUTOMATOR_PRESET };

// -----------------------------------------------------------------------
// Template presets
// -----------------------------------------------------------------------
import { FEATURE_MINING_TEMPLATE } from "./templates/feature-mining.js";
import { MISTAKE_DIGEST_TEMPLATE } from "./templates/mistake-digest.js";

/** All registered Template presets. */
export const TEMPLATE_PRESETS: PresetTemplate[] = [
  FEATURE_MINING_TEMPLATE,
  MISTAKE_DIGEST_TEMPLATE,
];

// -----------------------------------------------------------------------
// Backwards-compatibility re-exports (mirrors the old role-presets.ts surface)
// -----------------------------------------------------------------------

/** Fixed ID for the chat-manager system Role — mirrors the old CHAT_MANAGER_ROLE_ID constant. */
export const CHAT_MANAGER_ROLE_ID = "role-chat-manager";

/**
 * Names of all preset Roles.
 * Used by guards (e.g., create_skill) that treat preset Roles as a protected surface.
 */
export const PRESET_ROLE_NAMES: readonly string[] = ROLE_PRESETS.map((p) => p.name);

/**
 * True when the role is a seeded preset (protected from destructive ChatManager operations).
 * Checks role.source === "system" first, then falls back to name match against preset names.
 */
export function isPresetRole(role: { name: string; source?: string }): boolean {
  if (role.source === "system") return true;
  if (role.source === "user") return false;
  return PRESET_ROLE_NAMES.includes(role.name);
}

/**
 * Seeds all preset Roles and Templates, then returns the chat-manager Role.
 * Mirrors the old initializeDefaultRoles() behaviour but delegates to seedPresets().
 */
export function ensureChatManagerRole(): Role {
  seedPresets();
  const role = getRoleByName(CHAT_MANAGER_PRESET.name);
  if (!role) throw new Error("ChatManager role not found after seedPresets()");
  return role;
}

/**
 * Seeds all preset Roles and Templates, then returns the adam-automator Role.
 * Mirrors the old ensureAdamAutomatorRole() behaviour.
 */
export function ensureAdamAutomatorRole(): Role {
  seedPresets();
  const role = getRoleByName(ADAM_AUTOMATOR_PRESET.name);
  if (!role) throw new Error("adam-automator role not found after seedPresets()");
  return role;
}

/**
 * Mirrors the old initializeDefaultRoles() signature for backwards compatibility.
 * Seeds all presets and returns all Roles (both preset and any pre-existing).
 */
export function initializeDefaultRoles(): Role[] {
  seedPresets();
  return listRoles(undefined, 1000, 0);
}

// -----------------------------------------------------------------------
// Accessors
// -----------------------------------------------------------------------

/** Returns all Role presets. */
export function getPresetRoles(): PresetRole[] {
  return ROLE_PRESETS;
}

/** Returns all Template presets. */
export function getPresetTemplates(): PresetTemplate[] {
  return TEMPLATE_PRESETS;
}

/** Returns a Role preset by presetId, or undefined. */
export function getPresetRole(presetId: string): PresetRole | undefined {
  return ROLE_PRESETS.find((p) => p.presetId === presetId);
}

/** Returns a Template preset by presetId, or undefined. */
export function getPresetTemplate(presetId: string): PresetTemplate | undefined {
  return TEMPLATE_PRESETS.find((p) => p.presetId === presetId);
}

// -----------------------------------------------------------------------
// Idempotent seed
// -----------------------------------------------------------------------

/**
 * Resolves a boundRolePresetId to an actual roleId, or returns empty string.
 */
function resolveRoleId(presetId: string): string {
  const boundPreset = getPresetRole(presetId);
  if (!boundPreset) return "";
  const role = getRoleByName(boundPreset.name);
  return role?.id ?? "";
}

/**
 * Seeds all preset Roles and Template presets into the DB.
 * Idempotent — skips any Role/Template whose name already exists.
 *
 * Special cases:
 * - chat-manager: uses fixed ID "role-chat-manager" (not uuid) for compatibility
 *   with existing code that references CHAT_MANAGER_ROLE_ID = "role-chat-manager"
 * - adam-automator: calls seedAdamAutomatorSkills(roleId) on first creation
 *
 * Failure handling: skill seeding errors are logged but do not abort seedPresets().
 */
export function seedPresets(): { rolesCreated: number; templatesCreated: number } {
  let rolesCreated = 0;
  let templatesCreated = 0;

  // Seed Role presets
  for (const preset of ROLE_PRESETS) {
    const existing = getRoleByName(preset.name);
    if (existing) {
      // Already exists — skip
      continue;
    }

    // Determine the role ID
    const id = preset.presetId === "chat-manager"
      ? "role-chat-manager"
      : `role-${uuidv4().slice(0, 8)}`;

    const role: Role = {
      id,
      name: preset.name,
      cagPrompt: preset.cagPrompt,
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: `mem-${uuidv4().slice(0, 8)}`,
      status: "active",
      preferences: {},
      createdAt: Date.now(),
      allowedTools: preset.allowedTools,
      disallowedTools: preset.disallowedTools,
      evaluationCriteria: preset.evaluationCriteria,
      executionMode: preset.executionMode,
      model: preset.model,
      effortTier: preset.effortTier,
      skills: preset.skills,
      source: "system",
      presetId: preset.presetId,
    };

    createRole(role);
    ensureRoleWorkspace(role);
    console.info(`[presets] Seeded Role preset: ${preset.name} (${preset.presetId})`);

    // Special case: adam-automator skill seeding (first-creation only)
    if (preset.presetId === "adam-automator") {
      seedAdamAutomatorSkills(role.id).catch((err) => {
        console.warn(`[presets] Failed to seed adam-automator Skills: ${err}`);
      });
    }

    rolesCreated++;
  }

  // Seed Template presets
  for (const preset of TEMPLATE_PRESETS) {
    const existing = listTaskTemplates().find((t) => t.presetId === preset.presetId);
    if (existing) {
      // Already exists — skip
      continue;
    }

    const boundRoleId = resolveRoleId(preset.boundRolePresetId);

    const template: TaskTemplate = {
      id: `tmpl-${uuidv4().slice(0, 8)}`,
      name: preset.name,
      description: preset.description,
      trigger: preset.trigger,
      steps: preset.steps.map((s: TaskStep) => ({
        ...s,
        roleId: s.roleId === "" ? boundRoleId : s.roleId,
      })),
      config: preset.config,
      enabled: true,
      createdAt: Date.now(),
      isPreset: true,
      presetId: preset.presetId,
    };

    createTaskTemplate(template);
    templatesCreated++;
    console.info(`[presets] Seeded Template preset: ${preset.name} (${preset.presetId})`);
  }

  return { rolesCreated, templatesCreated };
}

// -----------------------------------------------------------------------
// Restore
// -----------------------------------------------------------------------

/**
 * Restores a preset to its canonical values.
 *
 * For Roles: if the Role exists, overwrites preset-controlled fields (cagPrompt,
 * allowedTools, disallowedTools, evaluationCriteria, executionMode, model, source,
 * presetId) but preserves user fields (learnedRules, performanceScore, memoryStreamId).
 * If the Role does not exist, re-creates it.
 *
 * For Templates: similar overwrite-or-create semantics using updateTaskTemplate or
 * createTaskTemplate.
 *
 * @returns { ok: true } on success, { ok: false, reason: string } on failure.
 */
export function restorePreset(
  type: "role" | "template",
  presetId: string,
): { ok: boolean; reason?: string } {
  if (type === "role") {
    const preset = getPresetRole(presetId);
    if (!preset) {
      return { ok: false, reason: "preset not found" };
    }

    const existing = getRoleByName(preset.name);
    if (existing) {
      // Partial update: overwrite preset-controlled fields, preserve user fields
      updateRole(existing.id, {
        cagPrompt: preset.cagPrompt,
        allowedTools: preset.allowedTools,
        disallowedTools: preset.disallowedTools,
        evaluationCriteria: preset.evaluationCriteria,
        executionMode: preset.executionMode,
        model: preset.model,
        effortTier: preset.effortTier,
        skills: preset.skills,
        source: "system",
        presetId: preset.presetId,
      });
      console.info(`[presets] Restored Role preset: ${preset.name} (${presetId})`);
    } else {
      // Re-create
      const id = preset.presetId === "chat-manager"
        ? "role-chat-manager"
        : `role-${uuidv4().slice(0, 8)}`;
      const role: Role = {
        id,
        name: preset.name,
        cagPrompt: preset.cagPrompt,
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: `mem-${uuidv4().slice(0, 8)}`,
        status: "active",
        preferences: {},
        createdAt: Date.now(),
        allowedTools: preset.allowedTools,
        disallowedTools: preset.disallowedTools,
        evaluationCriteria: preset.evaluationCriteria,
        executionMode: preset.executionMode,
        model: preset.model,
        effortTier: preset.effortTier,
        skills: preset.skills,
        source: "system",
        presetId: preset.presetId,
      };
      createRole(role);
      ensureRoleWorkspace(role);
      console.info(`[presets] Re-created Role preset via restorePreset: ${preset.name} (${presetId})`);

      // Self-heal: re-link ONLY orphaned step.roleId references on preset templates
      // that boundRolePresetId-target this role. We patch existingTpl.steps (user's
      // current state) — not tplPreset.steps (canonical) — so user customizations
      // (edited prompts, added steps) are preserved. Only step.roleId values
      // pointing at a deleted/nonexistent role are rewritten to the new id.
      const newRoleId = id;
      for (const tplPreset of TEMPLATE_PRESETS) {
        if (tplPreset.boundRolePresetId !== presetId) continue;
        const existingTpl = listTaskTemplates().find((t) => t.presetId === tplPreset.presetId);
        if (!existingTpl) continue;
        let repaired = false;
        const patched: TaskStep[] = existingTpl.steps.map((s) => {
          if (!s.roleId) return s;
          if (getRole(s.roleId)) return s;
          repaired = true;
          return { ...s, roleId: newRoleId };
        });
        if (repaired) {
          updateTaskTemplate(existingTpl.id, { steps: patched });
          console.info(`[presets] Re-linked orphaned step roleIds on Template ${tplPreset.presetId} → Role ${presetId}`);
        }
      }
    }

    return { ok: true };
  }

  if (type === "template") {
    const preset = getPresetTemplate(presetId);
    if (!preset) {
      return { ok: false, reason: "preset not found" };
    }

    // Ensure the bound Role preset exists before resolving its id — a Template
    // cannot dispatch without its bound Role, and the restore flow should self-heal.
    let boundRoleId = resolveRoleId(preset.boundRolePresetId);
    if (!boundRoleId) {
      const roleRestore = restorePreset("role", preset.boundRolePresetId);
      if (!roleRestore.ok) {
        return { ok: false, reason: `bound role preset missing: ${preset.boundRolePresetId}` };
      }
      boundRoleId = resolveRoleId(preset.boundRolePresetId);
      if (!boundRoleId) {
        return { ok: false, reason: `could not resolve bound role id after restore: ${preset.boundRolePresetId}` };
      }
    }

    const existing = listTaskTemplates().find((t) => t.presetId === preset.presetId);
    if (existing) {
      // Overwrite preset fields
      updateTaskTemplate(existing.id, {
        name: preset.name,
        description: preset.description,
        trigger: preset.trigger,
        steps: preset.steps.map((s: TaskStep) => ({
          ...s,
          roleId: s.roleId === "" ? boundRoleId : s.roleId,
        })),
        config: preset.config,
        isPreset: true,
        presetId: preset.presetId,
      });

      console.info(`[presets] Restored Template preset: ${preset.name} (${presetId})`);
    } else {
      // Re-create
      const template: TaskTemplate = {
        id: `tmpl-${uuidv4().slice(0, 8)}`,
        name: preset.name,
        description: preset.description,
        trigger: preset.trigger,
        steps: preset.steps.map((s: TaskStep) => ({
          ...s,
          roleId: s.roleId === "" ? boundRoleId : s.roleId,
        })),
        config: preset.config,
        enabled: true,
        createdAt: Date.now(),
        isPreset: true,
        presetId: preset.presetId,
      };
      createTaskTemplate(template);
      console.info(`[presets] Re-created Template preset via restorePreset: ${preset.name} (${presetId})`);
    }

    return { ok: true };
  }

  return { ok: false, reason: "invalid type" };
}

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

/**
 * Seeds adam-automator Skills under the given role's workspace.
 * Idempotent — skips if SKILL.md already exists.
 * Wrapped in try/catch so failures do not abort seedPresets().
 */
async function seedAdamAutomatorSkills(roleId: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { seedAdamAutomatorSkills: seed } = require("../store/adam-automator-skills.js");
    await seed(roleId);
  } catch {
    // Skill seed module not yet available (Task 13 in another plan)
    console.warn(`[presets] seedAdamAutomatorSkills: module unavailable for roleId=${roleId}`);
  }
}
