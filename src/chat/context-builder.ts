import { getAllMessagesBySession, getRecentMessages, getMessage } from "../store/messages.js";
import { listOpenPromptsBySession, getPendingPrompt } from "../store/pending-prompts.js";
import { queryMemoryByTier } from "../agent/memory-service.js";
import { getChatConfig } from "../config/index.js";
import { groupEnvelopesByThread, type ThreadBlock } from "./context-thread-grouper.js";
import { applyTruncation, type TruncatedFreeItem, type ThreadDropSummary } from "./context-truncation.js";
import { heuristicTokenCounter, type TokenCounter } from "./context-token-counter.js";
import { resolveAttachmentExcerpt } from "./context-attachment-resolver.js";
import { triggerAppCompact } from "./context-compact.js";
import { getRecentDeliveryContextItems, renderRecentDeliveryContext } from "./recent-delivery-context.js";
import {
  formatTime,
  formatEnvelopeBracket,
  formatMirrorSuffix,
  formatAttachmentBlock,
} from "./context-envelope-formatter.js";
import type { ChatMessage, ChatAttachment, PromptResolvedVia } from "../shared/types.js";

export interface BuildSessionContextOptions {
  tokenCounter?: TokenCounter;
  readAttachmentExcerpt?: (attachment: ChatAttachment) => Promise<string | undefined>;
  /** Render-time lookup of pending_prompts.resolved_via for user_message bracket; default reads from store. */
  getResolvedVia?: (promptId: string) => PromptResolvedVia | undefined;
  currentMessageAt?: number;
  /**
   * Context mode (Task 6-impl — seed/delta split, DP-002=A):
   * - 'seed': compact recap + top-K memories + open prompts. Injected once at session create
   *   via push({shouldQuery:false}) so the live process has an "impression" of prior context.
   * - 'delta': open prompts + recent deliveries + fresh memories ONLY — NO conversation re-dump.
   *   Prepended to each user turn (shouldQuery:true).
   * - undefined (default): legacy full context (current behavior, used by existing callers).
   */
  mode?: 'seed' | 'delta';
}

export async function buildSessionContext(
  sessionId: string,
  currentMessage: string,
  options: BuildSessionContextOptions = {},
): Promise<string> {
  const config = getChatConfig();
  const tokenCounter = options.tokenCounter ?? heuristicTokenCounter;
  const readExcerpt = options.readAttachmentExcerpt ?? ((a: ChatAttachment) => resolveAttachmentExcerpt(a));
  const getResolvedVia = options.getResolvedVia ?? defaultGetResolvedVia;

  const { mode } = options;

  // ── Seed mode: bounded conversation replay + top-K memories + open prompts ───
  // Folded into the FIRST turn of every cold LiveSession. Streaming-mode SDK sessions are
  // NOT resumable from disk, so this replay (from chat_messages) is the cross-restart
  // continuity mechanism — it re-dumps the recent conversation precisely because there is no
  // working SDK resume to restore it.
  if (mode === "seed") {
    return buildSeedContext(sessionId, currentMessage, options, config, readExcerpt, tokenCounter, getResolvedVia);
  }

  // ── Delta mode: open prompts + recent deliveries + fresh memories only ────────
  // Prepended to each user turn. The live in-memory transcript already contains
  // the conversation; repeating it would inflate context unnecessarily.
  if (mode === "delta") {
    return buildDeltaContext(sessionId, currentMessage, options);
  }

  // ── Legacy (no mode): full context — existing behavior preserved ──────────────
  const allMessages = getAllMessagesBySession(sessionId);
  const grouped = groupEnvelopesByThread(allMessages);
  const recentDeliveryItems = getRecentDeliveryContextItems(sessionId, currentMessage, {
    currentMessageAt: options.currentMessageAt,
  });
  const truncated = applyTruncation(grouped, tokenCounter, config.contextBudgetTokens, {
    recentDeliveries: recentDeliveryItems,
  });

  // Fire-and-forget app-layer compact when tier-3 truncation dropped whole threads.
  // This path is retained for the legacy (no-mode) callers only; seed/delta modes rely
  // on SDK auto-compact (persistSession:true restored in Task 5-impl).
  // Note: triggerAppCompact is only called here; if all callers migrate to seed/delta it becomes dead.
  if (truncated.droppedThreads.length > 0) {
    void triggerAppCompact(sessionId, truncated.droppedThreads);
  }

  const sections: string[] = [];

  // [Session metadata] — always emitted in legacy mode
  const totalEnvelopes = truncated.freeConversation.filter(it => !("kind" in it && it.kind === "gap")).length
    + truncated.threads.reduce((n, t) => n + t.envelopes.length, 0);
  sections.push(
    `[Session metadata]\nsession_id: ${sessionId}\nrecent_window: last ${totalEnvelopes} envelopes within ${config.contextBudgetTokens} tokens`,
  );

  // [Free conversation]
  if (truncated.freeConversation.length > 0) {
    sections.push(`[Free conversation]\n${await renderFreeConversation(truncated.freeConversation, readExcerpt, getResolvedVia)}`);
  }

  // Thread blocks
  for (const t of truncated.threads) {
    sections.push(await renderThreadBlock(t, readExcerpt, getResolvedVia));
  }

  // Tier 3 drop summaries (after live threads)
  for (const drop of truncated.droppedThreads) {
    sections.push(`[Thread ${drop.taskShortId} closed @ ${drop.closedAt}: ${drop.resultSummary}]`);
  }

  // [Open prompts] — always emitted
  sections.push(renderOpenPrompts(sessionId));

  const recentDeliverySection = renderRecentDeliveryContext(
    truncated.recentDeliveries,
    truncated.omittedRecentDeliveryCount,
  );
  if (recentDeliverySection) {
    sections.push(recentDeliverySection);
  }

  // [Relevant memories] — keep prior behavior
  try {
    const memories = await queryMemoryByTier(undefined, currentMessage, ["semantic", "working"], { topK: 5 });
    if (memories.length > 0) {
      sections.push(`[Relevant memories — from Memory system]\n${memories.map(m => `Memory [${m.tier ?? "episodic"}]: ${m.content} (importance: ${m.importance})`).join("\n")}`);
    }
  } catch {
    // non-fatal
  }

  // [Current message] — always last
  sections.push(`[Current message]\nUser: ${currentMessage}`);

  return sections.join("\n\n");
}

