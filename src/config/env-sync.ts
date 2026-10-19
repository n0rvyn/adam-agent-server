import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { ENV_PATH } from "../shared/constants.js";

/** Known env keys that Adam manages (maps env var name → config dot-path) */
export const ENV_TO_CONFIG: Record<string, string> = {
  ANTHROPIC_API_KEY: "anthropic.apiKey",
  ANTHROPIC_BASE_URL: "anthropic.baseUrl",
  ANTHROPIC_MODEL: "anthropic.model",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic.defaultOpusModel",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "anthropic.defaultSonnetModel",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic.defaultHaikuModel",
  ANTHROPIC_SMALL_FAST_MODEL: "anthropic.smallFastModel",
  ADAM_EMAIL_ADDRESS: "emailGateway.address",
  ADAM_EMAIL_IMAP_HOST: "emailGateway.imap.host",
  ADAM_EMAIL_IMAP_PORT: "emailGateway.imap.port",
  ADAM_EMAIL_IMAP_SECURE: "emailGateway.imap.secure",
  ADAM_EMAIL_IMAP_USER: "emailGateway.imap.auth.user",
  ADAM_EMAIL_IMAP_PASS: "emailGateway.imap.auth.pass",
  ADAM_EMAIL_IMAP_MAILBOX: "emailGateway.imap.mailbox",
  ADAM_EMAIL_SMTP_HOST: "emailGateway.smtp.host",
  ADAM_EMAIL_SMTP_PORT: "emailGateway.smtp.port",
  ADAM_EMAIL_SMTP_SECURE: "emailGateway.smtp.secure",
  ADAM_EMAIL_SMTP_USER: "emailGateway.smtp.auth.user",
  ADAM_EMAIL_SMTP_PASS: "emailGateway.smtp.auth.pass",
  ADAM_EMAIL_SMTP_FROM: "emailGateway.smtp.from",
  ADAM_EMAIL_SUBJECT_PREFIX: "emailGateway.subjectPrefix",
};
export const CONFIG_TO_ENV: Record<string, string> = Object.fromEntries(
  Object.entries(ENV_TO_CONFIG).map(([k, v]) => [v, k]),
);

export function isManagedEnvKey(key: string): boolean {
  return key in ENV_TO_CONFIG;
}

export function coerceEnvValueForConfigPath(configPath: string, value: string): unknown {
  if (configPath === "server.port" || configPath.endsWith(".port")) {
    const numberValue = parseInt(value, 10);
    return Number.isNaN(numberValue) ? value : numberValue;
  }
  if (configPath.endsWith(".secure") || configPath.endsWith(".enabled")) {
    return value === "true" || value === "1";
  }
  return value;
}

/** Parse a .env file and return all key-value pairs. Internal helper. */
function parseEnvContent(content: string): Record<string, string> {
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
    // Expand variable references: $VAR and ${VAR} using already-parsed values + process.env
    if (value.includes("$")) {
      value = value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, braced, bare) => {
        const ref = braced ?? bare;
        return result[ref] ?? process.env[ref] ?? "";
      });
      if (!value) continue; // resolved to empty
    }
    result[key] = value;
  }
  return result;
}

/** Read ~/.adam/.env and return { envKey: value } for Adam-managed keys only */
export function readEnvFile(): Record<string, string> | null {
  if (!existsSync(ENV_PATH)) return null;
  const all = parseEnvContent(readFileSync(ENV_PATH, "utf-8"));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) {
    if (key in ENV_TO_CONFIG) result[key] = value;
  }
  return result;
}

/** Read ~/.adam/.env and return ALL key-value pairs (managed + custom). */
export function readAllEnvVars(): Record<string, string> | null {
  if (!existsSync(ENV_PATH)) return null;
  return parseEnvContent(readFileSync(ENV_PATH, "utf-8"));
}

/** Compare DB config values with .env file values. Returns diffs for managed + custom keys. */
export function computeEnvDiff(dbConfig: Record<string, unknown>): Array<{
  configPath: string; envKey: string; dbValue: string; envValue: string;
}> {
  const allEnvValues = readAllEnvVars();
  if (!allEnvValues) return [];
  const diffs: Array<{ configPath: string; envKey: string; dbValue: string; envValue: string }> = [];

  // Managed keys (ANTHROPIC_*, ADAM_*)
  for (const [envKey, configPath] of Object.entries(ENV_TO_CONFIG)) {
    const dbVal = dbConfig[configPath];
    const envVal = allEnvValues[envKey];
    if (envVal === undefined) continue;
    const dbStr = dbVal ? String(dbVal) : "";
    if (dbStr !== envVal) {
      diffs.push({ configPath, envKey, dbValue: dbStr, envValue: envVal });
    }
  }

  // Custom keys (not in ENV_TO_CONFIG): compare against defaults.env in DB
  const dbCustomEnv = (dbConfig["defaults.env"] ?? {}) as Record<string, string>;
  for (const [envKey, envVal] of Object.entries(allEnvValues)) {
    if (envKey in ENV_TO_CONFIG) continue; // already handled
    const dbVal = dbCustomEnv[envKey] ?? "";
    if (dbVal !== envVal) {
      diffs.push({ configPath: `defaults.env.${envKey}`, envKey, dbValue: dbVal, envValue: envVal });
    }
  }
  // Also check keys in DB custom env but not in .env
  for (const [key, dbVal] of Object.entries(dbCustomEnv)) {
    if (key in allEnvValues) continue; // already handled
    diffs.push({ configPath: `defaults.env.${key}`, envKey: key, dbValue: dbVal, envValue: "" });
  }

  return diffs;
}

/** Write DB values back to .env file. Preserves comments and structure. Handles managed + custom keys. */
export function syncDbToEnvFile(dbConfig: Record<string, unknown>): number {
  if (!existsSync(ENV_PATH)) return 0;
  const content = readFileSync(ENV_PATH, "utf-8");
  const lines = content.split("\n");
  let changed = 0;
  const written = new Set<string>();

  const dbCustomEnv = (dbConfig["defaults.env"] ?? {}) as Record<string, string>;

  // Update existing lines in-place (both managed and custom keys)
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const stripped = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = stripped.indexOf("=");
    if (eq === -1) continue;
    const key = stripped.slice(0, eq).trim();
    const prefix = trimmed.startsWith("export ") ? "export " : "";

    // Managed key (ANTHROPIC_* etc.)
    const configPath = ENV_TO_CONFIG[key];
    if (configPath) {
      const dbVal = dbConfig[configPath];
      if (dbVal !== undefined && dbVal !== null && String(dbVal).length > 0) {
        lines[i] = `${prefix}${key}=${String(dbVal)}`;
        written.add(key);
        changed++;
      }
      continue;
    }

    // Custom key
    if (key in dbCustomEnv) {
      lines[i] = `${prefix}${key}=${dbCustomEnv[key]}`;
      written.add(key);
      changed++;
    }
  }

  // Append managed keys in DB but not in .env
  for (const [envKey, configPath] of Object.entries(ENV_TO_CONFIG)) {
    if (written.has(envKey)) continue;
    const dbVal = dbConfig[configPath];
    if (dbVal && String(dbVal).length > 0) {
      lines.push(`${envKey}=${String(dbVal)}`);
      changed++;
    }
  }

  // Append custom keys in DB but not in .env
  for (const [key, value] of Object.entries(dbCustomEnv)) {
    if (written.has(key)) continue;
    if (value && value.length > 0) {
      lines.push(`${key}=${value}`);
      changed++;
    }
  }

  if (changed > 0) {
    writeFileSync(ENV_PATH, lines.join("\n"));
  }
  return changed;
}
