import { isAbsolute } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ComparisonOp = "<" | ">" | "<=" | ">=" | "==" | "!=";

export type ParsedAssertion =
  | { kind: "comparison"; key: string; op: ComparisonOp; value: number | string | boolean }
  | { kind: "between"; key: string; min: number; max: number }
  | { kind: "in"; key: string; values: Array<number | string | boolean> }
  | { kind: "matches"; key: string; regexSource: string; regexFlags: string }
  | { kind: "script"; scriptPath: string };

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class DslParseError extends Error {
  constructor(input: string, reason: string) {
    super(`DSL parse error in "${input}": ${reason}`);
    this.name = "DslParseError";
  }
}

// ---------------------------------------------------------------------------
// Key validation — dotted-snake form
// ---------------------------------------------------------------------------

const KEY_RE = /^[a-z][a-z0-9_.]*$/i;
const DOTDOT_RE = /\.\./;

function validateKey(key: string): void {
  if (!KEY_RE.test(key)) {
    throw new DslParseError(key, `invalid handler key format "${key}" — must match [a-z][a-z0-9_.]*`);
  }
  if (DOTDOT_RE.test(key)) {
    throw new DslParseError(key, `handler key must not contain ".."`);
  }
}

// ---------------------------------------------------------------------------
// Value parsing for comparison operators
// ---------------------------------------------------------------------------

function parseValue(raw: string): number | string | boolean {
  const trimmed = raw.trim();
  // Try JSON.parse first (handles "42", "\"foo\"", "true", "false")
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "number" || typeof parsed === "string" || typeof parsed === "boolean") {
      return parsed;
    }
  } catch {
    // fall through
  }
  // Fall back to bare number
  const num = parseFloat(trimmed);
  if (!Number.isNaN(num)) return num;
  // Return as-is string
  return trimmed;
}

// ---------------------------------------------------------------------------
// Regex match helpers
// ---------------------------------------------------------------------------

// matches /pattern/flags
const RE_MATCHES = /^([a-z][a-z0-9_.]*)\s+matches\s+\/(.+)\/([gimsuy]*)$/i;
// <= >= == !=
const RE_TWO_CHAR_OP = /^([a-z][a-z0-9_.]*)\s*(<=|>=|==|!=)\s*(.+)$/i;
// < >
const RE_ONE_CHAR_OP = /^([a-z][a-z0-9_.]*)\s*(<|>)\s*(.+)$/i;
// between A and B
const RE_BETWEEN = /^([a-z][a-z0-9_.]*)\s+between\s+(-?\d+(?:\.\d+)?)\s+and\s+(-?\d+(?:\.\d+)?)$/i;
// in [v1, v2, ...]
const RE_IN = /^([a-z][a-z0-9_.]*)\s+in\s+\[([^\]]+)\]$/i;

// ---------------------------------------------------------------------------
// Script escape hatch (object form)
// ---------------------------------------------------------------------------

export function parseAssertion(input: string | { script: string }): ParsedAssertion {
  // Script escape hatch — object form: { script: "/absolute/path/to/check.sh" }
  if (typeof input === "object" && input !== null && "script" in input) {
    const scriptPath = String(input.script);
    if (!isAbsolute(scriptPath)) {
      throw new DslParseError(
        `{script: "${scriptPath}"}`,
        "script path must be absolute",
      );
    }
    return { kind: "script", scriptPath };
  }

  if (typeof input !== "string") {
    throw new DslParseError(String(input), "assertion must be a string or {script: string} object");
  }

  const s = input.trim();
  if (!s) throw new DslParseError(s, "empty assertion string");

  // matches /regex/flags
  {
    const m = RE_MATCHES.exec(s);
    if (m) {
      const key = m[1]!;
      validateKey(key);
      return { kind: "matches", key, regexSource: m[2]!, regexFlags: m[3] ?? "" };
    }
  }

  // between A and B
  {
    const m = RE_BETWEEN.exec(s);
    if (m) {
      const key = m[1]!;
      validateKey(key);
      return {
        kind: "between",
        key,
        min: parseFloat(m[2]!),
        max: parseFloat(m[3]!),
      };
    }
  }

  // in [v1, v2, ...]
  {
    const m = RE_IN.exec(s);
    if (m) {
      const key = m[1]!;
      validateKey(key);
      const inner = m[2]!;
      const values: Array<number | string | boolean> = [];
      for (const item of inner.split(",")) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (
            typeof parsed === "number" ||
            typeof parsed === "string" ||
            typeof parsed === "boolean"
          ) {
            values.push(parsed);
          } else {
            values.push(trimmed);
          }
        } catch {
          values.push(trimmed);
        }
      }
      return { kind: "in", key, values };
    }
  }

  // <= >= == !=  (two-char operators — must come before < and >)
  {
    const m = RE_TWO_CHAR_OP.exec(s);
    if (m) {
      const key = m[1]!;
      validateKey(key);
      return {
        kind: "comparison",
        key,
        op: m[2] as ComparisonOp,
        value: parseValue(m[3]!),
      };
    }
  }

  // <  >
  {
    const m = RE_ONE_CHAR_OP.exec(s);
    if (m) {
      const key = m[1]!;
      validateKey(key);
      return {
        kind: "comparison",
        key,
        op: m[2] as ComparisonOp,
        value: parseValue(m[3]!),
      };
    }
  }

  throw new DslParseError(s, "unrecognized assertion syntax — expected key <op> value, between, in [...], matches /.../, or {script: ...}");
}
