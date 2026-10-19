/**
 * macOS sandbox-exec provider.
 *
 * Uses sandbox-exec with SBPL deny-default profiles to restrict the Claude CLI
 * process to only the Role's declared visiblePaths. The base profile at
 * profiles/role-sandbox.sb allows system libraries, Homebrew, temp dirs, and
 * network. Dynamic per-Role paths are appended at spawn time.
 *
 * sandbox-exec is deprecated by Apple but still present on current macOS builds
 * and remains Adam's only Role-level macOS sandbox backend. If the CLI becomes
 * unavailable, provider detection falls back to NoopSandboxProvider; at that
 * point filesystem isolation and runtime-enforced OS capabilities must be shown
 * as unavailable rather than presented as working toggles. The replacement path
 * is sandbox_init() with the same SBPL profile format.
 */

import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { SandboxProvider, SandboxSpawnOptions, SandboxPlatform, VisiblePath } from "./types.js";
import { getLogger } from "../lib/logger.js";
import { generateCapabilityRules } from "./macos-capabilities.js";

const log = getLogger("sandbox-macos");

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** Resolve the base SBPL profile path. tsup bundles to dist/ flat files,
 *  so import.meta.dirname points to dist/, not src/sandbox/. Use a fallback chain. */
function resolveProfilePath(): string {
  const candidates = [
    // Source layout (dev mode / tsx watch)
    join(typeof import.meta.dirname === "string" ? import.meta.dirname : ".", "profiles", "role-sandbox.sb"),
    // Built layout: profile copied to dist/profiles/
    join(typeof import.meta.dirname === "string" ? import.meta.dirname : ".", "..", "src", "sandbox", "profiles", "role-sandbox.sb"),
    // Fallback: relative to cwd (project root)
    join(process.cwd(), "src", "sandbox", "profiles", "role-sandbox.sb"),
  ];
  for (const p of candidates) {
    try { readFileSync(p, "utf-8"); return p; } catch { /* try next */ }
  }
  // Last resort
  return candidates[candidates.length - 1];
}
const BASE_PROFILE_PATH = resolveProfilePath();

/**
 * Validate a path is safe for SBPL embedding.
 * SBPL uses S-expressions; paths with `"` or `)` would break the profile syntax.
 */
export function validateSbplPath(p: string): void {
  if (!p.startsWith("/")) {
    throw new Error(`Sandbox path must be absolute: ${p}`);
  }
  if (p.includes('"') || p.includes(")") || p.includes("(") || p.includes("$")) {
    throw new Error(`Sandbox path contains invalid characters for SBPL: ${p}`);
  }
}

/**
 * Generate SBPL write-allow rules for visible paths.
 * Reads are globally allowed (Claude CLI needs broad read access).
 * The sandbox restricts WRITES to only declared rw paths.
 * RO paths get no write rule → writes blocked by (deny default).
 */
export function generatePathRules(visiblePaths: VisiblePath[]): string {
  const lines: string[] = ["\n; ===== Per-Role writable paths ====="];

  for (const vp of visiblePaths) {
    if (vp.mode !== "rw") continue; // Only rw paths get write permission

    let resolved: string;
    try {
      resolved = realpathSync(vp.path);
    } catch {
      resolved = vp.path;
    }

    validateSbplPath(resolved);
    lines.push(`(allow file-write* (subpath "${resolved}"))`);

    // If resolved differs from original (symlink), allow both
    if (resolved !== vp.path) {
      validateSbplPath(vp.path);
      lines.push(`(allow file-write* (subpath "${vp.path}"))`);
    }
  }

  return lines.join("\n");
}

/**
 * Resolve the macOS per-user temp directory (confstr `_CS_DARWIN_USER_TEMP_DIR`,
 * e.g. `/var/folders/<hash>/T`). This is where `mktemp -t`, `NSTemporaryDirectory()`,
 * and other macOS-native temp APIs write — they consult confstr, NOT the `$TMPDIR`
 * env var, so Adam's injected per-spawn TMPDIR does NOT capture them. Plugin/skill
 * bundled scripts commonly use `mktemp -t`; without write access to this dir they
 * fail with "Operation not permitted" under the sandbox (empirically: tts-toolkit's
 * synth-auto.sh dies on its `mktemp -d -t` line). Returns the realpath'd dir, or
 * null if it cannot be resolved (caller then skips the rule — fail-safe, no regression).
 */
export function resolveDarwinUserTempDir(): string | null {
  try {
    const raw = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf-8" }).trim();
    if (!raw) return null;
    const noTrail = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    return realpathSync(noTrail);
  } catch {
    return null;
  }
}

/**
 * SBPL write-allow rule for the macOS per-user temp dir. macOS-native temp APIs
 * (`mktemp -t`, `NSTemporaryDirectory()`) write here regardless of `$TMPDIR`; granting
 * it lets plugin/skill bundled scripts run inside the sandbox instead of failing and
 * forcing the model to route around them. Scope is the CURRENT USER's single per-user
 * temp dir (`/var/folders/<hash>/T`) — NOT all of `/var/folders`, NOT `/tmp`. Reads were
 * already globally allowed; this only adds write to that one ephemeral scratch area.
 * Role-to-role workspace isolation and the home-dir / deniedReadPaths denials are unaffected.
 */
