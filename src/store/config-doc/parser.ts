/**
 * Config-doc parser.
 *
 * Deterministic, byte-exact parser for the config-doc format. See
 * `docs/02-architecture/config-doc-format.md` for the spec.
 *
 * Design rules:
 * - Byte-exact anchor extraction is content-opaque. Each anchor declares
 *   `bytes=<n>` and `sha256=<hex>`. The parser reads exactly `n` bytes
 *   after the open marker's terminating newline, verifies the SHA-256, and
 *   confirms the trailing close marker. Backticks, fake close markers, or
 *   newlines inside the content cannot truncate or inject because the
 *   parser is bound by the byte length, not by string scanning.
 * - Fail-closed everywhere. Any mismatch (hash, length, missing marker,
 *   unresolvable path) throws. There is no fallback to LLM re-emission or
 *   partial bytes.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  EXPORT_DIR,
  MACHINE_CLOSE,
  MACHINE_OPEN,
  type AnchorBlock,
  type ConfigDocHeader,
  type DependencyEntry,
  type ParsedConfigDoc,
  type PlaceholderEntry,
  type PortableConfig,
  resolveExportDir,
} from "./types.js";

// ---------------------------------------------------------------------------
// Marker grammar
// ---------------------------------------------------------------------------

// Open marker:  <!-- adam:field id="<scope>" bytes="<n>" sha256="<hex>" -->
const OPEN_MARKER_RE =
  /<!-- adam:field id="([^"]+)" bytes="(\d+)" sha256="([0-9a-f]{64})" -->/;

// Close marker: <!-- /adam:field id="<scope>" -->
const CLOSE_MARKER_RE = /<!-- \/adam:field id="([^"]+)" -->/;

// Header fence: the FIRST ```yaml ... ``` block at the top of the doc.
const HEADER_FENCE_RE = /^```yaml\n([\s\S]*?)\n```/;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function extractHeader(text: string): { headerText: string; body: string } {
  const m = HEADER_FENCE_RE.exec(text);
  if (!m) {
    throw new Error("config-doc: missing leading ```yaml header fence");
  }
  return {
    headerText: m[1],
    body: text.slice(m[0].length),
  };
}

/**
 * Tiny yaml-line parser for the simple shape used by the header.
 * Supports:
 *   key: value
 *   key:
 *     - item
 *     - item
 *   - key: value
 *     otherKey: value
 *   - key
 *
 * Deliberately NOT a full yaml parser. The header shape is constrained
 * (no anchors, no multi-line scalars, no flow style). If a header value
 * is a complex object, callers should keep it shallow.
 */
function parseHeaderYaml(headerText: string): Record<string, unknown> {
  const lines = headerText.split("\n");
  const root: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    // Top-level key (no leading whitespace)
    const topMatch = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!topMatch) {
      throw new Error(`config-doc: malformed header line: ${JSON.stringify(line)}`);
    }
    const [, key, rawValue] = topMatch;
    if (rawValue !== "") {
      // Scalar value
      root[key] = parseScalar(rawValue);
      i++;
    } else {
      // Block: collect indented children until dedent
      const block: Array<Record<string, unknown> | string> = [];
      i++;
      while (i < lines.length) {
        const child = lines[i];
        if (child.trim() === "") {
          i++;
          continue;
        }
        if (!/^\s/.test(child)) break; // dedent
        // List item: "  - ..."
        const listMatch = /^\s*-\s*(.*)$/.exec(child);
        if (listMatch) {
          const rest = listMatch[1];
          // Inline dict: "- key: value" — same line carries the first key
          const inlineDict = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(rest);
          if (inlineDict) {
            const obj: Record<string, unknown> = {};
            obj[inlineDict[1]] = parseScalar(inlineDict[2]);
            i++;
            // Continuation: more indented children for the same list item.
            // YAML convention: the continuation column matches the column of the
            // first key after the dash. We measure the column of `inlineDict[1]`
            // relative to the start of the line.
            const dashColumn = (child.match(/^\s*/) ?? [""])[0].length; // 0-indexed
            const firstKeyColumn = dashColumn + 2 /* "- " */; // 0-indexed
            const minChildIndent = firstKeyColumn; // any column >= firstKeyColumn
            while (i < lines.length) {
              const peek = lines[i];
              if (peek.trim() === "") { i++; continue; }
              const peekIndent = (peek.match(/^\s*/) ?? [""])[0].length;
              if (peekIndent < minChildIndent) break;
              const cont = peek.trimStart();
              const contMatch = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(cont);
              if (contMatch) {
                obj[contMatch[1]] = parseScalar(contMatch[2]);
              } else {
                // Unknown shape — replace last pushed object with raw scalar
                block[block.length - 1] = cont;
              }
              i++;
            }
            block.push(obj);
          } else {
            const scalar = parseScalar(rest);
            block.push(typeof scalar === "number" ? String(scalar) : scalar);
            i++;
          }
        } else {
          // Should not happen for our header shape — but tolerate
          i++;
        }
      }
      root[key] = block;
    }
  }

  return root;
}

