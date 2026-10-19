import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getRoleWorkspacePath } from "../store/role-workspace.js";
import { getLogger } from "../lib/logger.js";
const log = getLogger("manager");

/**
 * Parse a role's .env file and return all key-value pairs.
 * Returns null if the file does not exist.
 */
export function readRoleEnvFile(roleName: string): Record<string, string> | null {
  const envPath = join(getRoleWorkspacePath(roleName), ".env");
  if (!existsSync(envPath)) return null;
  const content = readFileSync(envPath, "utf-8");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const stripped = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = stripped.indexOf("=");
    if (eq === -1) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.includes("$")) {
      value = value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, braced, bare) => {
        const ref = braced ?? bare;
        return result[ref] ?? process.env[ref] ?? "";
      });
      if (!value) continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * Seed role envVars from .env file. Only adds keys that don't already exist in DB.
 * Filters out ANTHROPIC_* keys with a warning.
 * Returns the merged envVars (DB values take priority).
 */
export function seedRoleEnvFromFile(
  roleName: string,
  existingDbEnvVars: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const fileEnv = readRoleEnvFile(roleName);
  if (!fileEnv) return existingDbEnvVars;

  const merged = { ...existingDbEnvVars };
  let seeded = 0;
  for (const [key, value] of Object.entries(fileEnv)) {
    if (key.startsWith("ANTHROPIC_")) {
      log.warn({ roleName, key }, "Role .env contains ANTHROPIC_* key; ignored (managed globally)");
      continue;
    }
    if (!(key in merged)) {
      merged[key] = value;
      seeded++;
    }
  }

  if (seeded > 0) {
    log.info({ roleName, seeded }, "Seeded role envVars from .env file");
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Compare role DB envVars with role .env file. Returns diffs. */
export function computeRoleEnvDiff(
  roleName: string,
  dbEnvVars: Record<string, string> | undefined,
): Array<{ envKey: string; dbValue: string; envValue: string }> {
  const fileEnv = readRoleEnvFile(roleName);
  if (!fileEnv) return [];
  const db = dbEnvVars ?? {};
  const diffs: Array<{ envKey: string; dbValue: string; envValue: string }> = [];

  for (const [key, envVal] of Object.entries(fileEnv)) {
    if (key.startsWith("ANTHROPIC_")) continue;
    const dbVal = db[key] ?? "";
    if (dbVal !== envVal) {
      diffs.push({ envKey: key, dbValue: dbVal, envValue: envVal });
    }
  }
  // Keys in DB but not in .env
  for (const [key, dbVal] of Object.entries(db)) {
    if (key in fileEnv) continue;
    diffs.push({ envKey: key, dbValue: dbVal, envValue: "" });
  }

  return diffs;
}

/** Write role DB envVars to role .env file. Returns count of changes. */
export function syncRoleDbToEnvFile(
  roleName: string,
  dbEnvVars: Record<string, string> | undefined,
): number {
  const envPath = join(getRoleWorkspacePath(roleName), ".env");
  const db = dbEnvVars ?? {};
  const lines: string[] = [];
  const written = new Set<string>();

  // Preserve existing file structure if it exists
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        lines.push(line);
        continue;
      }
      const stripped = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
      const eq = stripped.indexOf("=");
      if (eq === -1) { lines.push(line); continue; }
      const key = stripped.slice(0, eq).trim();
      const prefix = trimmed.startsWith("export ") ? "export " : "";
      if (key in db) {
        lines.push(`${prefix}${key}=${db[key]}`);
        written.add(key);
      }
      // Keys not in DB are dropped (DB is source of truth)
    }
  }

  // Append keys in DB but not in .env
  let changed = 0;
  for (const [key, value] of Object.entries(db)) {
    if (written.has(key)) { changed++; continue; }
    if (value && value.length > 0) {
      lines.push(`${key}=${value}`);
      changed++;
    }
  }

  writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");
  return changed;
}
