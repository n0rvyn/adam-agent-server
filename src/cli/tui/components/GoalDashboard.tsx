import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import React, { useEffect, useState } from "react";
import { request } from "../../client.js";

interface GoalInfo {
  id: string;
  name: string;
  status: string;
  role: string;
  metricType: string;
  targetValue: number;
  currentValue: number;
  deadline: number;
  budgetUsd: number;
}

const statusColor: Record<string, string> = {
  pending: "gray",
  planning: "cyan",
  executing: "yellow",
  evaluating: "blue",
  replanning: "magenta",
  completed: "green",
  failed: "red",
  paused: "gray",
};

interface GoalDashboardProps {
  onBack: () => void;
}

type Mode = "list" | "create";

function progressBar(progress: number, width = 20): string {
  const filled = Math.round(progress * width);
  const empty = width - filled;
  return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

function daysRemaining(deadline: number): string {
  const days = Math.max(0, Math.floor((deadline - Date.now()) / 86400000));
  if (days === 0) return "< 1d";
  return `${days}d`;
}

export function GoalDashboard({ onBack }: GoalDashboardProps) {
  const [goals, setGoals] = useState<GoalInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("list");
  const [goalInput, setGoalInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<string | null>(null);

  useInput((input, key) => {
    if (mode === "create") {
      if (key.escape) {
        setMode("list");
        setGoalInput("");
        setCreateResult(null);
      }
      return;
    }
    if (key.escape || input === "q") {
      onBack();
    }
    if (input === "c") {
      setMode("create");
      setCreateResult(null);
    }
    if (input === "r") {
      loadGoals();
    }
  });

  const loadGoals = () => {
    request<{ goals: GoalInfo[] }>("/goals?limit=20")
      .then(({ goals: g }) => setGoals(g))
      .catch((err) => setError(err.message));
  };

  useEffect(() => {
    loadGoals();
  }, []);

  const handleCreateSubmit = async (value: string) => {
    if (!value.trim()) return;
    setCreating(true);
    setCreateResult(null);
    try {
      const result = await request<{ goal: GoalInfo }>("/goals", {
        method: "POST",
        body: { input: value.trim() },
      });
      setCreateResult(`Goal created: ${result.goal.name}`);
      setGoalInput("");
      setMode("list");
      loadGoals();
    } catch (err) {
      setCreateResult(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCreating(false);
    }
  };

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Failed to load goals: {error}</Text>
        <Text dimColor>Press Esc or q to return</Text>
      </Box>
    );
  }

  if (mode === "create") {
    return (
      <Box flexDirection="column">
        <Text bold>Create Goal</Text>
        <Text dimColor>Describe your SMART goal in natural language:</Text>
        <Box marginTop={1}>
          <Text color="cyan">&gt; </Text>
          <TextInput
            value={goalInput}
            onChange={setGoalInput}
            onSubmit={handleCreateSubmit}
          />
        </Box>
        {creating && <Text color="yellow">Creating goal...</Text>}
        {createResult && (
          <Text color={createResult.startsWith("Failed") ? "red" : "green"}>
            {createResult}
          </Text>
        )}
        <Text dimColor>Press Esc to cancel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Goal Dashboard ({goals.length})</Text>
      {goals.length === 0 ? (
        <Text dimColor>No goals found. Press c to create one.</Text>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {goals.map((goal) => {
            const progress = goal.targetValue > 0 ? goal.currentValue / goal.targetValue : 0;
            const color = statusColor[goal.status] ?? "white";

            return (
              <Box key={goal.id} marginBottom={1} flexDirection="column">
                <Box>
                  <Text bold color={color}>{goal.name}</Text>
                  <Text dimColor> ({goal.role})</Text>
                  <Text dimColor> — </Text>
                  <Text color={color}>{goal.status}</Text>
                </Box>
                <Box>
                  <Text dimColor>  {progressBar(progress)} </Text>
                  <Text color={progress >= 1 ? "green" : "white"}>
                    {Math.round(progress * 100)}%
                  </Text>
                  <Text dimColor> ({goal.currentValue}/{goal.targetValue} {goal.metricType})</Text>
                </Box>
                <Box>
                  <Text dimColor>  ⏰ {daysRemaining(goal.deadline)} left</Text>
                  <Text dimColor> | 💰 ${goal.budgetUsd}</Text>
                  <Text dimColor> | ID: {goal.id.slice(0, 8)}</Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}
      <Text dimColor>c:create  r:refresh  Esc/q:back</Text>
    </Box>
  );
}