function parseScalar(raw: string): string | number {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  // Quoted string
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  // Integer
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  // Plain string
  return trimmed;
}

// ---------------------------------------------------------------------------
// Header → ConfigDocHeader
// ---------------------------------------------------------------------------

function headerObjectToConfigDocHeader(obj: Record<string, unknown>): ConfigDocHeader {
  const schemaVersionRaw = obj.schema_version;
  if (typeof schemaVersionRaw !== "number") {
    throw new Error("config-doc: header.schema_version missing or not a number");
  }
  const exportedAt = obj.exported_at;
  if (typeof exportedAt !== "string") {
    throw new Error("config-doc: header.exported_at missing or not a string");
  }
  return {
    schemaVersion: schemaVersionRaw,
    exportedAt,
    templates: parseInventory(obj.templates, "templates"),
    roles: parseInventory(obj.roles, "roles"),
    dependencies: parseDependencies(obj.dependencies),
    placeholders: parsePlaceholders(obj.placeholders),
    ledgerOwners: parseLedgerOwners(obj.ledger_owners),
  };
}

function parseInventory(
  raw: unknown,
  field: string,
): Array<{ id: string; name: string }> {
  if (!Array.isArray(raw)) {
    throw new Error(`config-doc: header.${field} missing or not a list`);
  }
  return raw.map((item, i) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`config-doc: header.${field}[${i}] not an object`);
    }
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.name !== "string") {
      throw new Error(`config-doc: header.${field}[${i}] missing id/name`);
    }
    return { id: o.id, name: o.name };
  });
}

function parseDependencies(raw: unknown): DependencyEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, i) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`config-doc: header.dependencies[${i}] not an object`);
    }
    const o = item as Record<string, unknown>;
    if (typeof o.pluginId !== "string") {
      throw new Error(`config-doc: header.dependencies[${i}].pluginId missing`);
    }
    const source = typeof o.source === "string" ? o.source : "unknown";
    const kind = o.kind === "plugin" || o.kind === "skill" || o.kind === "mcpServer"
      ? o.kind
      : "plugin";
    return { pluginId: o.pluginId, source, kind };
  });
}

function parsePlaceholders(raw: unknown): PlaceholderEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, i) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`config-doc: header.placeholders[${i}] not an object`);
    }
    const o = item as Record<string, unknown>;
    if (typeof o.name !== "string" || typeof o.kind !== "string" || typeof o.boundField !== "string") {
      throw new Error(
        `config-doc: header.placeholders[${i}] missing name/kind/boundField`,
      );
    }
    const kind = o.kind;
    if (
      kind !== "channel" &&
      kind !== "model" &&
      kind !== "path" &&
      kind !== "secret" &&
      kind !== "env"
    ) {
      throw new Error(`config-doc: header.placeholders[${i}].kind invalid: ${kind}`);
    }
    return { name: o.name, kind, boundField: o.boundField };
  });
}

function parseLedgerOwners(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error("config-doc: header.ledger_owners not a list");
  }
  return raw.map((v, i) => {
    if (typeof v !== "string") {
      throw new Error(`config-doc: header.ledger_owners[${i}] not a string`);
    }
    return v;
  });
}

// ---------------------------------------------------------------------------
// Anchor indexing
// ---------------------------------------------------------------------------

interface AnchorIndexEntry {
  id: string;
  bytes: number;
  sha256: string;
  /** Byte offset (in `bodyBuf`) of the byte immediately AFTER the open marker's terminating newline. */
  contentStart: number;
}

/**
 * Index every anchor in `bodyBuf`. Returns entries in document order with
 * byte offsets into `bodyBuf`. The parser uses byte offsets for content
 * slicing (length-prefixed extraction) because the anchor declares a UTF-8
 * byte length; string operations alone mis-count multi-byte characters.
 *
 * Strategy: scan the body string character-by-character using the open
 * marker regex (the marker grammar is ASCII-only, so its char index in the
 * string equals its byte index in the buffer). Track `cursorByte` separately
 * from the regex scan so the close-marker search can be anchored at the
 * correct BYTE position.
 */
