import type { ServerConfig } from "../shared/types.js";
import { validatePriceTable } from "../lib/cost-pricing.js";

// Runtime-mutable config paths (dot-notation for nested objects)
export const MUTABLE_PATHS = [
  "defaults.model",
  "defaults.effort",
  "defaults.maxTurns",
  "defaults.maxBudgetUsd",
  "defaults.timeout",
  "logging.level",
  "roles.evolution.triggerEvery",
  "roles.evolution.reflectionThreshold",
  "identity.ownerViewerKey",
  "chat.sessionTimeoutMinutes",
  "chat.maxSessionTurns",
  "chat.autoTitle",
  "chat.archiveExtractMemory",
  "chat.artifactThresholdChars",
  "chat.maxConcurrentLiveSessions",
  "chat.liveSessionIdleMinutes",
  "chat.commitmentDetection.locales",
  "chat.commitmentDetection.blockedText.zh",
  "chat.commitmentDetection.blockedText.en",
  "chat.commitmentDetection.unsupportedSuccessText.zh",
  "chat.commitmentDetection.unsupportedSuccessText.en",
  "chat.commitmentDetection.unsupportedFailureText.zh",
  "chat.commitmentDetection.unsupportedFailureText.en",
  "chat.commitmentDetection.unsupportedMutationText.zh",
  "chat.commitmentDetection.unsupportedMutationText.en",
  "memory.midTaskInjection.enabled",
  "memory.midTaskInjection.toolCallThreshold",
  "memory.midTaskInjection.cooldownMs",
  "memory.midTaskInjection.topK",
  "memory.midTaskInjection.maxTokens",
  "memory.retrievalWeights.cosSim",
  "memory.retrievalWeights.recency",
  "memory.retrievalWeights.tokenCost",
  "memory.globalBudgetTokens",
  "memory.retrievalDecayDays",
  "memory.attributionThresholds.high",
  "memory.attributionThresholds.low",
  "memory.antiFlipMinUses",
  "memory.antiFlipSuccessEmaThreshold",
  "memory.reflection.maxBudgetUsd",
  "memory.scope.emaAlpha",
  "memory.scope.humanFeedbackWeight",
  "memory.scope.reflectionPoolMax",
  "memory.scope.decayBase",
  "memory.scope.archiveThreshold",
  "memory.embeddingModel",
  "server.timezone",
  "anthropic.apiKey",
  "anthropic.baseUrl",
  "anthropic.model",
  "anthropic.defaultOpusModel",
  "anthropic.defaultSonnetModel",
  "anthropic.defaultHaikuModel",
  "anthropic.smallFastModel",
  "audit.intentEval.maxBudgetUsd",
  "audit.intentEval.timeoutMs",
  "evaluation.model",
  "defaults.approvalTimeout",
  "defaults.deniedReadPaths",
  "defaults.approvalRequired",
  "watchdog.rules.artifactCleanup.enabled",
  "watchdog.rules.artifactCleanup.ttlDays",
  "watchdog.rules.artifactCleanup.orphanGcMinAgeHours",
  "watchdog.rules.staleTemplateExecutions.enabled",
  "watchdog.rules.staleTemplateExecutions.action",
  "watchdog.rules.staleTemplateExecutions.maxOrphanMinutes",
  "emailGateway.enabled",
  "emailGateway.address",
  "emailGateway.displayName",
  "emailGateway.imap.host",
  "emailGateway.imap.port",
  "emailGateway.imap.secure",
  "emailGateway.imap.auth.user",
  "emailGateway.imap.auth.pass",
  "emailGateway.imap.mailbox",
  "emailGateway.smtp.host",
  "emailGateway.smtp.port",
  "emailGateway.smtp.secure",
  "emailGateway.smtp.auth.user",
  "emailGateway.smtp.auth.pass",
  "emailGateway.smtp.from",
  "emailGateway.subjectPrefix",
  "storage.localProfile",
  "pricing.models",
  "cost.dailyThresholdUsd",
] as const;

