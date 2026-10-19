/**
 * SandboxProvider factory.
 *
 * Returns the platform-appropriate SandboxProvider, or NoopSandboxProvider when
 * no OS sandbox is available. The NoopSandboxProvider is a passthrough — it does
 * not restrict the spawned process. Privilege-escalation checks (sandbox bypass
 * approval) live in ExecutionManager, before query() is called.
 */

import { detectPlatform } from "./detect.js";
import { MacOSSandboxProvider as _MacOSSandboxProvider } from "./macos.js";
import { LinuxLandlockProvider as _LinuxLandlockProvider } from "./linux.js";
import type { SandboxProvider, SandboxSpawnOptions, SandboxPlatform } from "./types.js";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { spawn as nodeSpawn } from "node:child_process";

let _provider: SandboxProvider | null = null;
let _platform: SandboxPlatform | null = null;
let _availabilityCache: boolean | null = null;

/**
 * Lazily initialise and return the singleton SandboxProvider for this process.
 * Platform providers are imported lazily to avoid pulling in logger/pino at import time.
 */
export function getSandboxProvider(): SandboxProvider {
  if (_provider) return _provider;

  const platform = _platform ?? detectPlatform();
  _platform = platform;

  if (platform === "sandbox-exec") {
    _provider = new _MacOSSandboxProvider();
  } else if (platform === "landlock") {
    _provider = new _LinuxLandlockProvider();
  } else {
    _provider = new NoopSandboxProvider(platform);
  }

  return _provider!;
}

/**
 * Memoized sandbox availability check.
 * The result never changes during process lifetime — memoize to avoid repeated filesystem checks.
 */
export async function isSandboxAvailable(): Promise<boolean> {
  if (_availabilityCache !== null) return _availabilityCache;
  const provider = getSandboxProvider();
  _availabilityCache = await provider.isAvailable();
  return _availabilityCache;
}

/**
 * NoopSandboxProvider — passthrough that imposes no OS-level restrictions.
 * Used when no sandbox backend is available (Windows, unknown platform,
 * or sandbox binary not found).
 *
 * The SDK's spawnClaudeCodeProcess hook is synchronous — we cannot await
 * async approval inside spawn(). Instead, ExecutionManager gates query() with
 * a privilege-escalation check when platform === 'none'.
 */
class NoopSandboxProvider implements SandboxProvider {
  readonly platform: SandboxPlatform;

  constructor(platform: SandboxPlatform) {
    this.platform = platform;
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }

  spawn(options: SandboxSpawnOptions): SpawnedProcess {
    const command = options.command ?? "node";
    const args = options.args ?? [];
    return nodeSpawn(command, args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: "pipe",
      signal: options.signal,
    }) as unknown as SpawnedProcess;
  }
}

export { NoopSandboxProvider };