function indexAnchors(bodyBuf: Buffer): AnchorIndexEntry[] {
  const entries: AnchorIndexEntry[] = [];
  // Pure BYTE cursor. The format is byte-length prefixed precisely so that
  // multi-byte UTF-8 (CJK in marker ids like `step.采集.prompt`, and CJK in the
  // inline text between anchors) never desyncs offsets. We decode a tail string
  // only to run the ASCII open-marker regex, then translate the match position
  // back to bytes via Buffer.byteLength — never by char index arithmetic.
  let cursorByte = 0;
  while (cursorByte < bodyBuf.length) {
    const tailStr = bodyBuf.subarray(cursorByte).toString("utf8");
    const openMatch = OPEN_MARKER_RE.exec(tailStr);
    if (!openMatch) break;
    // Byte distance from the cursor to the start of the matched open marker
    // (the skipped text may contain CJK → use byteLength, not char index).
    const openStartByte = cursorByte + Buffer.byteLength(tailStr.slice(0, openMatch.index), "utf8");
    // The marker id may contain CJK (step ids) → byteLength of the whole match.
    const openEndByte = openStartByte + Buffer.byteLength(openMatch[0], "utf8");
    // Skip trailing newline byte if present so content starts on a clean boundary.
    let contentStartByte = openEndByte;
    if (bodyBuf[contentStartByte] === 0x0a /* \n */) contentStartByte++;
    const id = openMatch[1];
    const bytes = Number(openMatch[2]);
    const sha256 = openMatch[3];
    if (contentStartByte + bytes > bodyBuf.length) {
      throw new Error(
        `config-doc: anchor "${id}" declares ${bytes} bytes but only ${bodyBuf.length - contentStartByte} remain`,
      );
    }
    // The close marker must appear immediately AFTER the content. The renderer
    // emits exactly one `\n` between the content and the close marker. Validate
    // at the BYTE level (no char/byte translation).
    const afterContentByte = contentStartByte + bytes;
    if (bodyBuf[afterContentByte] !== 0x0a /* \n */) {
      throw new Error(
        `config-doc: anchor "${id}" bytes length mismatch ` +
          `(declared ${bytes}; byte after content is not the expected newline)`,
      );
    }
    const closeMarkerBuf = Buffer.from(`<!-- /adam:field id="${id}" -->`, "utf8");
    const closeStartByte = afterContentByte + 1; // skip the \n
    const closeSlice = bodyBuf.subarray(closeStartByte, closeStartByte + closeMarkerBuf.length);
    if (Buffer.compare(closeSlice, closeMarkerBuf) !== 0) {
      // The close marker is not exactly where the declared byte length puts it
      // → wrong `bytes`, tampered content, or truncated doc. Fail closed.
      throw new Error(
        `config-doc: anchor "${id}" bytes length mismatch ` +
          `(declared ${bytes}; close marker not found immediately after the declared content end)`,
      );
    }
    // Eager hash validation: extract the declared content bytes and verify the
    // declared sha256, so parseConfigDoc fails closed on a tampered hash at
    // parse time, not only on a later getAnchorBytes call.
    const contentBuf = bodyBuf.subarray(contentStartByte, contentStartByte + bytes);
    const actualSha = sha256Hex(contentBuf);
    if (actualSha !== sha256) {
      throw new Error(
        `config-doc: anchor "${id}" sha256 mismatch ` +
          `(declared ${sha256}, computed ${actualSha})`,
      );
    }
    entries.push({
      id,
      bytes,
      sha256,
      contentStart: contentStartByte,
    });
    // Advance the byte cursor past the close marker (+ its trailing newline).
    let closeEndByte = closeStartByte + closeMarkerBuf.length;
    if (bodyBuf[closeEndByte] === 0x0a /* \n */) closeEndByte++;
    cursorByte = closeEndByte;
  }
  return entries;
}

