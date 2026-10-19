export const BUILT_IN_TOOLS = [
  "Read", "Write", "Edit", "Bash", "Grep", "Glob",
  "WebSearch", "WebFetch", "LSP", "NotebookEdit", "Agent",
] as const;

export const DEFAULT_DENIED_READ_PATHS = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "/etc/shadow",
] as const;

/** @deprecated Use DEFAULT_DENIED_READ_PATHS instead */
export const DEFAULT_SENSITIVE_PATHS = DEFAULT_DENIED_READ_PATHS;

/** Default glob patterns for operations requiring privilege escalation (SDK Permission Rule glob syntax). */
export const DEFAULT_APPROVAL_PATTERNS = [
  "rm -rf *",
  "git push*",
  "git reset*",
  "curl * -X POST*",
  "curl * --request POST*",
] as const;

import { join } from "path";
import { homedir } from "os";

export const RUNTIME_DIR = join(homedir(), ".adam");
export const DB_PATH = join(RUNTIME_DIR, "adam.db");
export const CONFIG_PATH = join(RUNTIME_DIR, "adam.config.yaml");
export const ENV_PATH = join(RUNTIME_DIR, ".env");
export const CLAUDE_MD_PATH = join(RUNTIME_DIR, "CLAUDE.md");
export const LOGS_DIR = join(RUNTIME_DIR, "logs");

export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = "0.0.0.0";

export const REDACTION_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /password\s*[=:]\s*\S+/gi,
  /secret\s*[=:]\s*\S+/gi,
  /token\s*[=:]\s*\S+/gi,
] as const;

export const MAX_TOOL_OUTPUT_SIZE = 10 * 1024; // 10KB

/** User-facing label for the ChatManager self-check audit sidecar note (Option A).
 *  Shared by the channel-inline path (message-handler) and the TUI renderer. The web
 *  renderer mirrors this literal by hand — the web workspace does not import backend `src/`. */
export const AUDIT_SIDECAR_LABEL = "自检 · 审计边车";
