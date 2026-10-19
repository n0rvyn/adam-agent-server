import type { ChatMessageInfo } from "@/store/useChatStore.ts";

const ROLE_COLOR_TOKENS = [
  "var(--app-log-adam)",
  "var(--app-log-manager)",
  "var(--app-log-scheduler)",
  "var(--app-log-ws)",
  "var(--app-log-store)",
  "var(--app-log-embedding)",
] as const;

/** Stable djb2 hash → fixed-palette index. Same roleId always → same color. */
export function roleColorToken(roleId: string | undefined): string {
  if (!roleId) return "var(--app-text-subtle)";
  let hash = 5381;
  for (let i = 0; i < roleId.length; i++) {
    hash = ((hash << 5) + hash) ^ roleId.charCodeAt(i);
  }
  return ROLE_COLOR_TOKENS[Math.abs(hash) % ROLE_COLOR_TOKENS.length];
}

/** taskId UUID first 8 chars uppercase → "T-XXXXXXXX". */
export function taskShortId(taskId: string | undefined): string {
  if (!taskId) return "";
  return `T-${taskId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

/**
 * Group consecutive status_report envelopes inside a thread (D-004).
 * Returns segments: a status_report run with N >= 3 collapses to one group;
 * otherwise stays as individual entries.
 */
export type ThreadSegment =
  | { type: "single"; message: ChatMessageInfo }
  | { type: "status-group"; messages: ChatMessageInfo[] };

export function groupConsecutiveStatusReports(
  messages: ChatMessageInfo[],
  threshold = 3,
): ThreadSegment[] {
  const segments: ThreadSegment[] = [];
  let buffer: ChatMessageInfo[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    if (buffer.length >= threshold) {
      segments.push({ type: "status-group", messages: buffer });
    } else {
      for (const m of buffer) segments.push({ type: "single", message: m });
    }
    buffer = [];
  };
  for (const m of messages) {
    if (m.kind === "status_report") {
      buffer.push(m);
    } else {
      flush();
      segments.push({ type: "single", message: m });
    }
  }
  flush();
  return segments;
}

/**
 * Group messages by threadRoot. Messages without threadRoot go to "free" bucket.
 * Returns ordered list: { threadRoot: null, messages: [...] } first (free conversation),
 * then one entry per distinct threadRoot ordered by first-appearance time.
 */
export interface ThreadBucket {
  threadRoot: string | null;
  messages: ChatMessageInfo[];
}

export function groupByThread(messages: ChatMessageInfo[]): ThreadBucket[] {
  const free: ChatMessageInfo[] = [];
  const threadMap = new Map<string, ChatMessageInfo[]>();
  const threadOrder: string[] = [];
  for (const m of messages) {
    if (!m.threadRoot) {
      free.push(m);
      continue;
    }
    if (!threadMap.has(m.threadRoot)) {
      threadMap.set(m.threadRoot, []);
      threadOrder.push(m.threadRoot);
    }
    threadMap.get(m.threadRoot)!.push(m);
  }
  const result: ThreadBucket[] = [{ threadRoot: null, messages: free }];
  for (const tr of threadOrder) {
    result.push({ threadRoot: tr, messages: threadMap.get(tr)! });
  }
  return result;
}
