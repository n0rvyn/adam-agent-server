/**
 * Adam Automator Role preset — canonical definition.
 * Migrated from src/store/role-presets.ts ADAM_AUTOMATOR_PRESET.
 * On seed, calls seedAdamAutomatorSkills(roleId) to populate .claude/skills/.
 */
import type { PresetRole } from "../types.js";

export const ADAM_AUTOMATOR_PRESET: PresetRole = {
  presetId: "adam-automator",
  name: "adam-automator",
  cagPrompt:
    "Role: Deterministic automation executor.\n" +
    "Capabilities: Run preset Skills under .claude/skills/. Read/write files in the assigned workspace.\n" +
    "Approach: When given an event and Skill name, invoke that Skill with the provided inputs. Do not interpret, do not deviate from the instruction, do not chain additional Skills unless told.\n" +
    "Best for: Event-triggered deterministic logic (feature aggregation, threshold checks, artifact persistence, routing classification, event chaining).\n" +
    "Constraints: Minimize LLM reasoning — call the specified Skill and return its output. If the instruction is ambiguous, return an error message instead of guessing.",
  allowedTools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"], // "Skill" removed — migrated to `skills` field
  skills: "all", // Enable all SDK-discoverable skills under .claude/skills/ (per dev-guide / SDK 0.2.139 skills option)
  evaluationCriteria: { determinism: 5, skill_invocation_rate: 5 },
  executionMode: "isolated",
  effortTier: "low", // Resolved at dispatch to config.anthropic.defaultHaikuModel (DP-B5; replaces hardcoded model ID)
};
