/**
 * Path utilities.
 *
 * @deprecated Most functions in this file are deprecated — OS sandbox enforces filesystem
 * boundaries. Only `redactSensitiveData()`, `FILE_TOOLS`, and `resolveTilde()` are retained.
 */

import * as os from "node:os";
import * as path from "node:path";
import { REDACTION_PATTERNS, MAX_TOOL_OUTPUT_SIZE } from "../shared/constants.js";

export function resolveTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Redact sensitive values (API keys, passwords, tokens) from tool output strings.
 */
export function redactSensitiveData(output: string): string {
  let redacted = output;
  for (const pattern of REDACTION_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    redacted = redacted.replace(regex, "[REDACTED]");
  }
  return redacted;
}

/** Tools that access file paths. Retained for reference — path restriction is now handled by OS sandbox. */
export const FILE_TOOLS = new Set(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);

export { MAX_TOOL_OUTPUT_SIZE };
