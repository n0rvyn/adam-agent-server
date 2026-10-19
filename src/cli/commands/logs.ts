import chalk from "chalk";
import { WebSocket } from "ws";
import { getDaemonStatus } from "../daemon.js";
import { readApiKey } from "../client.js";
import { formatLocalTimeOnly } from "../../lib/time.js";

export async function logsCommand(options: {
  follow?: boolean;
  component?: string;
  level?: string;
  port?: string;
}): Promise<void> {
  const status = getDaemonStatus();
  const serverPort = options.port ? Number(options.port) : status.port ?? 7100;
  const apiKey = readApiKey();
  const wsUrl = new URL(`ws://localhost:${serverPort}/events`);
  if (apiKey) wsUrl.searchParams.set("api_key", apiKey);
  const wsUrlStr = wsUrl.toString();
  const component = options.component;
  const level = options.level;

  function connect(): void {
    const ws = new WebSocket(wsUrlStr);

    ws.on("open", () => {
      console.log(chalk.dim(`Connected to ${wsUrlStr}`));
      if (options.follow) {
        console.log(chalk.dim("Following logs... (Ctrl+C to exit)"));
      }
    });

    ws.on("message", (data: Buffer) => {
      try {
        const event = JSON.parse(data.toString());
        if (event.type === "log_event" && event.msg) {
          // Client-side filtering
          if (component && event.component !== component) return;
          if (level && event.level !== level) return;
          printLogEvent(event);
        }
      } catch {
        // Not a log event, ignore
      }
    });

    ws.on("error", (err) => {
      console.error(chalk.red(`WebSocket error: ${err.message}`));
    });

    ws.on("close", () => {
      if (options.follow) {
        console.log(chalk.yellow("Connection closed, reconnecting..."));
        setTimeout(connect, 1000);
      }
    });
  }

  function printLogEvent(event: {
    timestamp: number;
    level: string;
    component: string;
    msg: string;
    metadata?: unknown;
  }): void {
    const time = formatLocalTimeOnly(event.timestamp);
    const levelColors: Record<string, (s: string) => string> = {
      debug: chalk.gray,
      info: chalk.blue,
      warn: chalk.yellow,
      error: chalk.red,
      fatal: chalk.bgRed.white,
    };
    const color = levelColors[event.level] || chalk.white;
    const componentTag = chalk.cyan(`[${event.component}]`);

    console.log(
      `${chalk.dim(time)} ${color(event.level.toUpperCase().padEnd(5))} ${componentTag} ${event.msg}`,
    );
    if (event.metadata && typeof event.metadata === "object" && Object.keys(event.metadata as object).length > 0) {
      console.log(chalk.dim("  ") + chalk.dim(JSON.stringify(event.metadata)));
    }
  }

  connect();

  // Keep process alive
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
    if (!options.follow) {
      // Without -f, just connect and wait a bit for initial messages
      setTimeout(resolve, 3000);
    }
  });
}
