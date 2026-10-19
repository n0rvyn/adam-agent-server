#!/usr/bin/env node

import { Command } from "commander";
import { startDaemon, stopDaemon, getDaemonStatus, getLogPath } from "./daemon.js";
import { getHealth } from "./client.js";
import { readFileSync, existsSync, createReadStream } from "fs";
import React from "react";
import { render } from "ink";
import { runCommand } from "./commands/run.js";
import { listTasksHandler, showTaskHandler, cancelTaskHandler } from "./commands/tasks.js";
import { configHandler } from "./commands/config.js";
import { evolutionHandler } from "./commands/evolution.js";
import { logsCommand } from "./commands/logs.js";
import { getVersion } from "../lib/version.js";

const program = new Command();

program
  .name("adam")
  .description("Adam Agent Server CLI")
  .version(getVersion());

// Server management commands
const server = program
  .command("server")
  .description("Server management");

server
  .command("start")
  .description("Start the server daemon")
  .action(async () => {
    try {
      const { pid, port } = await startDaemon();
      console.log(`Server started (PID ${pid}, port ${port})`);
    } catch (err) {
      console.error("Failed to start server:", (err as Error).message);
      process.exit(1);
    }
  });

server
  .command("stop")
  .description("Stop the server daemon")
  .action(async () => {
    try {
      await stopDaemon();
      console.log("Server stopped");
    } catch (err) {
      console.error("Failed to stop server:", (err as Error).message);
      process.exit(1);
    }
  });

server
  .command("restart")
  .description("Restart the server daemon")
  .action(async () => {
    try {
      const status = getDaemonStatus();
      if (status.running) {
        await stopDaemon();
        console.log("Server stopped");
      }
      const { pid, port } = await startDaemon();
      console.log(`Server restarted (PID ${pid}, port ${port})`);
    } catch (err) {
      console.error("Failed to restart server:", (err as Error).message);
      process.exit(1);
    }
  });

server
  .command("status")
  .description("Show server status")
  .action(() => {
    const status = getDaemonStatus();
    if (status.running) {
      console.log(`Server is running (PID ${status.pid}, port ${status.port})`);
    } else if (status.pid) {
      console.log("Server not running (stale PID file)");
    } else {
      console.log("Server not running");
    }
  });

server
  .command("logs")
  .description("Show server logs")
  .option("-f, --follow", "Follow log output")
  .action(async (options) => {
    const logPath = getLogPath();
    if (!existsSync(logPath)) {
      console.log("No log file found");
      return;
    }

    if (options.follow) {
      const stream = createReadStream(logPath, { encoding: "utf-8" });
      for await (const chunk of stream) {
        process.stdout.write(chunk as string);
      }
    } else {
      console.log(readFileSync(logPath, "utf-8"));
    }
  });

// Run command
program
  .command("run <prompt>")
  .description("Submit a task and stream output")
  .option("--model <model>", "Model to use")
  .option("--timeout <seconds>", "Task timeout", parseInt)
  .option("--budget <usd>", "Max budget in USD", parseFloat)
  .option("--template <name>", "Task template to use")
  .option("--workspace <path>", "Workspace directory")
  .option("--no-approval", "Auto-approve all approval requests")
  .option("--json", "Output as JSON")
  .option("--server <url>", "Server URL")
  .action(runCommand);

// Tasks commands
const tasks = program
  .command("tasks")
  .description("Task management");

tasks
  .command("list")
  .description("List recent tasks")
  .option("-s, --status <status>", "Filter by status")
  .option("-l, --limit <number>", "Limit results", "20")
  .action(listTasksHandler);

tasks
  .command("show <id>")
  .description("Show task details")
  .action(showTaskHandler);

tasks
  .command("cancel <id>")
  .description("Cancel a running task")
  .action(cancelTaskHandler);

// Config command
program
  .command("config")
  .description("Display current configuration")
  .option("--json", "Output as JSON")
  .action(configHandler);

// Evolution command
program
  .command("evolution")
  .description("Show self-evolution audit log")
  .option("-l, --limit <number>", "Limit results", "20")
  .action(evolutionHandler);

// Logs command — real-time log streaming via WebSocket
program
  .command("logs")
  .description("Stream server logs in real-time via WebSocket")
  .option("-f, --follow", "Follow logs continuously")
  .option("-c, --component <component>", "Filter by component (manager, worker, scheduler, api, ws)")
  .option("-l, --level <level>", "Filter by level (debug, info, warn, error)")
  .option("-p, --port <port>", "Server port")
  .action(logsCommand);

// Default action — interactive TUI
program.action(async () => {
  // Check if server is reachable before launching TUI
  try {
    await getHealth();
  } catch {
    const status = getDaemonStatus();
    if (status.running) {
      console.error("Server is running but not responding. Check: adam server logs");
    } else {
      console.error("Server not running. Run: adam server start");
    }
    process.exit(1);
  }

  const App = (await import("./tui/App.js")).default;
  const { waitUntilExit } = render(React.createElement(App));
  await waitUntilExit();
});

program.parse();
