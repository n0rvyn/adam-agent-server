import { Box, Text, useInput } from "ink";
import React, { useEffect, useState, useCallback } from "react";
import { request } from "../../client.js";
import { TaskDetail } from "./TaskDetail.js";

interface TaskInfo {
  id: string;
  status: string;
  prompt: string;
  originalPrompt?: string;
  result?: string;
  error?: string;
  roleId?: string;
  agentId?: string;
  templateId?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  totalDurationMs?: number;
  costUsd?: number;
  tokenUsage?: { input: number; output: number };
  numTurns?: number;
}

const statusColor: Record<string, string> = {
  pending: "gray",
  queued: "gray",
  running: "yellow",
  paused: "yellow",
  completed: "green",
  failed: "red",
  cancelled: "gray",
  blocked: "yellow",
};

const STATUSES = ["all", "pending", "queued", "running", "completed", "failed", "cancelled", "blocked"] as const;
const PAGE_SIZE = 15;

type Mode = "list" | "detail" | "cancelling" | "filter";

interface TaskListProps {
  onBack: () => void;
}

export function TaskList({ onBack }: TaskListProps) {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>("list");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [filterIndex, setFilterIndex] = useState(0);
  const [page, setPage] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (statusFilter !== "all") params.set("status", statusFilter);
      const data = await request<{ tasks: TaskInfo[] }>(`/tasks?${params}`);
      setTasks(data.tasks);
    } catch {
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const totalPages = Math.max(1, Math.ceil(tasks.length / PAGE_SIZE));
  const pagedTasks = tasks.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleCancel = useCallback(async () => {
    const task = pagedTasks[selectedIndex];
    if (!task) return;
    try {
      await request(`/tasks/${task.id}/cancel`, { method: "POST" });
      setMessage(`Cancelled: ${task.id.slice(0, 8)}`);
      setMode("list");
      void loadTasks();
    } catch (err) {
      setMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      setMode("list");
    }
  }, [pagedTasks, selectedIndex, loadTasks]);

  useInput((input, key) => {
    if (mode === "detail") {
      if (key.escape || key.return || input === "q") {
        setMode("list");
      }
      return;
    }

    if (mode === "cancelling") {
      if (input === "y") {
        void handleCancel();
      } else {
        setMode("list");
      }
      return;
    }

    if (mode === "filter") {
      if (key.escape) {
        setMode("list");
        return;
      }
      if (key.upArrow && filterIndex > 0) {
        setFilterIndex((i) => i - 1);
      }
      if (key.downArrow && filterIndex < STATUSES.length - 1) {
        setFilterIndex((i) => i + 1);
      }
      if (key.return) {
        setStatusFilter(STATUSES[filterIndex]);
        setPage(0);
        setSelectedIndex(0);
        setMode("list");
      }
      return;
    }

    // List mode
    if (key.escape || input === "q") {
      onBack();
      return;
    }
    if (key.upArrow && selectedIndex > 0) {
      setSelectedIndex((i) => i - 1);
    }
    if (key.downArrow && selectedIndex < pagedTasks.length - 1) {
      setSelectedIndex((i) => i + 1);
    }
    if (key.return) {
      const task = pagedTasks[selectedIndex];
      if (task) {
        setMode("detail");
      }
    }
    if (input === "x" && pagedTasks[selectedIndex]) {
      const task = pagedTasks[selectedIndex];
      if (["running", "pending", "queued", "paused"].includes(task.status)) {
        setMode("cancelling");
        setMessage(null);
      } else {
        setMessage(`Cannot cancel task in status: ${task.status}`);
      }
    }
    if (input === "f") {
      setFilterIndex(STATUSES.indexOf(statusFilter as typeof STATUSES[number]));
      setMode("filter");
    }
    if (input === "r") {
      void loadTasks();
    }
    if (key.pageDown || input === "n") {
      if (page < totalPages - 1) {
        setPage((p) => p + 1);
        setSelectedIndex(0);
      }
    }
    if (key.pageUp || input === "p") {
      if (page > 0) {
        setPage((p) => p - 1);
        setSelectedIndex(0);
      }
    }
  });

  if (loading) {
    return <Text dimColor>Loading tasks...</Text>;
  }

  // Filter mode
  if (mode === "filter") {
    return (
      <Box flexDirection="column">
        <Text bold>Filter by status:</Text>
        {STATUSES.map((s, i) => (
          <Box key={s}>
            <Text color={i === filterIndex ? "cyan" : "white"}>
              {i === filterIndex ? "> " : "  "}
              {s}
              {s === statusFilter ? " (current)" : ""}
            </Text>
          </Box>
        ))}
        <Text dimColor>Enter: select  Esc: cancel</Text>
      </Box>
    );
  }

  // Detail mode — use TaskDetail component with plan section
  if (mode === "detail" && pagedTasks[selectedIndex]) {
    return <TaskDetail taskId={pagedTasks[selectedIndex].id} onBack={() => setMode("list")} />;
  }

  // Cancel confirmation
  if (mode === "cancelling" && pagedTasks[selectedIndex]) {
    return (
      <Box flexDirection="column">
        <Text color="red">Cancel task "{pagedTasks[selectedIndex].id.slice(0, 8)}"? (y/n)</Text>
        {message && <Text color="red">{message}</Text>}
      </Box>
    );
  }

  // List mode
  const selectedTask = pagedTasks[selectedIndex] ?? null;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>Tasks ({tasks.length})</Text>
        {statusFilter !== "all" && (
          <Text dimColor> [filter: {statusFilter}]</Text>
        )}
        <Text dimColor>  •  Page {page + 1}/{totalPages}</Text>
      </Box>
      {message && (
        <Text color={message.startsWith("Failed") || message.startsWith("Cannot") ? "red" : "green"}>
          {message}
        </Text>
      )}
      {tasks.length === 0 ? (
        <Text dimColor>No tasks found{statusFilter !== "all" ? ` with status "${statusFilter}"` : ""}.</Text>
      ) : (
        <Box marginTop={1} flexDirection="row" gap={2}>
          <Box flexDirection="column" flexGrow={3}>
            {pagedTasks.map((task, i) => {
              const selected = i === selectedIndex;
              const color = statusColor[task.status] ?? "white";

              return (
                <Box key={task.id} flexDirection="column" marginBottom={1}>
                  <Box>
                    <Text color={selected ? "cyan" : "gray"} bold={selected}>
                      {selected ? "❯ " : "  "}
                    </Text>
                    <Text color={color} bold>
                      {task.status.toUpperCase()}
                    </Text>
                    <Text dimColor>{`  ${task.id.slice(0, 8)}`}</Text>
                  </Box>
                  <Box paddingLeft={2}>
                    <Text color={selected ? "white" : undefined}>
                      {compactText(task.prompt, selected ? 72 : 56)}
                    </Text>
                  </Box>
                  <Box paddingLeft={2}>
                    <Text dimColor>
                      {formatAge(task.createdAt)}  •  {formatDuration(task)}  •  {formatCost(task.costUsd)}
                    </Text>
                  </Box>
                </Box>
              );
            })}
          </Box>

          <Box flexDirection="column" flexGrow={2} borderStyle="round" borderDimColor paddingX={1}>
            {selectedTask ? (
              <>
                <Text bold>Preview</Text>
                <Box marginTop={1}>
                  <Text color={statusColor[selectedTask.status] ?? "white"} bold>
                    {selectedTask.status.toUpperCase()}
                  </Text>
                  <Text dimColor>{`  ${selectedTask.id.slice(0, 8)}`}</Text>
                </Box>
                <Text>{compactText(selectedTask.prompt, 220)}</Text>
                <Box marginTop={1} flexDirection="column">
                  <Text dimColor>Role: {selectedTask.roleId ?? selectedTask.agentId ?? "—"}</Text>
                  <Text dimColor>Created: {formatAge(selectedTask.createdAt)}</Text>
                  <Text dimColor>Duration: {formatDuration(selectedTask)}</Text>
                  <Text dimColor>Cost: {formatCost(selectedTask.costUsd)}</Text>
                  <Text dimColor>Turns: {selectedTask.numTurns ?? "—"}</Text>
                </Box>
                {selectedTask.error ? (
                  <Box marginTop={1} flexDirection="column">
                    <Text color="red" bold>Error</Text>
                    <Text color="red">{compactText(selectedTask.error, 180)}</Text>
                  </Box>
                ) : selectedTask.result ? (
                  <Box marginTop={1} flexDirection="column">
                    <Text color="green" bold>Latest Result</Text>
                    <Text>{compactText(selectedTask.result, 180)}</Text>
                  </Box>
                ) : null}
                <Box marginTop={1}>
                  <Text dimColor>Enter opens full detail</Text>
                </Box>
              </>
            ) : (
              <Text dimColor>Select a task to inspect it.</Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}

function truncate(s: string, len: number): string {
  return s.length <= len ? s : s.slice(0, len - 3) + "...";
}

function compactText(s: string, len: number): string {
  return truncate(s.replace(/\s+/g, " ").trim(), len);
}

function formatDuration(task: Pick<TaskInfo, "totalDurationMs" | "startedAt">): string {
  const durationMs = task.totalDurationMs ?? (task.startedAt ? Date.now() - task.startedAt : undefined);
  if (!durationMs) return "waiting";
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function formatCost(costUsd?: number): string {
  return costUsd !== undefined ? `$${costUsd.toFixed(4)}` : "no cost";
}

function formatAge(createdAt: number): string {
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d ago`;
}