export const RESTART_REQUIRED_PATHS = [
  "server.port",
  "server.host",
  "server.apiKey",
] as const;

/** Env var mapping for SDK auth: config dot-path → env var name */
const ANTHROPIC_ENV_MAP: Record<string, string> = {
  "anthropic.apiKey": "ANTHROPIC_API_KEY",
  "anthropic.baseUrl": "ANTHROPIC_BASE_URL",
  "anthropic.model": "ANTHROPIC_MODEL",
  "anthropic.defaultOpusModel": "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "anthropic.defaultSonnetModel": "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "anthropic.defaultHaikuModel": "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "anthropic.smallFastModel": "ANTHROPIC_SMALL_FAST_MODEL",
};

type MutablePath = (typeof MUTABLE_PATHS)[number];
type ConfigValueValidator = (value: unknown) => string | null;

let runtimeConfig: ServerConfig | null = null;

const EMAIL_GATEWAY_ENV_PREFIXES = ["ADAM_EMAIL_"];

const CONFIG_VALUE_VALIDATORS: Record<string, ConfigValueValidator> = {
  "audit.intentEval.maxBudgetUsd": (value) =>
    isPositiveFiniteNumber(value) ? null : "must be a positive number.",
  "audit.intentEval.timeoutMs": (value) =>
    isPositiveInteger(value) ? null : "must be a positive integer in milliseconds.",
  "memory.reflection.maxBudgetUsd": (value) =>
    isPositiveFiniteNumber(value) ? null : "must be a positive number (USD).",
  "memory.scope.emaAlpha": (value) =>
    typeof value === "number" && value >= 0 && value <= 1
      ? null
      : "must be a number between 0 and 1.",
  "memory.scope.humanFeedbackWeight": (value) =>
    typeof value === "number" && value >= 1
      ? null
      : "must be a number >= 1.",
  "memory.scope.decayBase": (value) =>
    typeof value === "number" && value > 0 && value < 1
      ? null
      : "must be a number between 0 and 1 (exclusive).",
  "memory.scope.archiveThreshold": (value) =>
    typeof value === "number" && value >= 0 && value <= 1
      ? null
      : "must be a number between 0 and 1.",
  "memory.scope.reflectionPoolMax": (value) =>
    isPositiveInteger(value) ? null : "must be a positive integer.",
  "memory.antiFlipSuccessEmaThreshold": (value) =>
    typeof value === "number" && value >= 0 && value <= 1
      ? null
      : "must be a number between 0 and 1.",
  "chat.artifactThresholdChars": (value) =>
    isPositiveInteger(value) ? null : "must be a positive integer (chars).",
  "chat.maxConcurrentLiveSessions": (value) =>
    isPositiveInteger(value) ? null : "must be a positive integer (>= 1).",
  "chat.liveSessionIdleMinutes": (value) =>
    isPositiveInteger(value) ? null : "must be a positive integer (minutes).",
  "storage.localProfile": (value) =>
    typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value)
      ? null
      : "must match /^[a-zA-Z0-9_-]+$/ (no path separators, no special chars).",
  "pricing.models": (value) => validatePriceTable(value),
  "chat.commitmentDetection.locales": (value) =>
    Array.isArray(value)
      && value.length > 0
      && (value as unknown[]).every((v) => v === "zh" || v === "en")
      ? null
      : "must be a non-empty array of 'zh' | 'en'.",
  "chat.commitmentDetection.blockedText.zh": (value) =>
    typeof value === "string" && value.length > 0 ? null : "must be a non-empty string.",
  "chat.commitmentDetection.blockedText.en": (value) =>
    typeof value === "string" && value.length > 0 ? null : "must be a non-empty string.",
  "chat.commitmentDetection.unsupportedSuccessText.zh": (value) =>
    typeof value === "string" && value.length > 0 ? null : "must be a non-empty string.",
  "chat.commitmentDetection.unsupportedSuccessText.en": (value) =>
    typeof value === "string" && value.length > 0 ? null : "must be a non-empty string.",
  "chat.commitmentDetection.unsupportedFailureText.zh": (value) =>
    typeof value === "string" && value.length > 0 ? null : "must be a non-empty string.",
  "chat.commitmentDetection.unsupportedFailureText.en": (value) =>
    typeof value === "string" && value.length > 0 ? null : "must be a non-empty string.",
  "chat.commitmentDetection.unsupportedMutationText.zh": (value) =>
    typeof value === "string" && value.length > 0 ? null : "must be a non-empty string.",
  "chat.commitmentDetection.unsupportedMutationText.en": (value) =>
    typeof value === "string" && value.length > 0 ? null : "must be a non-empty string.",
  "emailGateway.address": (value) =>
    isSingleEmailAddress(value, { allowEmpty: false }) ? null : "must be a single valid email address.",
  "emailGateway.imap.host": (value) =>
    isHostWithoutProtocol(value) ? null : "must be a non-empty host without protocol.",
  "emailGateway.imap.port": (value) =>
    isPositiveInteger(value) ? null : "must be a positive integer port.",
  "emailGateway.imap.mailbox": (value) =>
    isValidMailbox(value) ? null : "must be a non-empty mailbox without NUL bytes.",
  "emailGateway.smtp.host": (value) =>
    isHostWithoutProtocol(value) ? null : "must be a non-empty host without protocol.",
  "emailGateway.smtp.port": (value) =>
    isPositiveInteger(value) ? null : "must be a positive integer port.",
  "emailGateway.smtp.from": (value) =>
    isSingleEmailAddress(value, { allowEmpty: true }) ? null : "must be empty or a single valid email address.",
  "identity.ownerViewerKey": (value) =>
    typeof value === "string" && value.trim().length > 0 ? null : "must be a non-empty string.",
  "cost.dailyThresholdUsd": (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? null
      : "must be a finite number >= 0 (USD; 0 = disabled).",
};

