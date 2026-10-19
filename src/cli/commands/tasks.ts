import chalk from "chalk";
import { request } from "../client.js";

interface Task {
  id: string;
  status: string;
  prompt: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  costUsd?: number;
  totalDurationMs?: number;
  result?: string;
  error?: string;
}

const statusColor: Record<string, (s: string) => string> = {
  pending: chalk.gray,
  queued: chalk.gray,
  running: chalk.yellow,
  paused: chalk.yellow,
  completed: chalk.green,
  failed: chalk.red,
  cancelled: chalk.gray,
};

function colorStatus(status: string): string {
  const fn = statusColor[status] ?? chalk.white;
  return fn(status);
}

function truncate(s: string, len: number): string {
  if (s.length <= len) return s;
  return s.slice(0, len - 3) + "...";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

export async function listTasksHandler(options: { status?: string; limit?: string }): Promise<void> {
  try {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    if (options.limit) params.set("limit", options.limit);

    const query = params.toString();
    const { tasks } = await request<{ tasks: Task[] }>(`/tasks${query ? `?${query}` : ""}`);

    if (tasks.length === 0) {
      console.log(chalk.dim("No tasks found"));
      return;
    }

    // Header
    console.log(
      chalk.bold(
        padRight("ID", 10) +
        padRight("STATUS", 12) +
        padRight("PROMPT", 40) +
        padRight("DURATION", 10) +
        "COST",
      ),
    );

    for (const task of tasks) {
      const duration = task.totalDurationMs ? formatDuration(task.totalDurationMs) : "—";
      const cost = task.costUsd !== undefined ? `$${task.costUsd.toFixed(4)}` : "—";
      console.log(
        padRight(task.id.slice(0, 8), 10) +
        padRight(colorStatus(task.status), 12 + 10) + // extra for ANSI codes
        padRight(truncate(task.prompt, 38), 40) +
        padRight(duration, 10) +
        cost,
      );
    }
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function showTaskHandler(id: string): Promise<void> {
  try {
    const { task } = await request<{ task: Task }>(`/tasks/${id}`);

    console.log(chalk.bold("Task Details"));
    console.log(`  ID:       ${task.id}`);
    console.log(`  Status:   ${colorStatus(task.status)}`);
    console.log(`  Prompt:   ${task.prompt}`);
    console.log(`  Created:  ${new Date(task.createdAt).toLocaleString()}`);
    if (task.startedAt) console.log(`  Started:  ${new Date(task.startedAt).toLocaleString()}`);
    if (task.completedAt) console.log(`  Finished: ${new Date(task.completedAt).toLocaleString()}`);
    if (task.totalDurationMs) console.log(`  Duration: ${formatDuration(task.totalDurationMs)}`);
    if (task.costUsd !== undefined) console.log(`  Cost:     $${task.costUsd.toFixed(4)}`);
    if (task.result) console.log(`  Result:   ${truncate(task.result, 200)}`);
    if (task.error) console.log(`  Error:    ${chalk.red(task.error)}`);
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

export async function cancelTaskHandler(id: string): Promise<void> {
  try {
    await request(`/tasks/${id}/cancel`, { method: "POST" });
    console.log(`Task ${id} cancelled`);
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

function padRight(s: string, len: number): string {
  if (s.length >= len) return s;
  return s + " ".repeat(len - s.length);
}