export function generateDarwinTempRule(): string {
  const dir = resolveDarwinUserTempDir();
  if (!dir) {
    log.warn("Could not resolve DARWIN_USER_TEMP_DIR; mktemp -t in plugin scripts may fail under sandbox");
    return "";
  }
  try {
    validateSbplPath(dir);
  } catch (e) {
    log.warn({ dir, error: (e as Error).message }, "Skipping Darwin temp allow rule: path invalid for SBPL");
    return "";
  }
  return `\n; ===== macOS per-user temp dir (confstr; mktemp -t / NSTemporaryDirectory target) =====\n(allow file-write* (subpath "${dir}"))`;
}

/**
 * Generate SBPL deny rules for the global read blacklist.
 * Applies to both file-read-data and file-read-metadata.
 */
export function generateReadDenyRules(deniedReadPaths: string[]): string {
  if (!deniedReadPaths.length) return "";
  const lines: string[] = ["\n; ===== Global read blacklist (deniedReadPaths) ====="];
  for (const dp of deniedReadPaths) {
    let resolved: string;
    try { resolved = realpathSync(dp); } catch { resolved = dp; }
    try {
      validateSbplPath(resolved);
      lines.push(`(deny file-read-data (subpath "${resolved}"))`);
      lines.push(`(deny file-read-metadata (subpath "${resolved}"))`);
      if (resolved !== dp) {
        validateSbplPath(dp);
        lines.push(`(deny file-read-data (subpath "${dp}"))`);
        lines.push(`(deny file-read-metadata (subpath "${dp}"))`);
      }
    } catch (e) {
      log.warn({ path: dp, error: (e as Error).message }, "Skipping deniedReadPath: invalid for SBPL");
    }
  }
  return lines.join("\n");
}

export class MacOSSandboxProvider implements SandboxProvider {
  readonly platform: SandboxPlatform = "sandbox-exec";

  async isAvailable(): Promise<boolean> {
    try {
      const { existsSync } = await import("node:fs");
      return existsSync(SANDBOX_EXEC);
    } catch {
      return false;
    }
  }

  spawn(options: SandboxSpawnOptions): SpawnedProcess {
    const { command, args, cwd, env, signal, visiblePaths, deniedReadPaths, osCapabilities } = options;

    // Read base profile
    const baseProfile = readFileSync(BASE_PROFILE_PATH, "utf-8");

    // Append dynamic per-Role path rules
    const pathRules = generatePathRules(visiblePaths);
    const readDenyRules = generateReadDenyRules(deniedReadPaths ?? []);
    const capabilityRules = generateCapabilityRules(osCapabilities);
    // macOS-native temp APIs (mktemp -t / NSTemporaryDirectory) ignore $TMPDIR and write to
    // the confstr per-user temp dir; allow it so plugin/skill bundled scripts run in-sandbox.
    const darwinTempRule = generateDarwinTempRule();
    const fullProfile = baseProfile + pathRules + readDenyRules + capabilityRules + darwinTempRule + "\n";

    // Write to temp file (one per spawn; cleaned up by exit handler)
    // realpathSync: macOS /var → /private/var; SBPL subpath checks use canonical paths
    const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "adam-sandbox-")));
    const profilePath = join(tmpDir, "role.sb");
    writeFileSync(profilePath, fullProfile, "utf-8");

    // Override TMPDIR so the sandboxed process's os.tmpdir() returns the per-spawn dir.
    // CLAUDE_CODE_TMPDIR redirects CLI session storage (default: /private/tmp/claude-{uid}/) to
    // the same per-spawn dir, keeping all temp writes under one sandbox-allowed path.
    // CLAUDE_CONFIG_DIR redirects CLI config writes (default: ~/.claude/ + ~/.claude.json) to
    // the existing CLAUDE_CONFIG path, so .claude.json stays inside the config dir.
    const roleTmpDir = tmpDir;
    const homeDir = env?.HOME ?? process.env.HOME ?? "/tmp";
    const sandboxEnv = {
      ...env,
      TMPDIR: roleTmpDir,
      CLAUDE_CODE_TMPDIR: roleTmpDir,
      CLAUDE_CONFIG_DIR: join(homeDir, ".claude"),
    } as NodeJS.ProcessEnv;

    log.debug(
      { command, visiblePaths: visiblePaths.length, profilePath },
      "Spawning sandboxed process",
    );

    const child = nodeSpawn(
      SANDBOX_EXEC,
      [
        "-f", profilePath,
        "-D", `TMPDIR=${roleTmpDir}`,
        "-D", `CLAUDE_CONFIG=${join(homeDir, ".claude")}`,
        "-D", `HOME_CACHE=${join(homeDir, "Library", "Caches")}`,
        command, ...args,
      ],
      {
        cwd,
        env: sandboxEnv,  // not the original env — uses per-spawn TMPDIR
        stdio: "pipe",
        signal,
      },
    );

    // Clean up temp profile on process exit
    child.on("exit", () => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; OS will clear /tmp on reboot
      }
    });

    return child as unknown as SpawnedProcess;
  }
}
