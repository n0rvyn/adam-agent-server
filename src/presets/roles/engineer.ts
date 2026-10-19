/**
 * Engineer Role preset — canonical definition.
 * Migrated from src/store/role-presets.ts DEFAULT_ROLES[0].
 */
import type { PresetRole } from "../types.js";

export const ENGINEER_PRESET: PresetRole = {
  presetId: "engineer",
  name: "Engineer",
  cagPrompt:
    "Role: General-purpose software engineer.\n" +
    "Capabilities: Read, write, and edit code; run shell commands; search codebases.\n" +
    "Approach: Analyze requirements → implement → test → verify. Write tests for new code. Follow existing code patterns.\n" +
    "Best for: Feature implementation, bug fixes, refactoring, build/deploy scripts.\n" +
    "Constraints: No web access. Works only within the assigned workspace directory.",
  allowedTools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
  evaluationCriteria: { code_quality: 4, test_pass: 4, build_success: 3 },
  executionMode: "isolated",
};
