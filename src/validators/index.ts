import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, basename } from "node:path";
import vm from "node:vm";

import { parseAssertion, DslParseError, type ParsedAssertion } from "./dsl.js";
import { handlers, type HandlerFn } from "./handlers.js";
import {
  NoHandlerError,
  AssertionFailedError,
  HandlerRuntimeError,
} from "./errors.js";

export { NoHandlerError, AssertionFailedError, HandlerRuntimeError } from "./errors.js";
export { DslParseError } from "./dsl.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ValidateArtifactOpts {
  /**
   * Override handler registry (test injection). Defaults to built-in `handlers`.
   * Note: raw Error thrown by injected handlers propagates through — the dispatcher
   * does NOT re-wrap user-injected handlers, so callers can distinguish handler
   * bugs from infrastructure bugs.
   */
  handlerRegistry?: Record<string, HandlerFn>;
  /**
   * Per-assertion handler args (e.g. {schema: ...} for json.schema_valid).
   * Matched by index to `assertions`.
   */
  handlerArgsByIndex?: Array<unknown>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function validateArtifact(
  filePath: string,
  assertions: ReadonlyArray<string | { script: string }>,
  opts: ValidateArtifactOpts = {},
): Promise<void> {
  const registry = opts.handlerRegistry ?? handlers;

  for (let i = 0; i < assertions.length; i++) {
    const raw = assertions[i];
    const parsed = parseAssertion(raw);

    if (parsed.kind === "script") {
      await runScript(parsed.scriptPath, filePath);
      continue;
    }

    const fn = registry[parsed.key];
    if (!fn) throw new NoHandlerError(parsed.key);

    const args = opts.handlerArgsByIndex?.[i];
    const measured = await fn(filePath, args);
    compare(parsed, measured);
  }
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

function compare(parsed: ParsedAssertion, measured: number | string | boolean): void {
  switch (parsed.kind) {
    case "comparison": {
      const { key, op, value } = parsed;
      let ok = false;
      if (op === "<") ok = (measured as number) < (value as number);
      else if (op === ">") ok = (measured as number) > (value as number);
      else if (op === "<=") ok = (measured as number) <= (value as number);
      else if (op === ">=") ok = (measured as number) >= (value as number);
      else if (op === "==") ok = measured == value; // loose equality covers bools
      else if (op === "!=") ok = measured != value;
      if (!ok) throw new AssertionFailedError(key, measured, `${op} ${value}`);
      break;
    }
    case "between": {
      const { key, min, max } = parsed;
      if ((measured as number) < min || (measured as number) > max) {
        throw new AssertionFailedError(key, measured, `between ${min} and ${max}`);
      }
      break;
    }
    case "in": {
      const { key, values } = parsed;
      if (!values.includes(measured as number | string)) {
        throw new AssertionFailedError(key, measured, `in [${values.join(", ")}]`);
      }
      break;
    }
    case "matches": {
      const { key, regexSource, regexFlags } = parsed;
      // safeRegexMatch handles ReDoS protection via vm.runInContext timeout
      const matches = safeRegexMatch(String(measured), regexSource, regexFlags, 100);
      if (!matches) {
        throw new AssertionFailedError(key, measured, `matches /${regexSource}/${regexFlags}`);
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Script escape hatch
// ---------------------------------------------------------------------------

async function runScript(scriptPath: string, filePath: string): Promise<void> {
  // Defense-in-depth: re-check absolute path even though Task 2 parser already enforces
  if (!isAbsolute(scriptPath)) {
    throw new HandlerRuntimeError("script", `script path must be absolute: ${scriptPath}`);
  }
  try {
    await execFileAsync(scriptPath, [filePath], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; code?: string };
    if (e.code === "ENOENT") {
      throw new HandlerRuntimeError("script", `script not found: ${scriptPath}`);
    }
    const exitCode = (e as unknown as { exitCode?: number }).exitCode;
    throw new AssertionFailedError(
      "script:" + basename(scriptPath),
      exitCode ?? "error",
      e.stderr?.trim() ?? e.message,
    );
  }
}

// ---------------------------------------------------------------------------
// Safe regex evaluation (ReDoS protection)
// ---------------------------------------------------------------------------

function safeRegexMatch(
  value: string,
  source: string,
  flags: string,
  timeoutMs: number,
): boolean {
  const sandbox: { value: string; regex: RegExp; result: boolean } = {
    value,
    regex: new RegExp(source, flags),
    result: false,
  };
  vm.createContext(sandbox);
  try {
    vm.runInContext("result = regex.test(value)", sandbox, { timeout: timeoutMs });
    return sandbox.result;
  } catch (e) {
    throw new HandlerRuntimeError(
      "matches",
      `regex evaluation timeout or error: ${(e as Error).message}`,
    );
  }
}
