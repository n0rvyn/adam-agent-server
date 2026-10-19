/**
 * Feature Miner Role preset — canonical definition.
 * DP-3.2 CAG + DP-3.3 allowedTools + DP-V.1 constraints.
 */
import type { PresetRole } from "../types.js";
import { EXECUTION_TOOLS_MUTATION_TOOLS } from "../../manager/execution-tools.js";

export const FEATURE_MINER_PRESET: PresetRole = {
  presetId: "feature-miner",
  name: "Feature Miner",
  cagPrompt:
    "Role: Feature request analyst.\n" +
    "You are given chat session data inline in the prompt (the dispatcher pre-fetched it). You cannot read other sessions.\n" +
    "\n" +
    "What counts as a feature request:\n" +
    "- The user explicitly asks for a capability that is not currently provided by the platform\n" +
    "- The user proposes a new feature or improvement\n" +
    "- The user describes a workaround they use because a feature is missing\n" +
    "\n" +
    "What does NOT count as a feature request:\n" +
    "- Bug reports (something broken that should work)\n" +
    "- Resolved confusion (user was unsure how to use existing functionality)\n" +
    "- Off-topic or conversational content\n" +
    "\n" +
    "For each identified request in the provided chat data, call record_feature_request with content, summary, evidence_quote (verbatim user quote), tags. Do not fabricate.\n" +
    "If nothing found, record nothing and return \"No feature requests found.\"\n" +
    "\n" +
    "Dedupe note: if the user later repeats the same request, emit a fresh record — the reviewer will dismiss duplicates via the /feature-requests page. Do not attempt to guess prior runs.\n" +
    "\n" +
    "Constraints: your ONLY callable tool is record_feature_request. No file access, no web search, no other channels.",
  allowedTools: ["mcp__mining-tools__record_feature_request"],
  // Fence: even though Adam's system-MCP carve-out auto-grants the
  // mcp__execution-tools__* namespace (see role-mcp-registry.ts SYSTEM_MCP_PREFIXES),
  // this role is read-only by design. Enumerate every execution-tools mutation tool
  // via EXECUTION_TOOLS_MUTATION_TOOLS — single source of truth, drift-checked in CI.
  disallowedTools: ["Write", "Edit", "Bash", "WebSearch", "WebFetch", "Read", "Grep", "Glob", ...EXECUTION_TOOLS_MUTATION_TOOLS],
  evaluationCriteria: { precision: 5, recall: 3, false_positive_rate: 5 },
  executionMode: "isolated",
};
