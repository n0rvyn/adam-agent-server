import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR } from "../shared/constants.js";
import { setConfigValue } from "../store/config.js";
import { setAuthKey } from "../server/auth-key.js";
import type { ServerConfig } from "../shared/types.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("config");
const KEY_FILE = join(RUNTIME_DIR, "adam.key");
const DEV_ENV_LOCAL = ".env.local";

export function ensureApiKey(
  config: ServerConfig,
  opts: { devMode: boolean },
): string {
  const existing = config.server.apiKey;
  if (existing && existing.length > 0) {
    setAuthKey(existing);
    writeFileSync(KEY_FILE, existing, { mode: 0o600 });
    return existing;
  }

  const newKey = randomBytes(32).toString("hex");

  setConfigValue("server.apiKey", newKey);
  writeFileSync(KEY_FILE, newKey, { mode: 0o600 });
  setAuthKey(newKey);

  console.log("[adam] Generated new API key → ~/.adam/adam.key");
  console.log("[adam] Retrieve it with: cat ~/.adam/adam.key");
  console.log("[adam] Web UI login: paste this value into the login page");

  if (opts.devMode && !process.env.ADAM_API_KEY) {
    appendDevEnv(newKey);
  }

  return newKey;
}

function appendDevEnv(key: string): void {
  try {
    let existing = "";
    if (existsSync(DEV_ENV_LOCAL)) {
      existing = readFileSync(DEV_ENV_LOCAL, "utf-8");
      if (/^ADAM_API_KEY=/m.test(existing)) {
        return;
      }
    }
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(DEV_ENV_LOCAL, `${prefix}ADAM_API_KEY=${key}\n`, { mode: 0o600 });
    log.info({ file: DEV_ENV_LOCAL }, "dev mode: appended ADAM_API_KEY to .env.local");
  } catch (err) {
    log.warn({ err }, "failed to append ADAM_API_KEY to .env.local (non-fatal)");
  }
}
