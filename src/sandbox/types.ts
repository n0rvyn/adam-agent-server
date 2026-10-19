/**
 * Sandbox types — core interfaces for OS-level process sandboxing.
 *
 * Architecture: a SandboxProvider abstraction with platform-specific backends.
 * On query() call, ExecutionManager passes a custom spawnClaudeCodeProcess that
 * wraps the Claude CLI spawn inside a platform-specific sandbox.
 */

import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { RoleOsCapability } from "../shared/os-capabilities.js";

/** A filesystem path visible inside the sandbox, with its access mode. */
export interface VisiblePath {
  /** Absolute path on the host filesystem */
  path: string;
  /** Read-only or read-write access */
  mode: "ro" | "rw";
}

/** The OS-level sandboxing backend available on the current system. */
export type SandboxPlatform = "landlock" | "sandbox-exec" | "none";

/** Options passed to SandboxProvider.spawn(). Mirrors SDK SpawnOptions but with signal optional. */
export interface SandboxSpawnOptions {
  /** Command to execute */
  command: string;
  /** Arguments to pass to the command */
  args: string[];
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env: Record<string, string | undefined>;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Paths the sandboxed process can see */
  visiblePaths: VisiblePath[];
  /** Global read blacklist — paths to deny reads via SBPL deny rules (macOS only).
   *  Linux Landlock does not support deny rules; read restriction is handled at
   *  the SDK layer (canUseTool blockedPath) only. See Issue #134. */
  deniedReadPaths?: string[];
  /** Role-level OS capability selections for provider-specific runtime enforcement. */
  osCapabilities?: RoleOsCapability[];
}

/**
 * Platform-specific process sandbox provider.
 *
 * child_process.spawn() with { stdio: 'pipe' } returns a ChildProcess that
 * structurally satisfies SpawnedProcess (both have stdin, stdout, killed,
 * exitCode, kill(), on()). Each provider casts the result.
 */
export interface SandboxProvider {
  readonly platform: SandboxPlatform;

  /**
   * Spawn a process inside the sandbox. Returns SDK-compatible SpawnedProcess.
   *
   * @param options - SDK spawn options extended with visiblePaths
   */
  spawn(options: SandboxSpawnOptions): SpawnedProcess;

  /**
   * Check if this provider is available on the current system.
   * Returns false when the required binary/kernel feature is absent.
   */
  isAvailable(): Promise<boolean>;
}

/** Event emitted when a sandboxed process attempts a forbidden filesystem operation. */
export interface SandboxViolationEvent {
  roleId: string;
  taskId?: string;
  path: string;
  operation: string;
  timestamp: number;
}
