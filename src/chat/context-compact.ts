import { callClaudeForEvaluation } from "../lib/llm-eval.js";
import { createMemory } from "../store/memories.js";
import { getDb } from "../store/db.js";
import { getLogger } from "../lib/logger.js";
import { getRuntimeConfig } from "../config/runtime.js";
import type { ThreadDropSummary } from "./context-truncation.js";
import type { MemoryNode } from "../shared/types.js";

const log = getLogger("context-compact");

/** Debounce window: don't re-trigger app_compact within 30 minutes per session. */
const DEBOUNCE_WINDOW_MS = 30 * 60 * 1000;

/** Summary length cap (matches PostCompact hook: hooks.ts:652 `summary.slice(0, 5000)`). */
const SUMMARY_CHAR_CAP = 5000;

const COMPACT_SYSTEM_PROMPT = "You summarize a chronological conversation extract. Output ONE concise paragraph (≤ 500 words) capturing: key decisions, constraints introduced, unresolved questions. Do not invent details not present in the source. No preamble.";

/**
 * Application-layer compaction: when buildSessionContext drops whole threads
 * (tier-3 truncation), summarize the dropped content and persist as a
 * working-tier memory so that future buildSessionContext can recall the
 * gist via queryMemoryByTier.
 *
 * Background-fire-and-forget: callers `void` the returned promise.
 * Failure is logged and swallowed — main chat flow must not be affected.
 *
 * Debounce: skipped if any app_compact memory for role-chat-manager
 * exists with created_at within the last 30 minutes.
 *
 * @param sessionId chat session id (for log correlation; not stored on memory)
 * @param droppedThreads thread drop summaries from applyTruncation
 */
export async function triggerAppCompact(
  sessionId: string,
  droppedThreads: ThreadDropSummary[],
): Promise<void> {
  if (droppedThreads.length === 0) return;

  try {
    if (isDebounced()) {
      log.debug({ sessionId, droppedCount: droppedThreads.length }, "App-compact debounced");
      return;
    }

    const sourceText = renderDroppedThreads(droppedThreads);
    if (!sourceText.trim()) return;

    const model = getCompactModel();
    const summary = await callClaudeForEvaluation(sourceText, {
      systemPrompt: COMPACT_SYSTEM_PROMPT,
      model,
      maxBudgetUsd: 0.02,
      maxTurns: 1,
    });

    if (!summary || summary.trim().length === 0) {
      log.debug({ sessionId }, "App-compact returned empty summary; skipping memory write");
      return;
    }

    const memory: MemoryNode = {
      id: `app-compact-${Date.now()}`,
      roleId: "role-chat-manager",
      type: "thought",
      content: summary.slice(0, SUMMARY_CHAR_CAP),
      keywords: ["compaction", "context", "decisions"],
      importance: 4,
      sourceType: "app_compact",
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      retrievedCount: 0,
      tier: "working",
    };
    createMemory(memory);
    log.info({ sessionId, memoryId: memory.id, droppedCount: droppedThreads.length }, "App-compact memory created");
  } catch (err) {
    log.warn({ err, sessionId }, "App-compact failed (non-fatal)");
  }
}

/** Returns true if an app_compact memory exists within DEBOUNCE_WINDOW_MS. */
function isDebounced(): boolean {
  try {
    const cutoff = Date.now() - DEBOUNCE_WINDOW_MS;
    const row = getDb().prepare(
      `SELECT 1 FROM memories WHERE role_id = ? AND source_type = ? AND created_at >= ? LIMIT 1`,
    ).get("role-chat-manager", "app_compact", cutoff);
    return !!row;
  } catch {
    // If debounce check fails, err on the side of NOT compacting (avoids spam)
    return true;
  }
}

function renderDroppedThreads(threads: ThreadDropSummary[]): string {
  return threads
    .map((t) => `[Thread ${t.taskShortId} closed @ ${t.closedAt}]\n${t.resultSummary}`)
    .join("\n\n---\n\n");
}

/** Resolve compact model — prefer config-defined small/fast model, fall back to project default. */
function getCompactModel(): string | undefined {
  const cfg = getRuntimeConfig();
  return cfg.anthropic?.smallFastModel || cfg.defaults?.model || undefined;
}
