import { promises as fs } from "node:fs";
import type { ChatAttachment } from "../shared/types.js";

const TEXT_CLASS_MIME_RE = /^(text\/|application\/(json|yaml|markdown)$)/i;

export function isTextClassMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return TEXT_CLASS_MIME_RE.test(mime);
}

export const ATTACHMENT_EXCERPT_CHARS = 500;

/** Parses `local:///abs/path` → `/abs/path`. Returns null for non-local schemes. */
export function parseLocalPath(locator: string): string | null {
  const match = locator.match(/^local:\/\/[^/]*(\/.+)$/);
  return match ? match[1] : null;
}

/**
 * Resolve attachment excerpt for context rendering.
 * - If preview.excerpt present, truncate to ATTACHMENT_EXCERPT_CHARS and return.
 * - Else if MIME is text-class AND locator is `local://`, read first ~2KB and slice.
 * - Else return undefined (binary-class or non-local locator).
 *
 * IO failures are non-fatal: returns undefined and the renderer falls back to
 * metadata-only rendering. Caller passes `readFile` injection for tests.
 */
export async function resolveAttachmentExcerpt(
  attachment: ChatAttachment,
  readFile: (path: string, opts: { encoding: BufferEncoding; bytes?: number }) => Promise<string> = defaultReadFile,
): Promise<string | undefined> {
  const pre = attachment.preview?.excerpt;
  if (pre) return pre.length > ATTACHMENT_EXCERPT_CHARS ? pre.slice(0, ATTACHMENT_EXCERPT_CHARS) : pre;

  if (!isTextClassMime(attachment.mimeType)) return undefined;
  const path = parseLocalPath(attachment.locator);
  if (!path) return undefined;

  try {
    const text = await readFile(path, { encoding: "utf8", bytes: ATTACHMENT_EXCERPT_CHARS * 4 });
    return text.length > ATTACHMENT_EXCERPT_CHARS ? text.slice(0, ATTACHMENT_EXCERPT_CHARS) : text;
  } catch {
    return undefined;
  }
}

async function defaultReadFile(
  path: string,
  opts: { encoding: BufferEncoding; bytes?: number },
): Promise<string> {
  if (opts.bytes === undefined) {
    return fs.readFile(path, opts.encoding);
  }
  // Bounded read: open and read first N bytes only.
  const handle = await fs.open(path, "r");
  try {
    const buf = Buffer.alloc(opts.bytes);
    const { bytesRead } = await handle.read(buf, 0, opts.bytes, 0);
    return buf.subarray(0, bytesRead).toString(opts.encoding);
  } finally {
    await handle.close();
  }
}
