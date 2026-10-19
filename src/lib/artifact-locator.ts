/**
 * ArtifactLocator URI parser and storage backend resolver stub.
 *
 * URI format: <scheme>://<profile>/<ref>
 *   local:///abs/path                 — local file (only supported runtime backend this round)
 *   webdav://work/Reports/Q2.md       — type-position only
 *   gdrive://default/<fileId>         — type-position only
 *   s3://default/<bucket>/<key>       — type-position only
 *   mcp_kb://lumina/note/<id>         — type-position only
 *   icloud://default/<rel-path>       — type-position only
 *   notion://default/page/<page_id>   — type-position only
 *   obsidian://<vault>/<rel-path>     — type-position only
 *
 * Non-local schemes throw UnsupportedBackendError on resolve attempts.
 * See docs/06-plans/2026-05-05-chat-envelope-protocol-design.md §"URI Locator Specification".
 */

import type { ArtifactLocatorScheme } from "../shared/types.js";
import { isAbsolute } from "node:path";

const ALL_SCHEMES: ArtifactLocatorScheme[] = [
  "local", "webdav", "gdrive", "s3", "mcp_kb", "icloud", "notion", "obsidian",
];

const LOCAL_SCHEMES: Set<ArtifactLocatorScheme> = new Set(["local"] as ArtifactLocatorScheme[]);

export interface ParsedLocator {
  scheme: ArtifactLocatorScheme;
  profile: string;
  ref: string;
}

export function parseLocator(uri: string): ParsedLocator | undefined {
  const schemeEnd = uri.indexOf("://");
  if (schemeEnd <= 0) return undefined;
  const scheme = uri.slice(0, schemeEnd) as ArtifactLocatorScheme;
  if (!ALL_SCHEMES.includes(scheme)) return undefined;

  const rest = uri.slice(schemeEnd + 3);

  if (scheme === "local") {
    if (!rest.startsWith("/")) return undefined;
    return { scheme, profile: "", ref: rest };
  }

  const slash = rest.indexOf("/");
  if (slash < 0) return undefined;
  const profile = rest.slice(0, slash);
  const ref = rest.slice(slash + 1);
  if (!profile || !/^[A-Za-z0-9._-]+$/.test(profile)) return undefined;
  if (!ref) return undefined;
  return { scheme, profile, ref };
}

export function serializeLocator(parsed: ParsedLocator): string {
  if (parsed.scheme === "local") {
    return `local://${parsed.ref}`;
  }
  return `${parsed.scheme}://${parsed.profile}/${parsed.ref}`;
}

export function localLocatorFromPath(absolutePath: string): string {
  if (!isAbsolute(absolutePath)) {
    throw new Error(`localLocatorFromPath requires an absolute path; got: ${absolutePath}`);
  }
  return `local://${absolutePath}`;
}

export function isLocatorSupported(parsed: ParsedLocator): boolean {
  return LOCAL_SCHEMES.has(parsed.scheme);
}

export interface StorageBackend {
  scheme: ArtifactLocatorScheme;
  put(content: Buffer, meta: { mime: string; filename: string }): Promise<string>;
  get(locator: string): Promise<Buffer>;
  exists(locator: string): Promise<boolean>;
  delete(locator: string): Promise<void>;
}

export class UnsupportedBackendError extends Error {
  constructor(scheme: string) {
    super(`Storage backend '${scheme}' is not implemented in this round (only 'local' is supported)`);
    this.name = "UnsupportedBackendError";
  }
}

/**
 * Resolver stub. Validates the URI and throws UnsupportedBackendError for non-local schemes.
 * Real local backend wiring (filesystem IO) lands in a follow-up phase.
 */
export function resolveBackend(locator: string): StorageBackend {
  const parsed = parseLocator(locator);
  if (!parsed) {
    throw new Error(`Invalid locator URI: ${locator}`);
  }
  if (!isLocatorSupported(parsed)) {
    throw new UnsupportedBackendError(parsed.scheme);
  }
  throw new Error(
    `local:// resolver not yet wired up to filesystem IO in Phase 1 — consumers should use blob_path directly. ` +
    `Locator ${locator} is structurally valid.`,
  );
}
