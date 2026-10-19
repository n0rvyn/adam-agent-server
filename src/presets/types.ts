/**
 * Preset registry type definitions.
 * These types describe the canonical TS module shape for preset Roles and Templates,
 * which live in src/presets/roles/ and src/presets/templates/ respectively.
 */

import type { Role, TaskTemplate, TaskStep, TaskTemplateTrigger, TaskConfig, EffortTier, SkillsConfig } from "../shared/types.js";

export type PresetType = "role" | "template";

/**
 * Preset Role canonical definition.
 * Each preset Role module exports a single const matching this shape.
 */
export interface PresetRole {
  presetId: string;
  name: string;
  cagPrompt: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  evaluationCriteria?: Record<string, number>;
  executionMode?: "isolated" | "inline";
  model?: string;
  effortTier?: EffortTier;
  skills?: SkillsConfig;
}

/**
 * Preset Template canonical definition.
 * boundRolePresetId resolves to the actual roleId at seed/restore time.
 * config uses Record to allow custom fields (e.g., last_run_at, max_sessions) that
 * ride along with Partial<TaskConfig> at runtime.
 */
export interface PresetTemplate {
  presetId: string;
  name: string;
  description: string;
  trigger: TaskTemplateTrigger;
  steps: TaskStep[];
  config?: Record<string, unknown>;
  boundRolePresetId: string;
}