function buildAnchorMap(entries: AnchorIndexEntry[]): Map<string, AnchorIndexEntry> {
  const m = new Map<string, AnchorIndexEntry>();
  for (const e of entries) {
    if (m.has(e.id)) {
      throw new Error(`config-doc: duplicate anchor id "${e.id}"`);
    }
    m.set(e.id, e);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a config-doc text into a `ParsedConfigDoc` with a
 * `getAnchorBytes(id)` accessor and the parsed header.
 *
 * Throws on:
 * - missing or malformed header fence
 * - missing or malformed header fields
 * - duplicate anchor ids
 * - missing close marker for an anchor
 * - hash / length mismatch on `getAnchorBytes(id)`
 */
export function parseConfigDoc(text: string): ParsedConfigDoc {
  const { headerText, body } = extractHeader(text);
  const headerObj = parseHeaderYaml(headerText);
  const header = headerObjectToConfigDocHeader(headerObj);
  // Work in bytes for the body so anchor extraction is byte-exact across
  // multi-byte UTF-8 characters. The body is the raw text after the header fence.
  const bodyBuf = Buffer.from(body, "utf8");
  const entries = indexAnchors(bodyBuf);
  const map = buildAnchorMap(entries);
  const anchorIds = entries.map((e) => e.id);

  return {
    header,
    anchorIds,
    getAnchorBytes(id: string): Buffer {
      const entry = map.get(id);
      if (!entry) {
        throw new Error(`config-doc: anchor "${id}" not found`);
      }
      // Slice exactly `bytes` bytes from the content region.
      const buf = bodyBuf.subarray(entry.contentStart, entry.contentStart + entry.bytes);
      if (buf.length !== entry.bytes) {
        throw new Error(
          `config-doc: anchor "${id}" bytes length mismatch ` +
            `(declared ${entry.bytes}, computed ${buf.length})`,
        );
      }
      const actualSha = sha256Hex(buf);
      if (actualSha !== entry.sha256) {
        throw new Error(
          `config-doc: anchor "${id}" sha256 mismatch ` +
            `(declared ${entry.sha256}, computed ${actualSha})`,
        );
      }
      return Buffer.from(buf);
    },
  };
}

// ---------------------------------------------------------------------------
// Machine block: parsePortableConfig
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PROHIBITED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function rejectProhibitedKeys(value: unknown, path: string[] = []): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      rejectProhibitedKeys(value[i], [...path, String(i)]);
    }
    return;
  }
  for (const k of Object.keys(value as Record<string, unknown>)) {
    if (PROHIBITED_KEYS.has(k)) {
      throw new Error(
        `config-doc: machine block contains prohibited key "${k}" at ${path.join(".") || "<root>"}. ` +
          `Refusing to parse to prevent prototype pollution.`,
      );
    }
    rejectProhibitedKeys((value as Record<string, unknown>)[k], [...path, k]);
  }
}

function collectAnchorIds(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectAnchorIds(item, out);
    return out;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.__anchor === "string") out.push(obj.__anchor);
  for (const k of Object.keys(obj)) {
    if (k === "__anchor") continue;
    collectAnchorIds(obj[k], out);
  }
  return out;
}

function collectStepRoleIds(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectStepRoleIds(item, out);
    return out;
  }
  // The shape is `{ templates: [...], roles: [...] }` — only collect roleId
  // from inside `templates[].steps[].roleId`.
  const obj = value as Record<string, unknown>;
  if (obj.roleId && typeof obj.roleId === "string" && obj.prompt && typeof obj.prompt === "object") {
    out.push(obj.roleId);
  }
  for (const k of Object.keys(obj)) {
    collectStepRoleIds(obj[k], out);
  }
  return out;
}

/**
 * Parse the machine block from a config-doc text. The machine block is
 * the structured portable config (templates + roles) emitted by the
 * renderer as a fenced JSON object. Throws on:
 *  - missing or duplicate machine block markers
 *  - JSON parse failure inside the fence
 *  - prohibited keys (`__proto__`, `prototype`, `constructor`) — refuse to
 *    walk to prevent prototype pollution
 *  - `{__anchor}` ids not declared in the doc's anchors
 *  - step `roleId` not in `roles[].sourceId` (dangling wiring)
 *  - shape mismatches at the top level (not `{templates, roles}`)
 */
