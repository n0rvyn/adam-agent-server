import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { request } from "../../client.js";

interface EvolutionRecord {
  id: string;
  timestamp: number;
  diff: string;
  triggerTaskId?: string;
}

interface EvolutionViewProps {
  onBack: () => void;
}

export function EvolutionView({ onBack }: EvolutionViewProps) {
  const [records, setRecords] = useState<EvolutionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onBack();
    }
  });

  useEffect(() => {
    request<EvolutionRecord[]>("/evolution-audit?limit=20")
      .then((data) => {
        setRecords(data);
        setLoading(false);
      })
      .catch((err) => {
        setError((err as Error).message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return <Text dimColor>Loading evolution log...</Text>;
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">{error}</Text>
        <Text dimColor>Press Esc to go back</Text>
      </Box>
    );
  }

  if (records.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No evolution records yet</Text>
        <Text dimColor>Press Esc to go back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Evolution Audit Log ({records.length} records) — Esc to go back</Text>
      {records.map((record) => (
        <Box key={record.id} flexDirection="column" marginTop={1}>
          <Text bold>[{new Date(record.timestamp).toLocaleString()}]</Text>
          {record.triggerTaskId && (
            <Text dimColor>  Task: {record.triggerTaskId.slice(0, 8)}</Text>
          )}
          {record.diff.split("\n").map((line, i) => {
            if (line.startsWith("+")) return <Text key={i} color="green">  {line}</Text>;
            if (line.startsWith("-")) return <Text key={i} color="red">  {line}</Text>;
            return <Text key={i} dimColor>  {line}</Text>;
          })}
        </Box>
      ))}
    </Box>
  );
}
