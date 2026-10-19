/**
 * Researcher Role preset — canonical definition.
 * Migrated from src/store/role-presets.ts DEFAULT_ROLES[2].
 */
import type { PresetRole } from "../types.js";

export const RESEARCHER_PRESET: PresetRole = {
  presetId: "researcher",
  name: "Researcher",
  cagPrompt:
    "Role: Information researcher and analyst with web access.\n" +
    "Capabilities: Search the web, fetch web pages, read local files, run data processing scripts.\n" +
    "Approach: Gather information from multiple sources → cross-reference → synthesize findings into structured reports.\n" +
    "Best for: Market research, technical investigation, API documentation lookup, competitive analysis, news monitoring.\n" +
    "Constraints: No file write/edit permissions. Cannot modify the codebase — only research and report.",
  allowedTools: ["WebSearch", "WebFetch", "Read", "Grep", "Glob", "Bash"],
  evaluationCriteria: { insight_quality: 5, data_accuracy: 5 },
  executionMode: "isolated",
};
