/**
 * Signal Sanitizer — tag-and-flag prompt injection detection for external inputs.
 *
 * Scans content from external sources (webhook bodies, iCloud reads, email summaries)
 * for known prompt-injection patterns. Does NOT modify content; instead returns flags
 * and a recommended trust_level downgrade. Caller (e.g., webhook source, iCloud reader)
 * is responsible for downgrading the resulting events.trust_level when suspicious=true.
 *
 * Pattern set version: 1
 */

export interface SanitizerFlag {
  pattern: string;
  matchedSnippet: string; // first 100 chars of match for audit
  location: string; // dotted path to the field, e.g. "payload.body"
}

export interface SanitizerResult {
  /** Original input — NEVER modified */
  original: unknown;
  /** True if any pattern hit OR any safety limit exceeded */
  suspicious: boolean;
  /** Per-match flags for audit */
  flags: SanitizerFlag[];
  /** Recommended trust_level: "untrusted" if suspicious, "trusted" otherwise */
  recommendedTrustLevel: "trusted" | "untrusted";
}

const MAX_RECURSION_DEPTH = 10;
const MAX_SCAN_CHARS = 64 * 1024;

// Linear (non-backtracking) patterns. Comments explain what each catches.
const INJECTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "system_tag", re: /<\s*\/?\s*system\s*>/i }, // <system>, </system>
  { name: "im_start_tag", re: /<\|im_start\|>/i }, // ChatML jailbreak
  { name: "im_end_tag", re: /<\|im_end\|>/i },
  { name: "ignore_instructions", re: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instruction|prompt|message)/i },
  { name: "disregard_prior", re: /disregard\s+(?:all\s+)?(?:previous|prior|above)/i },
  { name: "you_are_now", re: /you\s+are\s+now\s+(?:a\s+)?(?:new|different|jailbroken|DAN)/i },
  { name: "act_as_jailbreak", re: /act\s+as\s+(?:if\s+you\s+(?:are|were)\s+)?(?:DAN|jailbroken|unrestricted)/i },
  { name: "claude_role_inject", re: /\b(?:assistant|claude|gpt|chatgpt)\s*:\s*\n/i },
  { name: "hidden_instruction_marker", re: /\[\[\s*(?:HIDDEN|SECRET|INTERNAL)\s+INSTRUCTION\s*\]\]/i },
  { name: "prompt_leak_request", re: /(?:reveal|print|show|output|leak)\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions)/i },
];

export function sanitizeSignal(input: unknown, sourceLabel: string): SanitizerResult {
  const flags: SanitizerFlag[] = [];

  let totalScanned = 0;
  let exceededLimits = false;

  function walk(value: unknown, depth: number, path: string): void {
    if (exceededLimits) return;
    if (depth > MAX_RECURSION_DEPTH) {
      flags.push({ pattern: "depth_exceeded", matchedSnippet: "", location: path });
      exceededLimits = true;
      return;
    }
    if (typeof value === "string") {
      totalScanned += value.length;
      if (totalScanned > MAX_SCAN_CHARS) {
        flags.push({ pattern: "size_exceeded", matchedSnippet: "", location: path });
        exceededLimits = true;
        return;
      }
      for (const { name, re } of INJECTION_PATTERNS) {
        const m = value.match(re);
        if (m) {
          flags.push({
            pattern: name,
            matchedSnippet: m[0].slice(0, 100),
            location: path,
          });
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, idx) => walk(item, depth + 1, `${path}[${idx}]`));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, depth + 1, path ? `${path}.${k}` : k);
      }
    }
  }

  try {
    walk(input, 0, "");
  } catch {
    // Fail-safe: treat any sanitizer error as suspicious
    flags.push({ pattern: "sanitizer_error", matchedSnippet: "", location: sourceLabel });
  }

  const suspicious = flags.length > 0;
  return {
    original: input,
    suspicious,
    flags,
    recommendedTrustLevel: suspicious ? "untrusted" : "trusted",
  };
}

/**
 * Format an event payload for inclusion in LLM context.
 * If trust_level === "untrusted", wraps the JSON in an UNTRUSTED_INPUT fenced block
 * with explicit instructions for the LLM to treat content as data, not commands.
 *
 * Truncation order: when `maxBodyChars` is set, the JSON body is truncated BEFORE
 * fencing — guarantees the closing `</UNTRUSTED_INPUT>` tag is always present even
 * if the caller's display cap would otherwise chop off the closer (defense-in-depth).
 */
export function formatEventForLLM(args: {
  payload: unknown;
  trustLevel: string;
  source: string;
  /** Optional cap on the JSON body length BEFORE wrapping; appends "...[truncated]" if applied */
  maxBodyChars?: number;
}): string {
  let json = JSON.stringify(args.payload);
  if (args.maxBodyChars !== undefined && json.length > args.maxBodyChars) {
    json = json.slice(0, args.maxBodyChars) + "...[truncated]";
  }
  if (args.trustLevel !== "untrusted") {
    return json;
  }
  return [
    `<UNTRUSTED_INPUT source="${escapeForAttr(args.source)}">`,
    json,
    "</UNTRUSTED_INPUT>",
  ].join("\n");
}

function escapeForAttr(s: string): string {
  return s.replace(/[<>"&]/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "&": return "&amp;";
      default: return c;
    }
  });
}
