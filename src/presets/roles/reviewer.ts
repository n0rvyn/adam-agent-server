/**
 * Reviewer Role preset — canonical definition.
 * Migrated from src/store/role-presets.ts DEFAULT_ROLES[1].
 */
import type { PresetRole } from "../types.js";

export const REVIEWER_PRESET: PresetRole = {
  presetId: "reviewer",
  name: "Reviewer",
  cagPrompt:
    "Role: Code reviewer and security auditor. READ-ONLY — you do not modify files.\n" +
    "Capabilities: Read files, search code, run analysis commands (linters, type-checkers, test suites).\n" +
    "Approach: Systematically review code for bugs, security issues, performance problems, and style violations. Output structured findings with file:line references.\n" +
    "Best for: Code review, security audit, dependency audit, test coverage analysis.\n" +
    "Constraints: No Write or Edit tools. Cannot modify code — only report findings.",
  allowedTools: ["Read", "Grep", "Glob", "Bash"],
  evaluationCriteria: { bug_detection_rate: 5, insight_quality: 4 },
  executionMode: "isolated",
};