export function initRuntimeConfig(config: ServerConfig): void {
  runtimeConfig = JSON.parse(JSON.stringify(config)); // deep clone
}

export function getRuntimeConfig(): ServerConfig {
  if (!runtimeConfig) {
    throw new Error(
      "Runtime config not initialized. Call initRuntimeConfig first.",
    );
  }
  return runtimeConfig;
}

/**
 * Load persisted config from DB and apply to runtimeConfig.
 * DB values override in-memory defaults for all known paths.
 * Takes getAllConfig as parameter to avoid static import of store/db.ts
 * (which causes Vitest teardown errors in tests that import config/runtime).
 */
export function loadPersistedConfig(getAllConfig: () => Record<string, unknown>): void {
  const config = getRuntimeConfig();
  const dbConfig = getAllConfig();

  for (const [key, value] of Object.entries(dbConfig)) {
    if (validateConfigValue(key, value)) {
      continue;
    }
    setNestedValue(config as unknown as Record<string, unknown>, key, value);
  }
}

/**
 * Build env overrides for SDK query() calls.
 * Injects DB anthropic.* values into env, falling back to existing process.env values.
 * Returns a partial env record to spread into sdkEnv.
 */
export function buildSdkAuthEnv(): Record<string, string> {
  const config = getRuntimeConfig();
  const env: Record<string, string> = {};
  for (const [configPath, envKey] of Object.entries(ANTHROPIC_ENV_MAP)) {
    const dbValue = getNestedValue(config, configPath);
    if (dbValue && typeof dbValue === "string" && dbValue.length > 0) {
      env[envKey] = dbValue;
    } else if (process.env[envKey]) {
      env[envKey] = process.env[envKey]!;
    }
  }
  return env;
}

/**
 * Filter out ANTHROPIC_* keys from an env record.
 * Used to prevent Role/Task env from overriding global Anthropic auth.
 */
