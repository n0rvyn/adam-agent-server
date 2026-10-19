import type { TokenCounter } from "./context-token-counter.js";
import type { ThreadBlock, GroupedTimeline } from "./context-thread-grouper.js";
import type { ChatMessage } from "../shared/types.js";
import { formatTime } from "./context-envelope-formatter.js";

/** A truncated free-conversation gap renders as a single synthetic line. */
export interface FreeConversationGap {
  kind: "gap";
  omittedCount: number;
}

/** Drop-summary for a thread fully removed by tier 3. */
export interface ThreadDropSummary {
  kind: "thread-drop";
  taskShortId: string;
  closedAt: string;
  resultSummary: string;
}

export type TruncatedFreeItem = ChatMessage | FreeConversationGap;

export interface RecentDeliveryContextItem {
  sourceId: string;
  deliveredAt: number;
  renderedPreview: string;
}

export interface TruncationOutput {
  freeConversation: TruncatedFreeItem[];
  threads: ThreadBlock[];
  droppedThreads: ThreadDropSummary[];
  recentDeliveries: RecentDeliveryContextItem[];
  omittedRecentDeliveryCount: number;
}

/**
 * Apply 3-tier truncation when estimated total exceeds budget.
 * Active threads are never compressed or dropped.
 */
export function applyTruncation(
  timeline: GroupedTimeline,
  tokenCounter: TokenCounter,
  budgetTokens: number,
  opts: { recentDeliveries?: RecentDeliveryContextItem[] } = {},
): TruncationOutput {
  // Initial mutable state
  const freeItems: TruncatedFreeItem[] = [...timeline.freeConversation];
  let threads: ThreadBlock[] = timeline.threads.map(t => ({ ...t, envelopes: [...t.envelopes] }));
  const dropped: ThreadDropSummary[] = [];
  const recentDeliveries = [...(opts.recentDeliveries ?? [])];
  let omittedRecentDeliveryCount = 0;

  const output = (): TruncationOutput => ({
    freeConversation: freeItems,
    threads,
    droppedThreads: dropped,
    recentDeliveries,
    omittedRecentDeliveryCount,
  });

  const overBudget = () => estimateTokens(freeItems, threads, recentDeliveries, tokenCounter) > budgetTokens;

  if (!overBudget()) {
    return output();
  }

  // Tier 1: drop intermediate status_report from closed threads
  for (const t of threads) {
    if (t.active) continue;
    t.envelopes = t.envelopes.filter((m, idx, arr) => {
      if (m.kind !== "status_report") return true;
      // Keep last status_report if no result_delivery exists (defensive)
      const hasResult = arr.some(x => x.kind === "result_delivery");
      if (!hasResult && idx === arr.length - 1) return true;
      return false;
    });
  }
  if (!overBudget()) return output();

  // Tier 2: compress free conversation middle (keep first 2 + last 5)
  if (freeItems.length > 7) {
    const head = freeItems.slice(0, 2);
    const tail = freeItems.slice(-5);
    const omitted = freeItems.length - 2 - 5;
    const gap: FreeConversationGap = { kind: "gap", omittedCount: omitted };
    freeItems.length = 0;
    freeItems.push(...head, gap, ...tail);
  }
  if (!overBudget()) return output();

  // Tier 3: drop oldest closed threads (one at a time, until fits or only active remain)
  while (overBudget()) {
    const oldestClosedIdx = threads.findIndex(t => !t.active);
    if (oldestClosedIdx === -1) break;
    const dropTarget = threads[oldestClosedIdx];
    const finalResult = [...dropTarget.envelopes].reverse().find(m => m.kind === "result_delivery");
    const closedAt = formatTime(dropTarget.envelopes[dropTarget.envelopes.length - 1].createdAt);
    dropped.push({
      kind: "thread-drop",
      taskShortId: dropTarget.taskShortId,
      closedAt,
      resultSummary: (finalResult?.content ?? "").slice(0, 80),
    });
    threads = threads.filter((_, i) => i !== oldestClosedIdx);
  }

  while (overBudget() && recentDeliveries.length > 0) {
    recentDeliveries.shift();
    omittedRecentDeliveryCount += 1;
  }

  return output();
}

/**
 * Estimate total tokens for the timeline body. Uses content lengths;
 * ignores per-line formatting overhead (which is small relative to content).
 */
function estimateTokens(
  freeItems: TruncatedFreeItem[],
  threads: ThreadBlock[],
  recentDeliveries: RecentDeliveryContextItem[],
  tokenCounter: TokenCounter,
): number {
  let total = 0;
  for (const item of freeItems) {
    if ("kind" in item && item.kind === "gap") continue;
    total += tokenCounter((item as ChatMessage).content);
  }
  for (const t of threads) {
    total += tokenCounter(t.brief);
    for (const m of t.envelopes) total += tokenCounter(m.content);
  }
  for (const item of recentDeliveries) {
    total += tokenCounter(item.renderedPreview);
  }
  return total;
}