/**
 * Build the seed context: a bounded REPLAY of this session's prior conversation (from
 * chat_messages) + top-K memories + open prompts. Folded into the first turn of every cold
 * LiveSession.
 *
 * Why a full replay (not a thin recap): streaming-input SDK sessions are not persisted as
 * resumable transcripts on disk, so `--resume` cannot restore the conversation after a
 * restart/eviction. This replay is therefore the ONLY thing that gives a freshly-spawned
 * subprocess memory of earlier turns. Bounded by config.contextBudgetTokens via the same
 * truncation the legacy full-context path uses, so long sessions don't blow up turn 1.
 */
async function buildSeedContext(
  sessionId: string,
  currentMessage: string,
  options: BuildSessionContextOptions,
  config: ReturnType<typeof getChatConfig>,
  readExcerpt: (a: ChatAttachment) => Promise<string | undefined>,
  tokenCounter: TokenCounter,
  getResolvedVia: (promptId: string) => PromptResolvedVia | undefined,
): Promise<string> {
  const sections: string[] = [];

  // [前情提要] — bounded replay of the prior conversation.
  const allMessages = getAllMessagesBySession(sessionId);
  if (allMessages.length > 0) {
    const grouped = groupEnvelopesByThread(allMessages);
    const truncated = applyTruncation(grouped, tokenCounter, config.contextBudgetTokens, {
      recentDeliveries: [],
    });
    const replayParts: string[] = [];
    if (truncated.freeConversation.length > 0) {
      replayParts.push(await renderFreeConversation(truncated.freeConversation, readExcerpt, getResolvedVia));
    }
    for (const t of truncated.threads) {
      replayParts.push(await renderThreadBlock(t, readExcerpt, getResolvedVia));
    }
    for (const drop of truncated.droppedThreads) {
      replayParts.push(`[Thread ${drop.taskShortId} closed @ ${drop.closedAt}: ${drop.resultSummary}]`);
    }
    const replayBody = replayParts.join("\n").trim() || "(no renderable prior turns)";
    sections.push(`[前情提要]\nsession_id: ${sessionId}\nreplay of ${allMessages.length} prior messages (bounded to ${config.contextBudgetTokens} tokens)\n${replayBody}`);
  } else {
    sections.push(`[前情提要]\nsession_id: ${sessionId}\n(no prior messages in this session)`);
  }

  // [Open prompts] — carry continuity for unanswered prompts
  sections.push(renderOpenPrompts(sessionId));

  // [Relevant memories — top-K semantic/working tier]
  try {
    const memories = await queryMemoryByTier(undefined, currentMessage, ["semantic", "working"], { topK: 5 });
    if (memories.length > 0) {
      sections.push(`[Relevant memories — from Memory system]\n${memories.map(m => `Memory [${m.tier ?? "episodic"}]: ${m.content} (importance: ${m.importance})`).join("\n")}`);
    }
  } catch {
    // non-fatal
  }

  return sections.join("\n\n");
}

/**
 * Build the delta context: per-turn non-transcript context.
 * Includes only: open prompts + recent deliveries + fresh memories.
 * Deliberately EXCLUDES [Free conversation], [Session metadata], and thread dumps —
 * the live SDK process already holds those in-memory.
 */
async function buildDeltaContext(
  sessionId: string,
  currentMessage: string,
  options: BuildSessionContextOptions,
): Promise<string> {
  const sections: string[] = [];

  // [Open prompts] — always included per turn so model tracks open decisions
  sections.push(renderOpenPrompts(sessionId));

  // [Recent deliveries] — what just happened (new deliveries since last turn)
  const recentDeliveryItems = getRecentDeliveryContextItems(sessionId, currentMessage, {
    currentMessageAt: options.currentMessageAt,
  });
  const recentDeliverySection = renderRecentDeliveryContext(recentDeliveryItems, 0);
  if (recentDeliverySection) {
    sections.push(recentDeliverySection);
  }

  // [Relevant memories] — fresh per-turn recall
  try {
    const memories = await queryMemoryByTier(undefined, currentMessage, ["semantic", "working"], { topK: 5 });
    if (memories.length > 0) {
      sections.push(`[Relevant memories — from Memory system]\n${memories.map(m => `Memory [${m.tier ?? "episodic"}]: ${m.content} (importance: ${m.importance})`).join("\n")}`);
    }
  } catch {
    // non-fatal
  }

  return sections.join("\n\n");
}

