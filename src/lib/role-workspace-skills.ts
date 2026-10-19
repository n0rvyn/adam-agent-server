/**
 * Role Workspace Skills -- read skill files from Role workspaces.
 * Reads .claude/skills directories in Role workspaces for SKILL.md files.
 * Supports skills seeded by the automator skill seeder and user-created skills.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getRoleWorkspacePath } from "../store/role-workspace.js";

export interface WorkspaceSkill {
  name: string;
  description: string;
  /** Source role name */
  roleName: string;
  /** Source role id */
  roleId: string;
  /** Absolute path to the SKILL.md file */
  path: string;
  /** Raw YAML frontmatter fields (keyed by lowercased field name) */
  rawFrontmatter: Record<string, string>;
}

/** Split on newlines and strip leading code-fence marker if present. */
function stripCodeFence(content: string): string {
  const allLines = content.split("\n");
  const first = allLines[0] ?? "";
  if (first.startsWith("```yaml") || first.startsWith("```")) {
    return allLines.slice(1).join("\n");
  }
  return content;
}

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Extracts key: value pairs from the top of the file until a non-key line is encountered.
 */
function parseYamlFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const trimmed = stripCodeFence(content);
  const lines = trimmed.split("\n");
  for (const ln of lines) {
    const m = ln.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (m) {
      result[m[1].toLowerCase()] = m[2].trim();
    } else if (ln.trim() && !ln.startsWith("#") && !ln.startsWith(" ") && !ln.startsWith("\t")) {
      // Non-indented, non-comment, non-empty line marks end of frontmatter
      break;
    }
  }
  return result;
}

/**
 * Read all SKILL.md files from a single Role's workspace skills directory.
 * Returns an array of parsed skill entries.
 */
export function readRoleWorkspaceSkills(roleId: string, roleName: string): WorkspaceSkill[] {
  const skills: WorkspaceSkill[] = [];

  try {
    const workspacePath = getRoleWorkspacePath(roleName);
    const skillsDir = join(workspacePath, ".claude", "skills");

    if (!existsSync(skillsDir)) return skills;

    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      try {
        const fileContent = readFileSync(skillMdPath, "utf-8");
        const fm = parseYamlFrontmatter(fileContent);
        const name = fm["name"] ?? entry.name;
        const description = fm["description"] ?? "";

        skills.push({
          name,
          description,
          roleName,
          roleId,
          path: skillMdPath,
          rawFrontmatter: fm,
        });
      } catch {
        // Skip malformed skill files silently
      }
    }
  } catch {
    // Workspace may not exist yet
  }

  return skills;
}

/**
 * Read all skills across all active Roles.
 * Returns a flat list of WorkspaceSkill entries.
 */
export function readAllWorkspaceSkills(activeRoleIds: string[], activeRoleNames: string[]): WorkspaceSkill[] {
  const all: WorkspaceSkill[] = [];
  for (let i = 0; i < activeRoleIds.length; i++) {
    const skills = readRoleWorkspaceSkills(activeRoleIds[i], activeRoleNames[i]);
    all.push(...skills);
  }
  return all;
}
