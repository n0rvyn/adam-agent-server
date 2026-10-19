import { watch } from "fs";
import { statSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, extname } from "path";
import { createHash } from "crypto";
import { RUNTIME_DIR } from "../../shared/constants.js";
import { publishEvent } from "../../lib/event-publish.js";
import { getLogger } from "../../lib/logger.js";
import type { EventDef } from "../../shared/types.js";

const log = getLogger("scheduler");

interface WatcherEntry {
  watcher: ReturnType<typeof watch>;
  stopped: boolean;
  stabilityTimer: ReturnType<typeof setTimeout> | null;
  pendingEvents: Map<string, { mtime: number; size: number }>;
}

/** Module-level map of active watchers keyed by def.id. */
const watchers = new Map<string, WatcherEntry>();

/**
 * Validate that the watch path starts with the user's home dir or RUNTIME_DIR.
 * Throws if validation fails.
 */
function validatePath(rawPath: string): void {
  let resolved: string;
  try {
    resolved = realpathSync(rawPath);
  } catch {
    throw new Error(`Watch path does not exist: ${rawPath}`);
  }
  const home = homedir();
  if (!resolved.startsWith(home) && !resolved.startsWith(RUNTIME_DIR)) {
    throw new Error(
      `Watch path must be within ${home} or ${RUNTIME_DIR}: ${rawPath}`,
    );
  }
}

/**
 * Start a directory-watch event source for a given event def.
 * Uses Node's fs.watch with a stability delay for debouncing.
 */
export function startDirectoryWatch(def: EventDef): void {
  if (!def.enabled) return;

  const config = def.sourceConfig as {
    path: string;
    glob?: string;
    stability_delay_ms?: number;
  };
  validatePath(config.path);

  const stabilityDelay = config.stability_delay_ms ?? 5000;
  const glob = config.glob;

  const entry: WatcherEntry = {
    watcher: null as unknown as ReturnType<typeof watch>,
    stopped: false,
    stabilityTimer: null,
    pendingEvents: new Map(),
  };

  const onEvent = (filename: string | null, eventType: string): void => {
    if (!filename || entry.stopped) return;
    if (glob && !matchGlob(filename, glob)) return;

    const filePath = join(config.path, filename);

    let size = 0;
    let mtime = Date.now();
    try {
      const s = statSync(filePath);
      size = s.size;
      mtime = s.mtimeMs;
    } catch {
      // File gone, skip
      return;
    }

    // Store pending event; restart stability timer
    entry.pendingEvents.set(filename, { mtime, size });

    if (entry.stabilityTimer) {
      clearTimeout(entry.stabilityTimer);
    }
    entry.stabilityTimer = setTimeout(() => {
      if (entry.stopped) return;
      for (const [f, meta] of entry.pendingEvents) {
        try {
          const fp = join(config.path, f);
          const eventId = createHash("sha256")
            .update(`dir-${def.id}-${fp}-${meta.mtime}`)
            .digest("hex")
            .slice(0, 16);
          publishEvent({
            id: eventId,
            eventDefId: def.id,
            type: "filesystem.file.created",
            source: `dir-${def.id}`,
            dedupKey: `dir-${def.id}-${fp}-${meta.mtime}`,
            payload: { file_path: fp, mtime: meta.mtime, size: meta.size },
            occurredAt: new Date(meta.mtime).toISOString(),
            trustLevel: "trusted",
          });
        } catch (err) {
          log.warn({ file: f, err }, "Failed to fire directory watch event");
        }
      }
      entry.pendingEvents.clear();
    }, stabilityDelay);
  };

  try {
    entry.watcher = watch(config.path, { persistent: false }, (eventType, filename) => {
      onEvent(filename, eventType);
    });
    entry.watcher.on("error", (err: Error) => {
      log.warn({ defId: def.id, err }, "fs.watch error, removing watcher");
      stopDirectoryWatch(def.id);
    });
    watchers.set(def.id, entry);
    log.info({ defId: def.id, defName: def.name, path: config.path }, "Directory watch started");
  } catch (err) {
    log.error({ defId: def.id, err }, "Failed to start directory watch");
    throw err;
  }
}

/**
 * Stop a directory-watch source for a given def id.
 */
export function stopDirectoryWatch(defId: string): void {
  const entry = watchers.get(defId);
  if (!entry) return;
  entry.stopped = true;
  if (entry.stabilityTimer) {
    clearTimeout(entry.stabilityTimer);
  }
  try {
    entry.watcher.close();
  } catch {
    // ignore close errors
  }
  watchers.delete(defId);
  log.info({ defId }, "Directory watch stopped");
}

/** Simple glob matcher for file extensions and patterns like "*.ts". */
function matchGlob(filename: string, glob: string): boolean {
  if (glob.startsWith("*.")) {
    const ext = glob.slice(1);
    return extname(filename) === ext;
  }
  return filename === glob;
}
