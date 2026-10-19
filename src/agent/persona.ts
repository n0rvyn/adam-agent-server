import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "../shared/types.js";
import { getLogger } from "../lib/logger.js";
import { CLAUDE_MD_PATH, RUNTIME_DIR } from "../shared/constants.js";

const log = getLogger("manager");

const CLAUDE_DIR = ".claude";
const CLAUDE_MD = "CLAUDE.md";

/**
 * Build a structured string system prompt for the SDK.
 * This replaces the `claude_code` preset identity with the role's own role/constraints.
 */
export function buildRoleSystemPrompt(
  role: string,
  name: string,
  allowedTools: string[],
  deniedTools: string[],
): string {
  const identityBlock = [
    "[Role Identity]",
    `Role: ${role}`,
    `Name: ${name}`,
    "",
    "[Role Constraints]",
    `Allowed Tools: ${allowedTools.length > 0 ? allowedTools.join(", ") : "(all)"}`,
    `Disallowed Tools: ${deniedTools.length > 0 ? deniedTools.join(", ") : "(none)"}`,
    // Path restrictions enforced by OS sandbox, not listed in prompt
  ].join("\n");

  return identityBlock;
}

export function getRoleClaudeMdPath(workspacePath: string): string {
  return join(workspacePath, CLAUDE_DIR, CLAUDE_MD);
}

function ensureClaudeDir(workspacePath: string): void {
  const claudeDir = join(workspacePath, CLAUDE_DIR);
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }
}

/**
 * Format three-tier rules from a Role object.
 */
export function formatThreeTierRules(role: Role): string {
  const lines: string[] = [];

  // [system] - immutable, shared across all agents
  lines.push("## [system] (Immutable)");
  lines.push("- Follow the original task's intent");
  lines.push("- Dependencies must be explicitly stated using subtask IDs");
  lines.push("- Low complexity: single tool, clear goal");
  lines.push("- Medium complexity: multiple tools, sequential steps");
  lines.push("- High complexity: many tools, complex logic, multiple phases");
  lines.push("");

  // [identity] - agent personality, user-modifiable
  lines.push(`## [identity] (User-Modifiable) — ${role.name}`);
  lines.push("");
  lines.push("**CAG Prompt:**");
  lines.push(role.cagPrompt);
  lines.push("");

  // [learned] - self-evolving, agent-generated
  lines.push("## [learned] (Self-Evolving)");
  lines.push("");
  lines.push("**Style Preferences:**");
  if (role.learnedRules.stylePreferences.length > 0) {
    for (const r of role.learnedRules.stylePreferences) lines.push(`- ${r}`);
  } else {
    lines.push("(none yet)");
  }
  lines.push("");
  lines.push("**Avoided Actions:**");
  if (role.learnedRules.avoidedActions.length > 0) {
    for (const r of role.learnedRules.avoidedActions) lines.push(`- ${r}`);
  } else {
    lines.push("(none yet)");
  }
  lines.push("");
  lines.push("**Pinned Parameters:**");
  if (role.learnedRules.pinnedParameters.length > 0) {
    for (const p of role.learnedRules.pinnedParameters) {
      const paramSummary = Object.entries(p.params).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
      const cond = p.condition ? ` [when: ${p.condition}]` : "";
      lines.push(`- ${p.tool} → ${paramSummary}${cond}`);
    }
  } else {
    lines.push("(none yet)");
  }

  return lines.join("\n");
}

/**
 * Write role personality to workspace CLAUDE.md.
 * Each role gets exclusive workspace during task execution;
 * the file is overwritten (not appended) per assignment.
 */
export function writeRolePersona(
  role: Role,
  workspacePath: string,
): void {
  ensureClaudeDir(workspacePath);
  const claudeMdPath = getRoleClaudeMdPath(workspacePath);

  const rulesContent = formatThreeTierRules(role);
  const fullContent = `# Role Workspace CLAUDE.md\n\n${rulesContent}\n`;

  writeFileSync(claudeMdPath, fullContent, "utf-8");
  log.info({ roleName: role.name, path: claudeMdPath }, "Written role personality");
}

/**
 * Update only the [learned] section of an existing CLAUDE.md.
 */
export function updateLearnedRules(
  role: Role,
  workspacePath: string,
): void {
  const claudeMdPath = getRoleClaudeMdPath(workspacePath);
  if (!existsSync(claudeMdPath)) {
    writeRolePersona(role, workspacePath);
    return;
  }

  const content = readFileSync(claudeMdPath, "utf-8");
  const learnedStart = content.indexOf("## [learned] (Self-Evolving)");
  if (learnedStart === -1) {
    writeRolePersona(role, workspacePath);
    return;
  }

  const beforeLearned = content.slice(0, learnedStart);
  const learnedLines = [
    "## [learned] (Self-Evolving)",
    "",
    "**Style Preferences:**",
    ...(role.learnedRules.stylePreferences.length > 0
      ? role.learnedRules.stylePreferences.map(r => `- ${r}`)
      : ["(none yet)"]),
    "",
    "**Avoided Actions:**",
    ...(role.learnedRules.avoidedActions.length > 0
      ? role.learnedRules.avoidedActions.map(r => `- ${r}`)
      : ["(none yet)"]),
    "",
    "**Pinned Parameters:**",
    ...(role.learnedRules.pinnedParameters.length > 0
      ? role.learnedRules.pinnedParameters.map(p => {
          const paramSummary = Object.entries(p.params).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
          const cond = p.condition ? ` [when: ${p.condition}]` : "";
          return `- ${p.tool} → ${paramSummary}${cond}`;
        })
      : ["(none yet)"]),
  ];

  const newContent = beforeLearned + learnedLines.join("\n") + "\n";
  writeFileSync(claudeMdPath, newContent, "utf-8");
}

export function writeManagerPersona(content: string): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  // Write to both locations SDK checks: root CLAUDE.md and .claude/CLAUDE.md
  writeFileSync(CLAUDE_MD_PATH, content, "utf-8");
  const claudeDir = join(RUNTIME_DIR, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "CLAUDE.md"), content, "utf-8");
}

export function loadRolePersona(workspacePath: string): string | null {
  const claudeMdPath = getRoleClaudeMdPath(workspacePath);
  if (!existsSync(claudeMdPath)) {
    return null;
  }
  return readFileSync(claudeMdPath, "utf-8");
}
