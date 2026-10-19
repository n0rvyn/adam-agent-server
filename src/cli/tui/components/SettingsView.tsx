import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import React, { useState, useEffect, useCallback } from "react";
import { request } from "../../client.js";
import { useTuiState } from "../hooks/useTuiState.js";

interface ConfigEntry {
  value: unknown;
  mutable: boolean;
}

interface ConfigResponse {
  config: Record<string, ConfigEntry>;
  mutable: string[];
  restartRequired: string[];
}

interface SettingsViewProps {
  onBack: () => void;
}

type Mode = "view" | "edit" | "env-list" | "env-add-key" | "env-add-value" | "env-edit-value";

// Group paths by category for display
const CATEGORIES: Record<string, string[]> = {
  "Anthropic": [
    "anthropic.apiKey",
    "anthropic.baseUrl",
    "anthropic.model",
    "anthropic.defaultOpusModel",
    "anthropic.defaultSonnetModel",
    "anthropic.defaultHaikuModel",
    "anthropic.smallFastModel",
  ],
  "Defaults": [
    "defaults.model",
    "defaults.effort",
    "defaults.maxTurns",
    "defaults.maxBudgetUsd",
    "defaults.timeout",
    "defaults.approvalTimeout",
  ],
  "Server": [
    "server.port",
    "server.host",
    "server.apiKey",
    "server.timezone",
  ],
  "Logging": [
    "logging.level",
  ],
  "Evolution": [
    "roles.evolution.triggerEvery",
    "roles.evolution.reflectionThreshold",
  ],
  "Chat": [
    "chat.sessionTimeoutMinutes",
    "chat.maxSessionTurns",
    "chat.autoTitle",
    "chat.archiveExtractMemory",
  ],
  "Execution Artifacts": [
    "watchdog.rules.artifactCleanup.enabled",
    "watchdog.rules.artifactCleanup.ttlDays",
    "watchdog.rules.artifactCleanup.orphanGcMinAgeHours",
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
  "defaults.approvalTimeout": "Approval Timeout (sec)",
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
  "watchdog.rules.artifactCleanup.enabled": "Artifact Cleanup Enabled",
  "watchdog.rules.artifactCleanup.ttlDays": "Artifact Retention (days)",
  "watchdog.rules.artifactCleanup.orphanGcMinAgeHours": "Orphan GC Min Age (hours)",
};

export function SettingsView({ onBack }: SettingsViewProps) {
  const { state } = useTuiState();
  const [config, setConfig] = useState<Record<string, ConfigEntry>>({});
  const [mutablePaths, setMutablePaths] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editValue, setEditValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [envDiffs, setEnvDiffs] = useState<Array<{ configPath: string; envKey: string; dbValue: string; envValue: string }>>([]);
  // Env vars editor state
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [envIndex, setEnvIndex] = useState(0);
  const [envNewKey, setEnvNewKey] = useState("");
  const [envNewValue, setEnvNewValue] = useState("");
  const [envEditValue, setEnvEditValue] = useState("");

  // Flat list of all paths for navigation
  const allPaths = Object.values(CATEGORIES).flat();

  const loadConfig = useCallback(() => {
    request<ConfigResponse>("/config")
      .then((data) => {
        setConfig(data.config);
        setMutablePaths(data.mutable);
      })
      .catch((err) => setError(err.message));
    request<{ diffs: Array<{ configPath: string; envKey: string; dbValue: string; envValue: string }>; envFileExists: boolean }>("/config/env-diff")
      .then((diffData) => {
        setEnvDiffs(diffData.diffs);
      })
      .catch(() => {});
    request<{ env: Record<string, string> }>("/config/env")
      .then((data) => setEnvVars(data.env ?? {}))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Re-fetch when config_changed is received via WebSocket
  useEffect(() => {
    if (state.configVersion > 0) {
      loadConfig();
    }
  }, [state.configVersion, loadConfig]);

  const handleSave = useCallback(async () => {
    const path = allPaths[selectedIndex];
    if (!path) return;
    setSaving(true);
    setMessage(null);
    try {
      // Convert value to appropriate type
      let value: unknown = editValue;
      const currentEntry = config[path];
      if (currentEntry) {
        if (typeof currentEntry.value === "number") {
          value = Number(editValue);
          if (isNaN(value as number)) {
            setMessage("Invalid number");
            setSaving(false);
            return;
          }
        }
      }

      const result = await request<{ success: boolean; updated: string[]; errors: string[]; message: string }>("/config", {
        method: "PATCH",
        body: { [path]: value },
      });

      if (result.updated.length > 0) {
        setMessage(`Updated: ${path}`);
        loadConfig();
      }
      if (result.errors.length > 0) {
        setMessage(result.errors[0]);
      }
      setMode("view");
    } catch (err) {
      setMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [allPaths, selectedIndex, editValue, config, loadConfig]);

  const envKeys = Object.keys(envVars);

  const saveEnvVars = useCallback(async (updated: Record<string, string>) => {
    try {
      await request("/config/env", { method: "PUT", body: updated });
      setMessage("Env vars saved");
      loadConfig();
    } catch (err) {
      setMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [loadConfig]);

  useInput((input, key) => {
    if (mode === "edit") {
      if (key.escape) { setMode("view"); return; }
      return;
    }

    // Env list mode
    if (mode === "env-list") {
      if (key.escape) { setMode("view"); return; }
      if (key.upArrow && envIndex > 0) setEnvIndex(i => i - 1);
      if (key.downArrow && envIndex < envKeys.length - 1) setEnvIndex(i => i + 1);
      if (input === "a") { setEnvNewKey(""); setMode("env-add-key"); return; }
      if (input === "d" && envKeys.length > 0) {
        const k = envKeys[envIndex];
        const updated = { ...envVars };
        delete updated[k];
        void saveEnvVars(updated);
        if (envIndex >= envKeys.length - 1 && envIndex > 0) setEnvIndex(i => i - 1);
        return;
      }
      if (key.return && envKeys.length > 0) {
        setEnvEditValue(envVars[envKeys[envIndex]] ?? "");
        setMode("env-edit-value");
        return;
      }
      return;
    }
    if (mode === "env-add-key") {
      if (key.escape) { setMode("env-list"); return; }
      return;
    }
    if (mode === "env-add-value") {
      if (key.escape) { setMode("env-list"); return; }
      return;
    }
    if (mode === "env-edit-value") {
      if (key.escape) { setMode("env-list"); return; }
      return;
    }

    // View mode
    if (key.escape || input === "q") { onBack(); return; }
    if (key.upArrow && selectedIndex > 0) setSelectedIndex((i) => i - 1);
    if (key.downArrow && selectedIndex < allPaths.length - 1) setSelectedIndex((i) => i + 1);
    if (key.return || input === "e") {
      const path = allPaths[selectedIndex];
      const entry = config[path];
      if (entry && entry.mutable) {
        setEditValue(String(entry.value ?? ""));
        setMode("edit");
        setMessage(null);
      } else if (entry && !entry.mutable) {
        setMessage("This setting requires a restart to change");
      }
    }
    if (input === "v") {
      setEnvIndex(0);
      setMode("env-list");
      setMessage(null);
    }
    if (input === "r") { loadConfig(); setMessage("Refreshed"); }
    if (input === "s" && envDiffs.length > 0) {
      request("/config/sync-to-env", { method: "POST" }).then(() => { setMessage("Synced to .env"); setEnvDiffs([]); loadConfig(); });
    }
    if (input === "l" && envDiffs.length > 0) {
      request("/config/load-from-env", { method: "POST" }).then(() => { setMessage("Loaded from .env"); loadConfig(); });
    }
  });

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Failed to load config: {error}</Text>
        <Text dimColor>Press Esc or q to return</Text>
      </Box>
    );
  }

  let pathIndex = 0;

  return (
    <Box flexDirection="column">
      <Text bold>Settings</Text>
      {message && (
        <Text color={message.startsWith("Failed") || message.startsWith("This setting") ? "yellow" : "green"}>
          {message}
        </Text>
      )}
      {envDiffs && envDiffs.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="yellow">.env differs from DB ({envDiffs.length} key(s)): {envDiffs.map(d => d.envKey).join(", ")}</Text>
          <Text dimColor>s:sync DB→.env  l:load .env→DB</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        {Object.entries(CATEGORIES).map(([category, paths]) => (
          <Box key={category} marginBottom={1} flexDirection="column">
            <Text bold color="cyan">{category}</Text>
            {paths.map((path) => {
              const entry = config[path];
              const idx = pathIndex++;
              const selected = idx === selectedIndex;
              const isMutable = mutablePaths.includes(path);
              const label = LABELS[path] ?? path;
              const value = entry ? String(entry.value ?? "") : "...";

              if (mode === "edit" && selected) {
                return (
                  <Box key={path}>
                    <Text color="cyan">&gt; {label}: </Text>
                    <TextInput
                      value={editValue}
                      onChange={setEditValue}
                      onSubmit={() => void handleSave()}
                    />
                    {saving && <Text color="yellow"> saving...</Text>}
                  </Box>
                );
              }

              return (
                <Box key={path}>
                  <Text color={selected ? "cyan" : "white"}>
                    {selected ? "> " : "  "}
                    {!isMutable ? "\u{1F512} " : "  "}
                    {label}: {" "}
                  </Text>
                  <Text color={isMutable ? "white" : "gray"}>{value}</Text>
                  {!isMutable && <Text dimColor> (restart required)</Text>}
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>
      <Text dimColor>Enter/e:edit  v:env vars  r:refresh  Esc/q:back</Text>

      {/* Env vars editor overlay */}
      {mode.startsWith("env") && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">Environment Variables ({envKeys.length})</Text>
          {envKeys.length === 0 && mode === "env-list" && <Text dimColor>  No env vars. Press a to add.</Text>}
          {envKeys.map((k, i) => {
            const selected = i === envIndex;
            if (mode === "env-edit-value" && selected) {
              return (
                <Box key={k}>
                  <Text color="cyan">&gt; {k} = </Text>
                  <TextInput value={envEditValue} onChange={setEnvEditValue} onSubmit={() => {
                    void saveEnvVars({ ...envVars, [k]: envEditValue });
                    setMode("env-list");
                  }} />
                </Box>
              );
            }
            return (
              <Text key={k} color={selected && mode === "env-list" ? "cyan" : "white"}>
                {selected && mode === "env-list" ? "> " : "  "}{k} = {envVars[k]}
              </Text>
            );
          })}
          {mode === "env-add-key" && (
            <Box>
              <Text color="green">  New key: </Text>
              <TextInput value={envNewKey} onChange={setEnvNewKey} onSubmit={() => {
                if (envNewKey.trim()) { setEnvNewValue(""); setMode("env-add-value"); }
              }} />
            </Box>
          )}
          {mode === "env-add-value" && (
            <Box>
              <Text color="green">  {envNewKey} = </Text>
              <TextInput value={envNewValue} onChange={setEnvNewValue} onSubmit={() => {
                void saveEnvVars({ ...envVars, [envNewKey.trim()]: envNewValue });
                setMode("env-list");
              }} />
            </Box>
          )}
          <Text dimColor>a:add  Enter:edit  d:delete  Esc:back</Text>
        </Box>
      )}
    </Box>
  );
}
