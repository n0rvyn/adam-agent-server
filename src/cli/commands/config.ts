import chalk from "chalk";
import { getDb, closeDb } from "../../store/db.js";
import { getAllConfig, isConfigEmpty } from "../../store/config.js";
import { readEnvFile } from "../../config/env-sync.js";

export async function configHandler(options: { json?: boolean }): Promise<void> {
  try {
    // Ensure DB is open (runs migrations automatically)
    const db = getDb();
    void db;

    if (options.json) {
      const config = getAllConfig();
      console.log(JSON.stringify(config, null, 2));
    } else {
      const config = getAllConfig();
      const envValues = readEnvFile();
      const empty = isConfigEmpty();

      console.log(chalk.bold("Adam Configuration\n"));

      if (empty) {
        console.log(chalk.yellow("No configuration saved. Use Settings UI or create ~/.adam/.env\n"));
      }

      // Group by category
      const categories: Record<string, Array<[string, unknown]>> = {
        "Anthropic": [
          ["anthropic.apiKey", config["anthropic.apiKey"]],
          ["anthropic.baseUrl", config["anthropic.baseUrl"]],
          ["anthropic.model", config["anthropic.model"]],
          ["anthropic.defaultOpusModel", config["anthropic.defaultOpusModel"]],
          ["anthropic.defaultSonnetModel", config["anthropic.defaultSonnetModel"]],
          ["anthropic.defaultHaikuModel", config["anthropic.defaultHaikuModel"]],
          ["anthropic.smallFastModel", config["anthropic.smallFastModel"]],
        ],
        "Defaults": [
          ["defaults.model", config["defaults.model"]],
          ["defaults.effort", config["defaults.effort"]],
          ["defaults.maxTurns", config["defaults.maxTurns"]],
          ["defaults.maxBudgetUsd", config["defaults.maxBudgetUsd"]],
          ["defaults.timeout", config["defaults.timeout"]],
        ],
        "Server": [
          ["server.port", config["server.port"]],
          ["server.host", config["server.host"]],
          ["server.apiKey", config["server.apiKey"]],
          ["server.timezone", config["server.timezone"]],
        ],
        "Logging": [
          ["logging.level", config["logging.level"]],
        ],
        "Evolution": [
          ["roles.evolution.triggerEvery", config["roles.evolution.triggerEvery"]],
          ["roles.evolution.reflectionThreshold", config["roles.evolution.reflectionThreshold"]],
        ],
        "Chat": [
          ["chat.sessionTimeoutMinutes", config["chat.sessionTimeoutMinutes"]],
          ["chat.maxSessionTurns", config["chat.maxSessionTurns"]],
          ["chat.autoTitle", config["chat.autoTitle"]],
          ["chat.archiveExtractMemory", config["chat.archiveExtractMemory"]],
        ],
      };

      const LABELS: Record<string, string> = {
        "anthropic.apiKey": "API Key",
        "anthropic.baseUrl": "Base URL",
        "anthropic.model": "Model",
        "anthropic.defaultOpusModel": "Default Opus",
        "anthropic.defaultSonnetModel": "Default Sonnet",
        "anthropic.defaultHaikuModel": "Default Haiku",
        "anthropic.smallFastModel": "Small Fast",
        "defaults.model": "Default Model",
        "defaults.effort": "Effort",
        "defaults.maxTurns": "Max Turns",
        "defaults.maxBudgetUsd": "Max Budget (USD)",
        "defaults.timeout": "Timeout (sec)",
        "server.port": "Port",
        "server.host": "Host",
        "server.apiKey": "API Key",
        "server.timezone": "Timezone",
        "logging.level": "Log Level",
        "roles.evolution.triggerEvery": "Evolution Trigger Every",
        "chat.sessionTimeoutMinutes": "Session Timeout (min)",
        "chat.maxSessionTurns": "Max Session Turns",
        "chat.autoTitle": "Auto Title",
        "chat.archiveExtractMemory": "Archive Extract Memory",
        "roles.evolution.reflectionThreshold": "Reflection Threshold",
      };

      for (const [category, entries] of Object.entries(categories)) {
        const nonEmpty = entries.filter(([, v]) => v !== undefined && v !== null && v !== "");
        if (nonEmpty.length === 0) continue;
        console.log(chalk.cyan(`${category}:`));
        for (const [path, value] of nonEmpty) {
          const label = LABELS[path] ?? path;
          const isSecret = path.includes("apiKey") || path.includes("token") || path.includes("secret");
          const display = isSecret ? maskValue(String(value)) : String(value);
          console.log(`  ${label}: ${display}`);
        }
        console.log("");
      }

      // Show .env section
      if (envValues) {
        console.log(chalk.bold(".env File Values:\n"));
        const ANTHROPIC_KEYS = [
          "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
          "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
          "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
        ];
        for (const key of ANTHROPIC_KEYS) {
          if (key in envValues) {
            const isSecret = key.includes("API_KEY");
            console.log(`  ${key}: ${isSecret ? maskValue(envValues[key]) : envValues[key]}`);
          }
        }
        console.log("");
      }
    }
  } finally {
    closeDb();
  }
}

function maskValue(value: string): string {
  if (!value || value.length < 8) return "****";
  return value.slice(0, 4) + "****";
}
