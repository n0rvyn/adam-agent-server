import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { RUNTIME_DIR } from "../shared/constants.js";

/**
 * Load .env files into process.env.
 *
 * Resolution order (later files override earlier):
 *   1. .env              — base defaults
 *   2. .env.local         — local overrides (gitignored)
 *   3. ADAM_ENV_FILE      — explicit override (e.g., .env.test)
 *
 * Existing process.env values are NOT overwritten (env vars set before
 * the server starts always win).
 *
 * Supports:
 *   - Comments (#) and blank lines
 *   - Quoted values: KEY="value" or KEY='value'
 *   - Variable expansion: KEY=$OTHER or KEY=${OTHER}
 *   - export prefix: export KEY=value (stripped)
 */
export function loadDotEnv(cwd = RUNTIME_DIR): string[] {
  const loaded: string[] = [];

  // Determine files to load (order matters: first loaded wins per key)
  const files: string[] = [];
  const explicit = process.env.ADAM_ENV_FILE;

  // Load highest priority first (first loaded wins per key due to "don't overwrite"):
  //   1. ADAM_ENV_FILE   (explicit override, e.g., .env.test)
  //   2. .env.local      (local overrides, gitignored)
  //   3. .env            (base defaults)
  if (explicit) {
    files.push(resolve(cwd, explicit));
  }
  files.push(resolve(cwd, ".env.local"));
  files.push(resolve(cwd, ".env"));

  for (const filePath of files) {
    if (!existsSync(filePath)) continue;
    const count = parseEnvFile(filePath);
    if (count > 0) {
      loaded.push(filePath);
    }
  }

  return loaded;
}

function parseEnvFile(filePath: string): number {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  let count = 0;

  for (const line of lines) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Strip optional 'export ' prefix
    if (trimmed.startsWith("export ")) {
      trimmed = trimmed.slice(7).trim();
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    if (!key) continue;

    let value = trimmed.slice(eqIndex + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Expand variable references: $VAR and ${VAR}
    value = value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, braced, bare) => {
      const ref = braced ?? bare;
      return process.env[ref] ?? "";
    });

    // ANTHROPIC_* vars: always override (parent process env from Claude Code
    // session must not leak into Adam's SDK calls — see lesson 2026-03-29)
    // Other vars: don't overwrite existing env vars
    if (key.startsWith("ANTHROPIC_") || process.env[key] === undefined) {
      process.env[key] = value;
      count++;
    }
  }

  return count;
}