async function renderFreeConversation(
  items: TruncatedFreeItem[],
  readExcerpt: (a: ChatAttachment) => Promise<string | undefined>,
  getResolvedVia: (promptId: string) => PromptResolvedVia | undefined,
): Promise<string> {
  const lines: string[] = [];
  for (const it of items) {
    if ("kind" in it && it.kind === "gap") {
      lines.push(`[... ${it.omittedCount} earlier turns omitted ...]`);
      continue;
    }
    lines.push(...await renderEnvelopeLines(it as ChatMessage, readExcerpt, getResolvedVia));
  }
  return lines.join("\n");
}

async function renderThreadBlock(
  t: ThreadBlock,
  readExcerpt: (a: ChatAttachment) => Promise<string | undefined>,
  getResolvedVia: (promptId: string) => PromptResolvedVia | undefined,
): Promise<string> {
  const header = `[Thread ${t.taskShortId} / ${t.roleName} / ${t.brief}]`;
  const lines = [header];
  for (const m of t.envelopes) {
    lines.push(...await renderEnvelopeLines(m, readExcerpt, getResolvedVia));
  }
  return lines.join("\n");
}

/**
 * Render envelope lines per design doc §"Session context" lines 263-280:
 *   - HH:MM [bracket] content
 *     attachments:
 *       [file: ...]
 *         excerpt: "..."
 *     (also delivered to: ... @ HH:MM)   ← mirror suffix on its own indented line, AFTER attachments
 */
async function renderEnvelopeLines(
  m: ChatMessage,
  readExcerpt: (a: ChatAttachment) => Promise<string | undefined>,
  getResolvedVia: (promptId: string) => PromptResolvedVia | undefined,
): Promise<string[]> {
  const time = formatTime(m.createdAt);
  const resolvedVia = m.promptId ? getResolvedVia(m.promptId) : undefined;
  const bracket = formatEnvelopeBracket(m, resolvedVia);
  const lines: string[] = [`- ${time} ${bracket} ${m.content}`];
  if (m.attachments && m.attachments.length > 0) {
    lines.push("  attachments:");
    for (const att of m.attachments) {
      const excerpt = await readExcerpt(att);
      lines.push(formatAttachmentBlock(att, excerpt));
    }
  }
  // Mirror suffix line (after attachments block) — design lines 270-274
  if (m.mirroredToTargets && m.mirroredToTargets.length > 0) {
    const suffix = formatMirrorSuffix(m.mirroredToTargets, time);
    if (suffix) lines.push(`   ${suffix}`);
  }
  return lines;
}

function defaultGetResolvedVia(promptId: string): PromptResolvedVia | undefined {
  try {
    return getPendingPrompt(promptId)?.resolvedVia;
  } catch {
    return undefined;
  }
}

function renderOpenPrompts(sessionId: string): string {
  const prompts = listOpenPromptsBySession(sessionId);
  if (prompts.length === 0) return "[Open prompts]\n(none)";
  const now = Date.now();
  const lines = prompts.map(p => {
    const originating = getMessage(p.messageId);
    const excerpt = (originating?.content ?? "").slice(0, 50);
    const sinceMs = Math.max(0, now - p.askedAt);
    const sinceMin = Math.round(sinceMs / 60_000);
    const ago = sinceMin >= 60 ? `${Math.round(sinceMin / 60)}h` : `${sinceMin}m`;
    return `- #${p.id} (${p.shape}) — "${excerpt}" (${ago} ago)`;
  });
  return `[Open prompts]\n${lines.join("\n")}`;
}

// Preserve existing exports for back-compat callers (none found in current grep, kept for safety).
function formatTurns(messages: { role: string; content: string }[]): string {
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
}

function formatMemories(memories: { content: string; importance: number; tier?: string }[]): string {
  return memories
    .map((m) => `Memory [${m.tier ?? "episodic"}]: ${m.content} (importance: ${m.importance})`)
    .join("\n");
}

export function getSessionContextOnly(sessionId: string, turnCount?: number): string {
  const config = getChatConfig();
  const messages = getRecentMessages(sessionId, turnCount ?? config.maxSessionTurns);
  return formatTurns(messages);
}

export async function getMemoryContextOnly(
  prompt: string,
  roleId?: string,
  topK = 5,
): Promise<string> {
  // Dynamic import to avoid circular dep on queryMemory (not exported from memory-service.js)
  const { queryMemory } = await import("../agent/memory-service.js");
  const memories = await queryMemory(roleId, prompt, { topK });
  return formatMemories(memories);
}
