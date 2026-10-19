import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { RUNTIME_DIR } from "../shared/constants.js";
import type { Role } from "../shared/types.js";
import { seedRoleEnvFromFile } from "../config/role-env-sync.js";
import { updateRole } from "./roles.js";

function getRuntimeRoot(): string {
  return process.env.ADAM_TEST_DIR || RUNTIME_DIR;
}

export function getRoleWorkspacePath(roleName: string): string {
  const safe = basename(roleName);
  if (safe !== roleName || !roleName) {
    throw new Error(`Invalid role name for workspace: ${roleName}`);
  }
  return join(getRuntimeRoot(), "roles", safe);
}

export function ensureRoleWorkspace(role: Role): string {
  const wsPath = getRoleWorkspacePath(role.name);
  mkdirSync(wsPath, { recursive: true });
  mkdirSync(join(wsPath, ".claude"), { recursive: true });

  writeRoleCLAUDEmd(wsPath, role);
  syncRoleSettings(role.id, role.allowedTools, wsPath);

  // Seed env vars from role .env file (DB values take priority)
  const mergedEnv = seedRoleEnvFromFile(role.name, role.envVars);
  if (mergedEnv && JSON.stringify(mergedEnv) !== JSON.stringify(role.envVars)) {
    updateRole(role.id, { envVars: mergedEnv });
  }

  return wsPath;
}

export function writeRoleCLAUDEmd(wsPath: string, role: Role): void {
  // Build three-section learned rules block
  const stylePrefs = role.learnedRules.stylePreferences.length > 0
    ? role.learnedRules.stylePreferences.map((r) => `- ${r}`).join("\n")
    : "(none yet)";
  const avoided = role.learnedRules.avoidedActions.length > 0
    ? role.learnedRules.avoidedActions.map((r) => `- ${r}`).join("\n")
    : "(none yet)";
  const pinnedParams = role.learnedRules.pinnedParameters.length > 0
    ? role.learnedRules.pinnedParameters.map((p) => {
        const paramSummary = Object.entries(p.params).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
        const cond = p.condition ? ` [when: ${p.condition}]` : "";
        return `- ${p.tool} → ${paramSummary}${cond}`;
      }).join("\n")
    : "(none yet)";

  let content = `# ${role.name}

${role.cagPrompt}

## Learned Rules

### Style Preferences
${stylePrefs}

### Avoided Actions
${avoided}

### Pinned Parameters
When invoking matching tools, prefer these parameter values unless overridden:
${pinnedParams}
`;

  // Add compaction instructions for the chat-manager role (GAP-03/GAP-04)
  if (role.name === "chat-manager") {
    content += `
## Compaction Instructions
When summarizing, preserve:
- Active task IDs and their current status
- User's pending requests not yet addressed
- Key decisions made and their rationale
- Role assignments and execution outcomes
- Channel/session routing context
`;
  }

  writeFileSync(join(wsPath, "CLAUDE.md"), content, "utf-8");
}

export function syncRoleSettings(roleId: string, allowedTools: string[] | undefined, wsPath: string): void {
  // Only write allowedTools when the Role has explicit permissions.
  // Omitting the key = SDK applies no tool restriction from project settings.
  // Writing [] = SDK blocks all tools.
  const settings: Record<string, unknown> = {};
  if (allowedTools) {
    settings.allowedTools = allowedTools;
  }

  writeFileSync(join(wsPath, ".claude", "settings.json"), JSON.stringify(settings, null, 2), "utf-8");
}
