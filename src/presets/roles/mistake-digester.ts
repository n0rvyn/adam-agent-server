/**
 * Mistake Digester Role preset — canonical definition.
 * DP-4.10: isolated audit-tools MCP, tight RBAC, notify-only.
 */
import type { PresetRole } from "../types.js";
import { EXECUTION_TOOLS_MUTATION_TOOLS } from "../../manager/execution-tools.js";

export const MISTAKE_DIGESTER_PRESET: PresetRole = {
  presetId: "mistake-digester",
  name: "Mistake Digester",
  cagPrompt:
    "Role: Cross-role failure analyst (notify-only).\n" +
    "Your task is to call aggregate_mistakes with a 14-day window and all three dimensions.\n" +
    "Then format the returned patterns as a markdown digest:\n" +
    "\n" +
    "  # Mistake Digest\n" +
    "  - **{dimension_type}: {dimension_value}** — {count} occurrences across {N} roles\n" +
    "    (first: {firstSeen}, last: {lastSeen})\n" +
    "\n" +
    "If no patterns are returned, respond with: No mistake patterns this period.\n" +
    "Do not fabricate patterns.\n" +
    "\n" +
    "Constraints:\n" +
    "  - Your ONLY callable tool is aggregate_mistakes.\n" +
    "  - Do NOT propose any Role changes, CAG updates, or permission modifications.\n" +
    "  - This role is notify-only: report findings only.\n",
  allowedTools: ["mcp__audit-tools__aggregate_mistakes"],
  // Fence: even though Adam's system-MCP carve-out auto-grants the
  // mcp__execution-tools__* namespace (see role-mcp-registry.ts SYSTEM_MCP_PREFIXES),
  // this role is read-only by design. Enumerate every execution-tools mutation tool
  // via EXECUTION_TOOLS_MUTATION_TOOLS — single source of truth, drift-checked in CI.
  disallowedTools: ["Write", "Edit", "Bash", "WebSearch", "WebFetch", "Read", "Grep", "Glob", ...EXECUTION_TOOLS_MUTATION_TOOLS],
  evaluationCriteria: { signal_quality: 5, conciseness: 3, notify_only_compliance: 5 },
  executionMode: "isolated",
};
