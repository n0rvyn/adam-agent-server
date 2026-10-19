import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { readFileSync, existsSync } from "fs";
import { parse } from "yaml";
import { CONFIG_PATH } from "../../../shared/constants.js";

interface ConfigViewProps {
  onBack: () => void;
}

export function ConfigView({ onBack }: ConfigViewProps) {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onBack();
    }
  });

  useEffect(() => {
    try {
      const configPath = CONFIG_PATH;
      if (!existsSync(configPath)) {
        setError(`Config file not found: ${configPath}`);
        return;
      }
      const raw = readFileSync(configPath, "utf-8");
      setConfig(parse(raw));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">{error}</Text>
        <Text dimColor>Press Esc to go back</Text>
      </Box>
    );
  }

  if (!config) {
    return <Text dimColor>Loading config...</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text bold>Configuration (Esc to go back)</Text>
      <Box marginTop={1} flexDirection="column">
        <ConfigTree obj={config} indent={0} />
      </Box>
    </Box>
  );
}

function ConfigTree({ obj, indent }: { obj: Record<string, unknown>; indent: number }) {
  const prefix = "  ".repeat(indent);
  return (
    <>
      {Object.entries(obj).map(([key, value]) => {
        return <ConfigValue key={key} label={key} value={value} indent={indent} parentKey={key} />;
      })}
    </>
  );
}

function ConfigValue({
  label,
  value,
  indent,
  parentKey,
}: {
  label: string;
  value: unknown;
  indent: number;
  parentKey: string;
}) {
  const prefix = "  ".repeat(indent);

  if (Array.isArray(value)) {
    return (
      <Box flexDirection="column">
        <Text>{prefix}<Text color="cyan">{label}</Text>:</Text>
        {value.length === 0 ? (
          <Text dimColor>{prefix}  []</Text>
        ) : (
          value.map((item, index) => (
            <ConfigArrayItem key={`${label}-${index}`} value={item} indent={indent + 1} parentKey={parentKey} index={index} />
          ))
        )}
      </Box>
    );
  }

  if (value && typeof value === "object") {
    return (
      <Box flexDirection="column">
        <Text>{prefix}<Text color="cyan">{label}</Text>:</Text>
        <ConfigTree obj={value as Record<string, unknown>} indent={indent + 1} />
      </Box>
    );
  }

  return (
    <Text>
      {prefix}<Text color="cyan">{label}</Text>: {maskSensitive(parentKey, formatPrimitive(value))}
    </Text>
  );
}

function ConfigArrayItem({
  value,
  indent,
  parentKey,
  index,
}: {
  value: unknown;
  indent: number;
  parentKey: string;
  index: number;
}) {
  const prefix = "  ".repeat(indent);

  if (Array.isArray(value)) {
    return (
      <Box flexDirection="column">
        <Text>{prefix}- [{index}]</Text>
        {value.map((item, itemIndex) => (
          <ConfigArrayItem key={`${index}-${itemIndex}`} value={item} indent={indent + 1} parentKey={parentKey} index={itemIndex} />
        ))}
      </Box>
    );
  }

  if (value && typeof value === "object") {
    return (
      <Box flexDirection="column">
        <Text>{prefix}-</Text>
        <ConfigTree obj={value as Record<string, unknown>} indent={indent + 1} />
      </Box>
    );
  }

  return <Text>{prefix}- {maskSensitive(parentKey, formatPrimitive(value))}</Text>;
}

function maskSensitive(key: string, value: string): string {
  const lowerKey = key.toLowerCase();
  if (lowerKey.includes("key") || lowerKey.includes("token") || lowerKey.includes("secret") || lowerKey.includes("password")) {
    if (!value || value.length < 8) return "****";
    return value.slice(0, 4) + "****";
  }
  return value;
}

function formatPrimitive(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  return String(value);
}
