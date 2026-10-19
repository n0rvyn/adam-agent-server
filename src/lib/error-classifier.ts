/**
 * Error classifier -- structured runtime error taxonomy for ExecutionManager.
 * DP-002 (Chosen A): ExecutionManager classifies errors at source.
 */

export type ErrorCategory =
  | "AUTH"
  | "RATE_LIMIT"
  | "NETWORK"
  | "MALFORMED_REQUEST"
  | "TIMEOUT"
  | "CONTEXT_OVERFLOW"
  | "TOOL_UNAVAILABLE"
  | "SANDBOX_VIOLATION"
  | "INTERNAL_ERROR"
  | "UNKNOWN";

export interface ClassifiedError {
  category: ErrorCategory;
  originalError: string;
  retryable: boolean;
  /** What the user should do (e.g., "Update API key") */
  userAction?: string;
  /** Can retry with the same Role? */
  sameRoleRetry?: boolean;
  /** Would a different Role help? */
  differentRoleHelp?: boolean;
}

interface ClassifyContext {
  httpStatus?: number;
  toolName?: string;
  sandboxViolation?: boolean;
}

// ---------------------------------------------------------------------------
// Classification rules
// ---------------------------------------------------------------------------

/**
 * Classify a raw error message + context into a structured ClassifiedError.
 * Uses regex + keyword matching against the error message string.
 */
export function classifyError(errorMessage: string, context?: ClassifyContext): ClassifiedError {
  const msg = errorMessage.toLowerCase();
  const originalError = errorMessage;

  // AUTH: 401, invalid key, permission denied by external service
  if (
    /\b401\b/.test(msg) ||
    /unauthorized/i.test(msg) ||
    /invalid.*(?:api.?)?key/i.test(msg) ||
    /auth.*fail/i.test(msg) ||
    /invalid.*token/i.test(msg) ||
    (context?.httpStatus === 401)
  ) {
    return {
      category: "AUTH",
      originalError,
      retryable: false,
      userAction: "Update the API key or credentials in the Role configuration",
      sameRoleRetry: false,
      differentRoleHelp: false,
    };
  }

  // RATE_LIMIT: 429, quota exhausted, too many requests
  if (
    /\b429\b/.test(msg) ||
    /rate.?limit/i.test(msg) ||
    /too many requests/i.test(msg) ||
    /quota.?exhaust/i.test(msg) ||
    /rate.?limit.?exceed/i.test(msg) ||
    /too.?many.?calls/i.test(msg)
  ) {
    return {
      category: "RATE_LIMIT",
      originalError,
      retryable: true,
      userAction: "Wait before retrying, or increase the rate limit quota",
      sameRoleRetry: true,
      differentRoleHelp: false,
    };
  }

  // NETWORK: Connection refused, DNS failure, timeout connecting
  if (
    /econnrefused/i.test(msg) ||
    /enotfound/i.test(msg) ||
    /dns/i.test(msg) ||
    /connection.?refused/i.test(msg) ||
    /connection.?reset/i.test(msg) ||
    /connection.?timed? ?out/i.test(msg) ||
    /fetch.?failed/i.test(msg) ||
    /network.?error/i.test(msg) ||
    /socket.?hang.?up/i.test(msg) ||
    /etimedout/i.test(msg)
  ) {
    return {
      category: "NETWORK",
      originalError,
      retryable: true,
      userAction: "Check network connectivity and that the target service is reachable",
      sameRoleRetry: true,
      differentRoleHelp: false,
    };
  }

  // CONTEXT_OVERFLOW: Prompt too long, context window exceeded
  if (
    /prompt is too long/i.test(msg) ||
    /context.*exceed/i.test(msg) ||
    /context.*window/i.test(msg) ||
    /too many tokens/i.test(msg) ||
    /max.?tokens/i.test(msg) ||
    /token.?limit/i.test(msg)
  ) {
    return {
      category: "CONTEXT_OVERFLOW",
      originalError,
      retryable: false,
      userAction: "Shorten the task prompt or simplify the request",
      sameRoleRetry: false,
      differentRoleHelp: false,
    };
  }

  // SANDBOX_VIOLATION: OS sandbox denied an operation
  if (
    context?.sandboxViolation ||
    /sandbox/i.test(msg) ||
    /not allowed.*sandbox/i.test(msg) ||
    /sandbox.*deny/i.test(msg) ||
    /operation.*denied.*sandbox/i.test(msg)
  ) {
    return {
      category: "SANDBOX_VIOLATION",
      originalError,
      retryable: false,
      userAction: "Grant filesystem access in Role settings, or run without sandbox",
      sameRoleRetry: false,
      differentRoleHelp: true,
    };
  }

  // TOOL_UNAVAILABLE: Required tool not installed or blocked by sandbox
  if (
    /tool.*not found/i.test(msg) ||
    /command not found/i.test(msg) ||
    /enoent/i.test(msg) ||
    /no such file/i.test(msg) ||
    /mcp.*error.*tool/i.test(msg) ||
    /tool.*blocked/i.test(msg) ||
    (context?.toolName && /not.*found/.test(msg) && /tool/.test(msg))
  ) {
    return {
      category: "TOOL_UNAVAILABLE",
      originalError,
      retryable: false,
      userAction: "Install the required tool or plugin, or add it to the Role's allowed tools",
      sameRoleRetry: false,
      differentRoleHelp: true,
    };
  }

  // TIMEOUT: Task-level timeout (not network-level)
  if (
    /timeout/i.test(msg) ||
    /timed out/i.test(msg) ||
    /exceeded.*seconds/i.test(msg)
  ) {
    return {
      category: "TIMEOUT",
      originalError,
      retryable: true,
      userAction: "Increase the task timeout or simplify the task",
      sameRoleRetry: true,
      differentRoleHelp: false,
    };
  }

  // MALFORMED_REQUEST: Bad parameters, invalid URL, wrong method
  if (
    /invalid.*url/i.test(msg) ||
    /bad request/i.test(msg) ||
    /400\b/.test(msg) ||
    /wrong.*method/i.test(msg) ||
    /invalid.*param/i.test(msg) ||
    /missing.*param/i.test(msg)
  ) {
    return {
      category: "MALFORMED_REQUEST",
      originalError,
      retryable: false,
      userAction: "Fix the task parameters and retry",
      sameRoleRetry: false,
      differentRoleHelp: false,
    };
  }

  // INTERNAL_ERROR: Unexpected SDK/runtime error
  if (
    /internal.*error/i.test(msg) ||
    /unexpected.*error/i.test(msg) ||
    /500\b/.test(msg) ||
    /503\b/.test(msg)
  ) {
    return {
      category: "INTERNAL_ERROR",
      originalError,
      retryable: true,
      userAction: "The service had an internal error. Retry may succeed.",
      sameRoleRetry: true,
      differentRoleHelp: false,
    };
  }

  // UNKNOWN
  return {
    category: "UNKNOWN",
    originalError,
    retryable: false,
    userAction: undefined,
    sameRoleRetry: false,
    differentRoleHelp: false,
  };
}
