/**
 * Platform detection for sandbox backends.
 *
 * Detects whether the current OS supports Landlock (Linux) or sandbox-exec (macOS).
 */

import { accessSync, constants } from "node:fs";
import type { SandboxPlatform } from "./types.js";
import { findLandlockExec } from "./linux.js";

/**
 * Detect the available sandbox platform for the current OS.
 *
 * @returns The detected platform, or 'none' if no sandbox is available.
 */
export function detectPlatform(): SandboxPlatform {
  if (process.platform === "linux") {
    // Quick sync check: binary must exist. Kernel check deferred to isAvailable().
    try {
      accessSync(findLandlockExec(), constants.X_OK);
      return "landlock";
    } catch {
      return "none";
    }
  }

  if (process.platform === "darwin") {
    // sandbox-exec exists on all macOS versions that support the sandbox(7) API.
    // Check the binary is present (removed only in some enterprise lock-downs).
    try {
      accessSync("/usr/bin/sandbox-exec", constants.X_OK);
      return "sandbox-exec";
    } catch {
      return "none";
    }
  }

  // FreeBSD, Windows, and other platforms have no supported sandbox backend.
  return "none";
}

/** Convenience alias. */
export { detectPlatform as detect };
