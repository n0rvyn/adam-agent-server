import { Box, Text, useInput } from "ink";
import React, { useEffect, useState, useCallback } from "react";
import { request } from "../../client.js";
import { useFlashMessage } from "../hooks/useFlashMessage.js";

interface InstalledPluginEntry {
  id: string;
  version: string;
  scope: "user" | "project" | "local";
  projectPath?: string;
  installPath: string;
  enabled: boolean;
  installedAt: string;
  lastUpdated: string;
  globalEnabled: boolean;
}

interface PluginListProps {
  onBack: () => void;
}

export function PluginList({ onBack }: PluginListProps) {
  const [plugins, setPlugins] = useState<InstalledPluginEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { message, setMessage, clearMessage } = useFlashMessage();

  const fetchPlugins = useCallback(() => {
    setLoading(true);
    request<{ plugins: InstalledPluginEntry[] }>("/plugins")
      .then(({ plugins }) => {
        setPlugins(plugins);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchPlugins();
  }, [fetchPlugins]);

  useInput((input, key) => {
    if (key.escape || input === "q") { onBack(); return; }
    if (key.upArrow) { setSelectedIndex((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setSelectedIndex((i) => Math.min(plugins.length - 1, i + 1)); return; }
    if (input === "r") { fetchPlugins(); clearMessage(); }
  });

  if (loading) return <Text dimColor>Loading plugins...</Text>;

  return (
    <Box flexDirection="column">
      <Text bold>Plugins ({plugins.length}) (Esc to go back)</Text>
      {message && (
        <Box marginTop={1}>
          <Text
            color={message.type === "success" ? "green" : message.type === "error" ? "red" : "gray"}
          >
            {message.type === "success" ? "✓ " : message.type === "error" ? "✗ " : "→ "}
            {message.text}
          </Text>
        </Box>
      )}
      {plugins.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No plugins installed.</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text dimColor>{"  "}</Text>
            <Text dimColor>{pad("Name", 24)}</Text>
            <Text dimColor>{pad("Scope", 8)}</Text>
            <Text dimColor>{pad("User", 6)}</Text>
            <Text dimColor>Path</Text>
          </Box>
          {plugins.map((p, i) => {
            const selected = i === selectedIndex;
            const name = p.id.split("@")[0];
            return (
              <Box key={p.id}>
                <Text color={selected ? "cyan" : undefined} bold={selected}>
                  {selected ? "> " : "  "}
                </Text>
                <Text color={selected ? "cyan" : undefined} bold={selected}>
                  {pad(name, 24)}
                </Text>
                <Text color={selected ? "cyan" : undefined} bold={selected}>
                  {pad(p.scope, 8)}
                </Text>
                <Text color={p.globalEnabled ? "green" : "gray"}>
                  {pad(p.globalEnabled ? "on" : "off", 6)}
                </Text>
                <Text dimColor>{p.installPath}</Text>
              </Box>
            );
          })}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>r:refresh</Text>
      </Box>
    </Box>
  );
}

function pad(s: string, len: number): string {
  if (!s) return " ".repeat(len);
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}
