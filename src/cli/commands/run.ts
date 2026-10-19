import chalk from "chalk";
import { request, TaskStreamSocket } from "../client.js";
import * as readline from "readline";

interface RunOptions {
  model?: string;
  timeout?: number;
  budget?: number;
  template?: string;
  workspace?: string;
  approval?: boolean;
  json?: boolean;
  server?: string;
}

export async function runCommand(prompt: string, options: RunOptions): Promise<void> {
  try {
    // Build task config from options
    const config: Record<string, unknown> = {};
    if (options.model) config.model = options.model;
    if (options.timeout) config.timeout = options.timeout;
    if (options.budget) config.maxBudgetUsd = options.budget;
    if (options.workspace) config.workspacePath = options.workspace;

    // Submit task
    const { taskId } = await request<{ taskId: string }>("/tasks", {
      method: "POST",
      body: { prompt, config: Object.keys(config).length > 0 ? config : undefined },
    });

    if (options.json) {
      console.log(JSON.stringify({ taskId, status: "submitted" }));
    } else {
      console.log(chalk.dim(`Task ${taskId} submitted`));
    }

    // Handle Ctrl+C: cancel task before exit
    const handleSigint = () => {
      request(`/tasks/${taskId}/cancel`, { method: "POST" }).catch(() => {});
      if (!options.json) {
        console.log(chalk.yellow("\nTask cancelled."));
      }
      process.exit(130);
    };
    process.on("SIGINT", handleSigint);

    // Connect to task stream
    const stream = new TaskStreamSocket(taskId);
    await stream.connect();

    const events: unknown[] = [];

    await new Promise<void>((resolve) => {
      stream.on("reasoning", (data) => {
        const d = data as { content?: string };
        if (options.json) {
          events.push({ type: "reasoning", ...d });
        } else {
          process.stdout.write(chalk.gray(d.content ?? ""));
        }
      });

      stream.on("tool_call", (data) => {
        const d = data as { toolName?: string; input?: unknown };
        if (options.json) {
          events.push({ type: "tool_call", ...d });
        } else {
          console.log(chalk.blue(`\n[tool] ${d.toolName ?? "unknown"}`));
        }
      });

      stream.on("tool_result", (data) => {
        const d = data as { content?: string };
        if (options.json) {
          events.push({ type: "tool_result", ...d });
        } else {
          const content = d.content ?? "";
          const lines = content.split("\n");
          if (lines.length > 5) {
            console.log(chalk.green(`[result] (${lines.length} lines) ▸ truncated`));
          } else {
            console.log(chalk.green(`[result] ${content}`));
          }
        }
      });

      stream.on("error", (data) => {
        const d = data as { error?: string };
        if (options.json) {
          events.push({ type: "error", ...d });
        } else {
          console.error(chalk.red(`\n[error] ${d.error ?? "unknown error"}`));
        }
      });

      stream.on("approval_needed", (data) => {
        const d = data as {
          approvalId?: string;
          toolName?: string;
          toolInput?: unknown;
          matchedPattern?: string;
        };

        if (options.approval === false) {
          // --no-approval: auto-approve
          request(`/tasks/${taskId}/approve`, {
            method: "POST",
            body: { approvalId: d.approvalId, reason: "auto-approved via --no-approval" },
          }).catch(() => {});
          return;
        }

        if (options.json) {
          events.push({ type: "approval_needed", ...d });
          // In JSON mode, auto-approve
          request(`/tasks/${taskId}/approve`, {
            method: "POST",
            body: { approvalId: d.approvalId },
          }).catch(() => {});
          return;
        }

        console.log(chalk.yellow(`\n⚠ Approval needed: ${d.toolName}`));
        console.log(chalk.yellow(`  Pattern: ${d.matchedPattern}`));
        console.log(chalk.yellow(`  Input: ${JSON.stringify(d.toolInput)}`));

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(chalk.yellow("  [a]pprove / [r]eject: "), (answer) => {
          rl.close();
          const decision = answer.toLowerCase().startsWith("a") ? "approve" : "reject";
          request(`/tasks/${taskId}/${decision}`, {
            method: "POST",
            body: { approvalId: d.approvalId },
          }).catch(() => {});
        });
      });

      stream.on("complete", (data) => {
        const d = data as { result?: string; costUsd?: number; tokenUsage?: unknown; numTurns?: number };
        if (options.json) {
          console.log(JSON.stringify({ taskId, status: "completed", events, result: d }));
        } else {
          console.log(chalk.dim(`\n─── Task complete ───`));
          if (d.costUsd !== undefined) console.log(chalk.dim(`Cost: $${d.costUsd.toFixed(4)}`));
          if (d.numTurns !== undefined) console.log(chalk.dim(`Turns: ${d.numTurns}`));
        }
        stream.close();
        resolve();
      });

      // Also listen for wild card to catch completion
      stream.on("*", (data) => {
        const d = data as { type?: string };
        if (d.type === "complete") {
          // Handled above
        }
      });
    });

    // Check final task status
    const task = await request<{ task: { status: string } }>(`/tasks/${taskId}`);
    if (task.task.status === "failed" || task.task.status === "cancelled") {
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    if (options.json) {
      console.log(JSON.stringify({ error: (err as Error).message }));
    } else {
      console.error(chalk.red((err as Error).message));
    }
    process.exit(1);
  }
}
