import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Directory names to exclude from workspace walks. Mirrors workspace-watcher.ts constants. */
export const EXCLUDE_DIRS: Set<string> = new Set([
  "node_modules",
  ".signals",
  ".cache",
  ".uv-cache",
  ".youtube-venv",
  ".git",
]);

/** File suffixes to exclude from workspace walks. Mirrors workspace-watcher.ts constants. */
export const EXCLUDE_FILE_SUFFIXES: string[] = [".log"];

export interface SnapshotEntry {
  mtime_ns: bigint;
  size: number;
  /** bigint because APFS inodes on long-lived systems can exceed Number.MAX_SAFE_INTEGER. */
  inode: bigint;
}

export interface DiffEntry {
  path: string;
  mtime_ns: bigint;
  size: number;
  inode: bigint;
}

/**
 * Compact tuple form used when persisting a snapshot into tasks.context_meta JSON.
 * Both mtime_ns and inode are bigints that need string-form on the wire
 * (JSON can't carry bigint; numbers above 2^53 lose precision).
 */
export type SnapshotTuple = [path: string, mtime_ns: string, size: number, inode: string];

/** Serialize a snapshot Map to compact tuple form for context_meta persistence. */
export function serializeTuples(snap: Map<string, SnapshotEntry>): SnapshotTuple[] {
  return Array.from(snap.entries()).map(([p, e]) => [p, e.mtime_ns.toString(), e.size, e.inode.toString()] as SnapshotTuple);
}

/** Deserialize compact tuple form back to Map<string, SnapshotEntry>. Throws on bad bigint strings. */
export function deserializeTuples(tuples: SnapshotTuple[]): Map<string, SnapshotEntry> {
  const m = new Map<string, SnapshotEntry>();
  for (const [p, mtime_ns_str, size, inode_str] of tuples) {
    m.set(p, { mtime_ns: BigInt(mtime_ns_str), size, inode: BigInt(inode_str) });
  }
  return m;
}

export interface SnapshotDiff {
  added: DiffEntry[];
  modified: DiffEntry[];
  deleted: string[];
}

/**
 * Walk `root` recursively, returning a Map from absolute path → SnapshotEntry.
 * Returns empty Map (no throw) if root is unreadable or does not exist.
 * Skips directories in EXCLUDE_DIRS and files ending with EXCLUDE_FILE_SUFFIXES.
 */
export async function snapshot(root: string): Promise<Map<string, SnapshotEntry>> {
  const result = new Map<string, SnapshotEntry>();

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (EXCLUDE_DIRS.has(entry.name)) return;
          await walk(fullPath);
        } else if (entry.isFile()) {
          if (EXCLUDE_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) return;
          try {
            const s = await stat(fullPath, { bigint: true });
            result.set(fullPath, {
              mtime_ns: s.mtimeNs,
              size: Number(s.size),
              inode: s.ino, // bigint — keep precision for APFS inodes > 2^53
            });
          } catch {
            // File disappeared between readdir and stat — skip silently.
          }
        }
      }),
    );
  }

  await walk(root);
  return result;
}

/**
 * Compute the diff between two snapshots.
 * - added: paths present in `after` but not in `before`
 * - modified: paths present in both but with different mtime_ns OR size
 * - deleted: paths present in `before` but not in `after`
 * Inode is captured in entries but NOT used for diff classification.
 */
export function diff(
  before: Map<string, SnapshotEntry>,
  after: Map<string, SnapshotEntry>,
): SnapshotDiff {
  const added: DiffEntry[] = [];
  const modified: DiffEntry[] = [];
  const deleted: string[] = [];

  for (const [path, afterEntry] of after) {
    const beforeEntry = before.get(path);
    if (!beforeEntry) {
      added.push({ path, ...afterEntry });
    } else if (afterEntry.mtime_ns !== beforeEntry.mtime_ns || afterEntry.size !== beforeEntry.size) {
      modified.push({ path, ...afterEntry });
    }
  }

  for (const path of before.keys()) {
    if (!after.has(path)) {
      deleted.push(path);
    }
  }

  return { added, modified, deleted };
}
