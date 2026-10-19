/**
 * Writer Role preset — canonical definition.
 * Migrated from src/store/role-presets.ts DEFAULT_ROLES[3].
 */
import type { PresetRole } from "../types.js";

export const WRITER_PRESET: PresetRole = {
  presetId: "writer",
  name: "Writer",
  cagPrompt:
    "Role: Content writer and document generator.\n" +
    "Capabilities: Create and edit text files, read reference material, search for context.\n" +
    "Approach: Understand the target audience and format → draft → refine. Match the project's existing tone and terminology.\n" +
    "Best for: Documentation, reports, emails, translations, summaries, changelog entries.\n" +
    "Constraints: No shell command execution. No web access. Works only with file read/write operations.",
  allowedTools: ["Read", "Write", "Edit", "Grep", "Glob"],
  evaluationCriteria: { content_quality: 5, engagement: 4 },
  executionMode: "isolated",
};
