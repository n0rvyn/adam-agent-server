import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import React, { useEffect, useState, useCallback } from "react";
import { request } from "../../client.js";

interface WebhookInfo {
  name: string;
  displayName: string;
  description?: string;
  tags?: string[];
  trigger: string;
}

interface WebhookListProps {
  onBack: () => void;
}

export function WebhookList({ onBack }: WebhookListProps) {
  const [webhooks, setWebhooks] = useState<WebhookInfo[]>([]);
  const [auth, setAuth] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [inputMode, setInputMode] = useState(false);
  const [triggerName, setTriggerName] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const fetchWebhooks = useCallback(() => {
    setLoading(true);
    request<{ webhooks: WebhookInfo[]; auth: string }>("/webhooks")
      .then(({ webhooks, auth }) => {
        setWebhooks(webhooks);
        setAuth(auth);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchWebhooks();
  }, [fetchWebhooks]);

  const handleTrigger = useCallback(async (name: string) => {
    if (!name.trim()) return;
    try {
      const res = await request<{ executionId: string; message: string }>(
        `/webhooks/${encodeURIComponent(name.trim())}`,
        { method: "POST" },
      );
      setMessage(`Triggered: ${res.executionId}`);
    } catch (err) {
      setMessage(`Trigger failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  useInput((input, key) => {
    if (inputMode) {
      if (key.escape) {
        setInputMode(false);
        setTriggerName("");
        return;
      }
      if (key.return) {
        handleTrigger(triggerName);
        setInputMode(false);
        setTriggerName("");
        return;
      }
      return;
    }

    if (key.escape || input === "q") {
      onBack();
      return;
    }
    if (input === "t") {
      setInputMode(true);
      setTriggerName("");
      setMessage(null);
      return;
    }
    if (input === "r") {
      fetchWebhooks();
      setMessage(null);
    }
  });

  if (loading) {
    return <Text dimColor>Loading webhooks...</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text bold>Webhooks ({webhooks.length}) (Esc to go back)</Text>
      <Text dimColor>Auth: {auth}</Text>
      {message && (
        <Box marginTop={1}>
          <Text color="yellow">{message}</Text>
        </Box>
      )}
      {inputMode && (
        <Box marginTop={1}>
          <Text bold color="cyan">Trigger webhook: </Text>
          <TextInput
            value={triggerName}
            onChange={setTriggerName}
            placeholder="webhook name or ID"
          />
          <Text dimColor> (Enter to trigger, Esc to cancel)</Text>
        </Box>
      )}
      {webhooks.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No webhooks available. Create templates with triggers to expose webhooks.</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text bold>{pad("NAME", 24)}{pad("DESCRIPTION", 36)}{pad("TRIGGER", 28)}TAGS</Text>
          </Box>
          {webhooks.map((w) => (
            <Box key={w.name}>
              <Text>{pad(w.displayName, 24)}</Text>
              <Text dimColor>{pad(truncate(w.description ?? "", 34), 36)}</Text>
              <Text dimColor>{pad(w.trigger, 28)}</Text>
              <Text dimColor>{w.tags?.join(", ") ?? ""}</Text>
            </Box>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>t:trigger r:refresh</Text>
      </Box>
    </Box>
  );
}

function pad(s: string, len: number): string {
  if (!s) return " ".repeat(len);
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function truncate(s: string, len: number): string {
  return s.length <= len ? s : s.slice(0, len - 3) + "...";
}