export function parsePortableConfig(text: string): PortableConfig {
  // Locate the machine region (exactly one)
  const openRe = new RegExp(escapeRegExp(MACHINE_OPEN), "g");
  const closeRe = new RegExp(escapeRegExp(MACHINE_CLOSE), "g");
  const openMatches = [...text.matchAll(openRe)];
  const closeMatches = [...text.matchAll(closeRe)];
  if (openMatches.length === 0) {
    throw new Error("config-doc: machine block missing (no <!-- adam:machine --> marker)");
  }
  if (openMatches.length > 1) {
    throw new Error(`config-doc: machine block has ${openMatches.length} open markers (expected 1)`);
  }
  if (closeMatches.length !== 1) {
    throw new Error(`config-doc: machine block has ${closeMatches.length} close markers (expected 1)`);
  }
  const openStart = openMatches[0].index!;
  const openEnd = openStart + openMatches[0][0].length;
  const closeStart = closeMatches[0].index!;
  const closeEnd = closeStart + closeMatches[0][0].length;
  if (closeStart <= openEnd) {
    throw new Error("config-doc: machine block close marker appears before open marker");
  }
  const interior = text.slice(openEnd, closeStart);
  const fenceRe = /```json\n([\s\S]*?)\n```/;
  const fenceMatch = fenceRe.exec(interior);
  if (!fenceMatch) {
    throw new Error("config-doc: machine block interior is not a single ```json fence");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenceMatch[1]);
  } catch (err) {
    throw new Error(
      `config-doc: machine block JSON parse failed: ${(err as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config-doc: machine block root must be a JSON object");
  }
  // Reject prototype-pollution keys
  rejectProhibitedKeys(parsed);

  // Shape-check the top level
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.templates) || !Array.isArray(obj.roles)) {
    throw new Error('config-doc: machine block top-level must have {templates: [], roles: []}');
  }

  // Validate anchor ids against the doc's actual anchorIds
  const headerDoc = parseConfigDoc(text);
  const anchorIds = new Set(headerDoc.anchorIds);
  const declaredAnchorRefs = collectAnchorIds(parsed);
  for (const ref of declaredAnchorRefs) {
    if (!anchorIds.has(ref)) {
      throw new Error(`config-doc: anchor "${ref}" not found in doc anchors`);
    }
  }

  // Validate every step's roleId against the doc's roles[].sourceId
  const roleIds = new Set<string>();
  for (const r of obj.roles) {
    if (r && typeof r === "object" && typeof (r as Record<string, unknown>).sourceId === "string") {
      roleIds.add((r as Record<string, unknown>).sourceId as string);
    }
  }
  const stepRoleIds = collectStepRoleIds(parsed);
  for (const stepRoleId of stepRoleIds) {
    if (!roleIds.has(stepRoleId)) {
      throw new Error(
        `config-doc: step roleId "${stepRoleId}" not in doc roles (dangling wiring)`,
      );
    }
  }

  return parsed as PortableConfig;
}

// ---------------------------------------------------------------------------
// Path validator
// ---------------------------------------------------------------------------

/**
 * Validate that `docPath` resolves inside the configured export dir.
 * Uses `realpathSync` to defeat `..` and symlink escape.
 *
 * Throws on:
 * - relative path
 * - path that does not exist
 * - path whose real path is outside the export dir
 *
 * This is the single path-validator used by every tool that reads a doc
 * (`read_config_doc`, `*Ref` params on `create_role` / `create_template`).
 */
export function assertDocPathInExportDir(docPath: string): string {
  if (!docPath || typeof docPath !== "string") {
    throw new Error("config-doc: docPath is required");
  }
  const abs = isAbsolute(docPath) ? docPath : resolve(docPath);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch (err) {
    throw new Error(
      `config-doc: cannot resolve docPath "${docPath}": ${(err as Error).message}`,
    );
  }
  // Compare against the resolved real export dir to defeat symlinks at the dir level too.
  let exportDirReal: string;
  try {
    exportDirReal = realpathSync(resolveExportDir());
  } catch {
    // Export dir does not exist yet — fall back to the configured (non-real) path,
    // but still require the absolute doc path to live under it.
    exportDirReal = resolve(EXPORT_DIR);
  }
  // Normalize both with trailing separator so prefix check is robust to "/foo/bar" vs "/foo/barbaz".
  const prefix = exportDirReal.endsWith("/") ? exportDirReal : exportDirReal + "/";
  if (real !== exportDirReal && !real.startsWith(prefix)) {
    throw new Error(
      `config-doc: docPath "${docPath}" resolves outside the export dir "${exportDirReal}"`,
    );
  }
  return real;
}

// ---------------------------------------------------------------------------
// Re-exports for tests
// ---------------------------------------------------------------------------

/** @internal — exported for parser.test.ts. */
export const __testing = {
  indexAnchors,
  parseHeaderYaml,
  extractHeader,
  sha256Hex,
};

// AnchorBlock is re-exported so callers can build a typed list of declared anchors
// without importing from types.ts.
export type { AnchorBlock };