export function filterAnthropicKeys(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith("ANTHROPIC_")) result[k] = v;
  }
  return result;
}

/**
 * Mask sensitive env var values for API responses.
 * Keys matching common secret patterns show first 4 chars + "****".
 */
const SENSITIVE_KEY_PATTERN = /key|token|secret|password|credential/i;

export function maskSensitiveEnvValues(env: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    masked[k] = SENSITIVE_KEY_PATTERN.test(k) && v.length > 4
      ? v.slice(0, 4) + "****"
      : SENSITIVE_KEY_PATTERN.test(k) && v.length > 0
        ? "****"
        : v;
  }
  return masked;
}

/**
 * Build complete SDK env for query() calls.
 * Priority chain (later overrides earlier):
 *   process.env -> defaults.env (global custom) -> buildSdkAuthEnv() (ANTHROPIC_*) -> role.envVars -> task.config.env -> DISABLE_* flags
 *
 * ANTHROPIC_* keys are filtered from role/task env; they always come from global config only.
 */
export function buildSdkEnv(opts?: {
  roleEnvVars?: Record<string, string>;
  taskEnv?: Record<string, string>;
}): Record<string, string> {
  const config = getRuntimeConfig();
  const globalCustomEnv = config.defaults?.env ?? {};

  return removeEmailGatewayEnvKeys({
    ...(process.env as Record<string, string>),
    ...globalCustomEnv,
    ...buildSdkAuthEnv(),
    ...filterAnthropicKeys(opts?.roleEnvVars ?? {}),
    ...filterAnthropicKeys(opts?.taskEnv ?? {}),
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  });
}

export function updateMutableConfig(
  updates: Record<string, unknown>,
  persistFn?: (key: string, value: unknown) => void,
): { success: boolean; updated: string[]; errors: string[] } {
  const config = getRuntimeConfig();
  const updated: string[] = [];
  const errors: string[] = [];

  for (const [path, value] of Object.entries(updates)) {
    if (!isMutablePath(path)) {
      if (isRestartRequiredPath(path)) {
        errors.push(`"${path}" requires restart. Cannot modify at runtime.`);
      } else {
        errors.push(`"${path}" is not a recognized config path.`);
      }
      continue;
    }

    const validationError = validateConfigValue(path, value);
    if (validationError) {
      errors.push(`"${path}" ${validationError}`);
      continue;
    }

    const result = setNestedValue(
      config as unknown as Record<string, unknown>,
      path,
      value,
    );
    if (result) {
      updated.push(path);
      // Persist to DB if persist function provided
      persistFn?.(path, value);
    }
  }

  return { success: errors.length === 0, updated, errors };
}

function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): boolean {
  const keys = path.split(".");
  let current: unknown = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[keys[i]];
    } else {
      return false;
    }
  }

  if (current && typeof current === "object") {
    (current as Record<string, unknown>)[keys[keys.length - 1]] = value;
    return true;
  }
  return false;
}

export function getNestedValue(obj: unknown, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;

  for (const key of keys) {
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }

  return current;
}

export function isMutablePath(path: string): path is MutablePath {
  return (MUTABLE_PATHS as readonly string[]).includes(path);
}

export function isRestartRequiredPath(path: string): boolean {
  return (RESTART_REQUIRED_PATHS as readonly string[]).includes(path);
}

function validateConfigValue(path: string, value: unknown): string | null {
  return CONFIG_VALUE_VALIDATORS[path]?.(value) ?? null;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isHostWithoutProtocol(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim());
}

function isValidMailbox(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function isSingleEmailAddress(value: unknown, opts: { allowEmpty: boolean }): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return opts.allowEmpty;
  if (trimmed.includes(",") || /[<>]/.test(trimmed)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

function removeEmailGatewayEnvKeys(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (EMAIL_GATEWAY_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    result[key] = value;
  }
  return result;
}
