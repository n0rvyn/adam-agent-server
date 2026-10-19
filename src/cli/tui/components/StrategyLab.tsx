import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { request } from "../../client.js";

interface StrategyInfo {
  id: string;
  role: string;
  taskType: string;
  name: string;
  alpha: number;
  beta: number;
  totalTrials: number;
  avgReward?: number;
}

interface StrategyLabProps {
  onBack: () => void;
}

function samplingBar(alpha: number, beta: number, width = 15): string {
  const mean = alpha / (alpha + beta);
  const filled = Math.round(mean * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

export function StrategyLab({ onBack }: StrategyLabProps) {
  const [strategies, setStrategies] = useState<StrategyInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onBack();
    }
  });

  useEffect(() => {
    // Fetch strategies grouped by role
    request<{ strategies: StrategyInfo[] }>("/strategies?limit=50")
      .then((data) => setStrategies(data.strategies ?? []))
      .catch((err) => setError(err.message));
  }, []);

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Failed to load strategies: {error}</Text>
        <Text dimColor>Press Esc or q to return</Text>
      </Box>
    );
  }

  if (strategies.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No strategies yet. Strategies are created when goals are executed.</Text>
        <Text dimColor>Press Esc or q to return</Text>
      </Box>
    );
  }

  // Group by role/taskType
  const groups = new Map<string, StrategyInfo[]>();
  for (const s of strategies) {
    const key = `${s.role}/${s.taskType}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }

  return (
    <Box flexDirection="column">
      <Text bold>Strategy Lab</Text>
      <Text dimColor>Thompson Sampling populations — higher bar = higher selection probability</Text>
      <Box marginTop={1} flexDirection="column">
        {Array.from(groups.entries()).map(([groupKey, strats]) => (
          <Box key={groupKey} marginBottom={1} flexDirection="column">
            <Text bold color="cyan">{groupKey}</Text>
            {strats
              .sort((a, b) => {
                const meanA = a.alpha / (a.alpha + a.beta);
                const meanB = b.alpha / (b.alpha + b.beta);
                return meanB - meanA;
              })
              .map((s) => {
                const mean = s.alpha / (s.alpha + s.beta);
                return (
                  <Box key={s.id}>
                    <Text dimColor>  </Text>
                    <Text>{samplingBar(s.alpha, s.beta)} </Text>
                    <Text color={mean > 0.6 ? "green" : mean > 0.4 ? "yellow" : "red"}>
                      {(mean * 100).toFixed(0)}%
                    </Text>
                    <Text dimColor> {s.name} (α={s.alpha.toFixed(1)} β={s.beta.toFixed(1)} trials={s.totalTrials})</Text>
                  </Box>
                );
              })}
          </Box>
        ))}
      </Box>
      <Text dimColor>Press Esc or q to return</Text>
    </Box>
  );
}
