import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { openSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import type {
  MarketplaceInfo,
  AvailablePluginsResponse,
} from "../shared/types.js";

const CLI_TIMEOUT = 30_000;
const INSTALL_TIMEOUT = 120_000;

/**
 * Resolve the path to the Claude Code CLI binary.
 *
 * Defaults to the bare command `"claude"` so spawn() resolves it via PATH —
 * this matches the official Claude Code install (which puts `claude` on PATH,
 * e.g. `~/.local/bin/claude` or `/usr/local/bin/claude`).
 *
 * Override with `CLAUDE_BIN` env when running in a non-standard environment
 * (containers, alternate installs, integration tests).
 *
 * The `@anthropic-ai/claude-agent-sdk` npm package no longer ships an
 * embedded `cli.js` (verified against version 0.2.141, 2026-05-17); the
 * previous behavior of resolving `<sdk-pkg>/cli.js` is removed.
 */
function getClaudeBinPath(): string {
  return process.env.CLAUDE_BIN ?? "claude";
}

/**
 * Run the CLI synchronously, returning stdout.
 * For JSON commands, stdout is written to a temp file to avoid 64KB pipe truncation.
 */
function runCli(args: string[], options?: { cwd?: string; json?: boolean; timeout?: number }): string {
  const claudeBin = getClaudeBinPath();
  const timeout = options?.timeout ?? CLI_TIMEOUT;

  if (options?.json) {
    // Write stdout to a temp file to bypass pipe truncation (>64KB)
    const tmpFile = join(tmpdir(), `adam-cli-stdout-${process.pid}-${Date.now()}.txt`);
    const fd = openSync(tmpFile, "w");
    try {
      const result = spawnSync(claudeBin, args, {
        cwd: options.cwd,
        timeout,
        stdio: ["ignore", fd, "pipe"],
        encoding: "utf-8",
      });
      if (result.status !== 0) {
        throw new Error(result.stderr?.trim() || `claude exited with status ${result.status}`);
      }
      return readFileSync(tmpFile, "utf-8");
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  const result = spawnSync(claudeBin, args, {
    cwd: options?.cwd,
    timeout,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `claude exited with status ${result.status}`);
  }
  return result.stdout;
}

/**
 * List configured marketplace sources via `claude plugin marketplace list --json`.
 */
export function listMarketplaces(): MarketplaceInfo[] {
  const output = runCli(["plugin", "marketplace", "list", "--json"], { json: true });
  return JSON.parse(output) as MarketplaceInfo[];
}

/**
 * List installed + available plugins via `claude plugin list --available --json`.
 */
export function listAvailablePlugins(): AvailablePluginsResponse {
  const output = runCli(["plugin", "list", "--available", "--json"], { json: true });
  return JSON.parse(output) as AvailablePluginsResponse;
}

/**
 * Install a plugin via `claude plugin install <name> --scope <scope>`.
 */
export function installPlugin(name: string, scope: "user" | "project" = "user", cwd?: string): string {
  return runCli(["plugin", "install", name, "--scope", scope], {
    cwd,
    timeout: INSTALL_TIMEOUT,
  });
}

/**
 * Uninstall a plugin via `claude plugin uninstall <name>`.
 */
export function uninstallPlugin(name: string, scope?: "user" | "project", cwd?: string): string {
  const args = ["plugin", "uninstall", name];
  if (scope) args.push("--scope", scope);
  return runCli(args, {
    cwd,
    timeout: INSTALL_TIMEOUT,
  });
}

/**
 * Enable a plugin globally via `claude plugin enable <name>`.
 */
export function enablePlugin(name: string, _scope?: string): string {
  return runCli(["plugin", "enable", name]);
}

/**
 * Disable a plugin globally via `claude plugin disable <name>`.
 */
export function disablePlugin(name: string, _scope?: string): string {
  return runCli(["plugin", "disable", name]);
}

/**
 * Add a marketplace source via `claude plugin marketplace add <url>`.
 */
export function addMarketplace(url: string): string {
  return runCli(["plugin", "marketplace", "add", url]);
}

/**
 * Remove a marketplace source via `claude plugin marketplace remove <name>`.
 */
export function removeMarketplace(name: string): string {
  return runCli(["plugin", "marketplace", "remove", name]);
}

/**
 * Check if the Claude Code CLI binary is available on PATH (or at CLAUDE_BIN).
 */
export function isCliAvailable(): boolean {
  try {
    const result = spawnSync(getClaudeBinPath(), ["--version"], { timeout: 2000, encoding: "utf-8" });
    return result.status === 0;
  } catch {
    return false;
  }
}
