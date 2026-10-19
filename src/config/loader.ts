import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { CONFIG_PATH } from "../shared/constants.js";
import type { ServerConfig } from "../shared/types.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { MUTABLE_PATHS, RESTART_REQUIRED_PATHS, getNestedValue } from "./runtime.js";
import { coerceEnvValueForConfigPath, ENV_TO_CONFIG, isManagedEnvKey, readAllEnvVars } from "./env-sync.js";
import { getLogger } from "../lib/logger.js";
const log = getLogger("config");

function expandEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)}/g, (_, name) => process.env[name] ?? "");
}

function resolveTildePath(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

function deepExpandEnv(obj: unknown): unknown {
  if (typeof obj === "string") {
    return expandEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(deepExpandEnv);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = deepExpandEnv(value);
    }
    return result;
  }
  return obj;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}

function resolvePathsInConfig(config: ServerConfig): ServerConfig {
  // Resolve tilde in user-configurable deniedReadPaths (renamed from sensitivePaths)
  if (config.defaults.deniedReadPaths) {
    config.defaults.deniedReadPaths =
      config.defaults.deniedReadPaths.map(resolveTildePath);
  }
  // Backward compat: migrate sensitivePaths to deniedReadPaths
  if (config.defaults.sensitivePaths && !config.defaults.deniedReadPaths) {
    log.warn(
      "config.defaults.sensitivePaths is deprecated — use config.defaults.deniedReadPaths instead. " +
      "Values have been migrated automatically.",
    );
    config.defaults.deniedReadPaths = config.defaults.sensitivePaths.map(resolveTildePath);
  }
  return config;
}

function parseCliFlags(): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([a-z-]+)=(.+)$/);
    if (match) {
      flags[match[1]] = match[2];
    }
  }
  return flags;
}

function applyEnvOverrides(config: ServerConfig): ServerConfig {
  const port = process.env["ADAM_PORT"];
  if (port) {
    config.server.port = parseInt(port, 10);
  }

  const model = process.env["ANTHROPIC_MODEL"];
  if (model) {
    config.defaults.model = model;
  }

  const apiKey = process.env["ADAM_API_KEY"];
  if (apiKey) {
    config.server.apiKey = apiKey;
  }

  return config;
}

function applyCliOverrides(config: ServerConfig): ServerConfig {
  const flags = parseCliFlags();

  if (flags["port"]) {
    config.server.port = parseInt(flags["port"], 10);
  }
  if (flags["host"]) {
    config.server.host = flags["host"];
  }
  if (flags["timeout"]) {
    config.defaults.timeout = parseInt(flags["timeout"], 10);
  }
  if (flags["api-key"]) {
    config.server.apiKey = flags["api-key"];
  }

  return config;
}

/**
 * Load config from DEFAULT_CONFIG + YAML file + env/CLI overrides.
 * DEPRECATED for production startup — use loadDefaultConfig() instead.
 * Retained for backward compatibility in tests that pass a custom config path.
 */
export function loadConfig(configPath?: string): ServerConfig {
  const filePath = configPath ?? CONFIG_PATH;

  let fileConfig: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    if (parsed) {
      fileConfig = deepExpandEnv(parsed) as Record<string, unknown>;
    }
  }

  const merged = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    fileConfig,
  ) as unknown as ServerConfig;

  const withEnv = applyEnvOverrides(merged);
  const withCli = applyCliOverrides(withEnv);
  const withPaths = resolvePathsInConfig(withCli);

  return withPaths;
}

/**
 * Load config from DEFAULT_CONFIG + env/CLI overrides only (no YAML).
 * DB-persisted config is loaded separately via loadPersistedConfig() after DB init.
 */
export function loadDefaultConfig(): ServerConfig {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig;
  const withEnv = applyEnvOverrides(config);
  const withCli = applyCliOverrides(withEnv);
  const withPaths = resolvePathsInConfig(withCli);
  return withPaths;
}

/**
 * Collect seed values from process.env for first-boot DB seeding.
 * Returns a flat map of config dot-paths to values (only non-empty values).
 */
export function collectSeedValues(): Record<string, unknown> {
  const seeds: Record<string, unknown> = {};

  // Collect from process.env
  const envMapping: Record<string, string> = {
    ...ENV_TO_CONFIG,
    "ANTHROPIC_API_KEY": "anthropic.apiKey",
    "ANTHROPIC_BASE_URL": "anthropic.baseUrl",
    "ANTHROPIC_MODEL": "anthropic.model",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "anthropic.defaultOpusModel",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "anthropic.defaultSonnetModel",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "anthropic.defaultHaikuModel",
    "ANTHROPIC_SMALL_FAST_MODEL": "anthropic.smallFastModel",
    "ADAM_PORT": "server.port",
    "ADAM_API_KEY": "server.apiKey",
  };

  const customEnv: Record<string, string> = {};

  for (const [envKey, configPath] of Object.entries(envMapping)) {
    const value = process.env[envKey];
    if (value && value.length > 0) {
      seeds[configPath] = coerceEnvValueForConfigPath(configPath, value);
    }
  }

  // Collect custom env vars from .env file only (not from process.env spray).
  // readAllEnvVars reads ~/.adam/.env and returns all key-value pairs.
  // We seed non-managed keys into defaults.env.
  const allFileEnv = readAllEnvVars();
  if (allFileEnv) {
    for (const [key, value] of Object.entries(allFileEnv)) {
      if (isManagedEnvKey(key) || key in envMapping) continue; // already handled as managed key
      if (key.startsWith("ANTHROPIC_")) continue; // ANTHROPIC_* handled separately
      if (key.startsWith("ADAM_")) continue; // ADAM_* keys are internal
      customEnv[key] = value;
    }
  }

  if (Object.keys(customEnv).length > 0) {
    seeds["defaults.env"] = customEnv;
  }

  return seeds;
}
