import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { LiveSession } from "./live-session.js";
import { resolveTierModel } from "./effort-tier-resolver.js";
import { v4 as uuidv4 } from "uuid";
import { createAdamTools } from "./adam-tools.js";
import { buildCanUseTool, buildSessionHooks } from "./hooks.js";
import { buildChatSystemPrompt } from "./chat-system-prompt.js";
import { buildSessionContext } from "../chat/context-builder.js";
import { serverBus } from "../server/events/server-bus.js";
import { updateGoal, getGoal } from "../store/goals.js";
import { getTask, updateTask, listTasksByParent, incrementRetryCount, createDelayedRetry, getDueDelayedRetries, deleteDelayedRetry, deleteDelayedRetryByTaskId } from "../store/tasks.js";
import { RUNTIME_DIR } from "../shared/constants.js";
import { getLogger } from "../lib/logger.js";
import { createMessage } from "../store/messages.js";
import { getRole } from "../store/roles.js";
import { CHAT_MANAGER_ROLE_ID } from "../store/role-presets.js";
import * as sessionManager from "../chat/session-manager.js";
import { listOpenPromptsByTask, expirePendingPrompt } from "../store/pending-prompts.js";
import { getDb } from "../store/db.js";
import type { Goal, GoalStatus, ChatMessage, ChatSource, ChatEnvelopeKind, ChatAttachment, DeliveryTarget, OutboundAttachment, ChatManagerResponse, CapturedDispatch } from "../shared/types.js";
import { getOutboundGateway } from "../delivery/outbound-gateway.js";
import { createReportArtifact } from "../chat/artifact-helper.js";
import { chatAttachmentToOutbound } from "../chat/attachment-converter.js";
import { resolveDeliverableArtifacts } from "../chat/deliverable-resolver.js";
import { sendCommittedAttachmentFanout } from "../delivery/attachment-fanout.js";
import { buildSdkEnv, getRuntimeConfig } from "../config/runtime.js";
import { withTrace, getCurrentTraceId } from "../lib/trace-context.js";
import { getTaskTraceId } from "../store/tasks.js";
import { createTaskWithAdmission } from "../lib/task-dispatch.js";
import type { ErrorCategory, ClassifiedError } from "../lib/error-classifier.js";
import { isTemplateExecutionStepTask } from "../lib/template-execution-task.js";
import { auditDeliveryClaims } from "../audit/delivery-claim-auditor.js";
import { auditClaimsForTurn } from "../audit/claim-receipt-auditor.js";
import { writeDivergenceLog } from "../store/auditor-divergence.js";
import {
  findPendingDeliveryCommitmentsForTask,
  markDeliveryCommitmentFailed,
  markDeliveryCommitmentFulfilled,
} from "../store/assistant-delivery-commitments.js";
import { getChannel } from "../store/channels.js";

const log = getLogger("chat-manager");
const MANAGER_WORKSPACE = RUNTIME_DIR;

export class ChatManager {
  private running = false;
  private lastActivityAt: number = Date.now();
  private consecutiveStaleCount = 0;
  private subscribed = false;
  private cachedCanUseTool: ReturnType<typeof buildCanUseTool> | undefined;
  private delayedRetryPollInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Map of active live sessions keyed by chat session ID.
   * Each LiveSession owns one long-lived streaming query process.
   * Task 5-impl: replaces the former single-threaded messageQueue/processQueue/runQuery path.
   */
  private liveSessionMap = new Map<string, LiveSession>();

  /**
   * LRU order for concurrency cap enforcement (DP-001=A, cap=3, evict-LRU).
   * Tracks insertion/access order of session IDs; front = least recently used.
   */
  private lruOrder: string[] = [];

  /**
   * Per-session idle eviction timers.
   * Key = chatSessionId; value = setTimeout handle.
   * Cleared on activity, fires LiveSession.end() after liveSessionIdleMinutes.
   */
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Map taskId → { chatSessionId, source } for routing task results back.
   * Populated when dispatch_to_role or dispatch_by_requirements is called during chat message processing.
   * TTL: entries cleaned up after delivery or after 24 hours.
   */
  private taskOriginMap = new Map<string, { chatSessionId: string; source: ChatSource; createdAt: number }>();

  constructor() {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.subscribeToEvents();
    this.startDelayedRetryPolling();
    // canUseTool is origin-independent; build once at start() and reuse across turns.
    this.cachedCanUseTool = buildCanUseTool((_roleId: string) => ({
      disallowedTools: ["WebSearch", "WebFetch", "Bash", "Edit", "Write", "NotebookEdit"],
    }));
    // Warm bootstrap is deferred to the first getOrCreateLiveSession() call (Task5-impl step 6).
    // This avoids spawning a process before the first real session is known.
    log.info("ChatManager started");
  }

  stop(): void {
    this.running = false;
    if (this.delayedRetryPollInterval) {
      clearInterval(this.delayedRetryPollInterval);
      this.delayedRetryPollInterval = null;
    }
    // Close all live sessions on shutdown (Threat model: Signal/shutdown path).
    for (const [sessionId, liveSession] of this.liveSessionMap) {
      this._clearIdleTimer(sessionId);
      try { liveSession.end(); } catch (err) { log.debug({ err, sessionId }, "LiveSession.end() failed during stop"); }
    }
    this.liveSessionMap.clear();
    this.lruOrder = [];
    this.idleTimers.clear();
    log.info("ChatManager stopped");
  }

  /**
   * Handle a user message directly. Returns the assistant's response.
   * Messages are queued and processed sequentially (D-005: single session).
   *
   * @param chatSessionId — the chat session this message belongs to (for result routing)
   * @param source — the ChatSource (web/tui/channel) for delivery routing
   */
  async handleMessage(content: string, chatSessionId?: string, source?: ChatSource): Promise<string> {
    const response = await this.handleMessageWithDispatches(content, chatSessionId, source);
    return response.text;
  }

  async handleMessageWithDispatches(content: string, chatSessionId?: string, source?: ChatSource): Promise<ChatManagerResponse> {
    const traceId = getCurrentTraceId();

    const doTurn = async (): Promise<ChatManagerResponse> => {
      const liveSession = chatSessionId
        ? await this.getOrCreateLiveSession(chatSessionId, source)
        : await this.getOrCreateAnonymousLiveSession(source);

      // Clear per-session dispatches before this turn so we snapshot only this turn's dispatches
      liveSession.dispatches.length = 0;

      // Inject per-turn DELTA context (open prompts / recent deliveries / memories relevant
      // to THIS message) alongside the user content. The live transcript carries the
      // conversation; delta carries the non-transcript state that changed since session start
      // + dynamic memory recall. Non-fatal: fall back to raw content on failure.
      let enriched = content;
      if (chatSessionId) {
        try {
          const delta = await buildSessionContext(chatSessionId, content, { mode: "delta" });
          if (delta && delta.trim()) {
            enriched = `${delta}\n\n[Current message]\n${content}`;
          }
        } catch (err) {
          log.debug({ err, chatSessionId }, "ChatManager: delta context injection failed (non-fatal)");
        }
      }

      const result = await liveSession.push(enriched, traceId);

      // Persist the SDK session id for resume across restarts (Task 5-impl step 4)
      if (result.sdkSessionId && chatSessionId) {
        sessionManager.updateSessionSdkId(chatSessionId, result.sdkSessionId);
      }
      this.lastActivityAt = Date.now();
      this.consecutiveStaleCount = 0;

      // Reset idle timer after turn completes (session is now active again)
      if (chatSessionId) {
        this._touchLru(chatSessionId);
        const ls = this.liveSessionMap.get(chatSessionId);
        if (ls) this._resetIdleTimer(chatSessionId, ls);
      }

      const response: ChatManagerResponse = {
        text: result.text,
        traceId,
        dispatches: [...liveSession.dispatches],
        timedOut: false,
        cost: result.cost,
        numTurns: result.numTurns,
      };

      // Chat-only: if the turn ended abnormally with no content, surface a visible notice.
      if (!response.text?.trim()) {
        return { ...response, text: "⚠️ 处理超时,本条消息未能完成。请重新发送。", timedOut: true };
      }
      return response;
    };

    if (traceId) {
      return withTrace(traceId, "chat", doTurn);
    }
    return doTurn();
  }

  /**
   * Builds the system prompt for a ChatManager query, including stored CAG addendum.
   * Exported for unit testing — call this instead of the private runQuery when
   * testing prompt construction without triggering SDK calls.
   */
  buildChatManagerPrompt(): string {
    const chatManagerRole = getRole(CHAT_MANAGER_ROLE_ID);
    return buildChatSystemPrompt({
      currentTime: Date.now(),
      storedCagPrompt: chatManagerRole?.cagPrompt,
    });
  }

  private buildSharedOptions(
    systemPrompt: string,
    adamToolsInstance: ReturnType<typeof createAdamTools> | null,
    cachedHooks: ReturnType<typeof buildSessionHooks> | undefined,
  ): Record<string, unknown> {
    // Resolve the ChatManager Role's model the same way ExecutionManager resolves a task's
    // (effort-tier-resolver). Without this, ChatManager silently ran on ANTHROPIC_MODEL and the
    // Chat Manager Role's model/effortTier config was dead. Now: role.effortTier → tier model,
    // or role.model (explicit) → used as-is; unset → undefined → SDK falls back to ANTHROPIC_MODEL.
    const resolvedModel = resolveTierModel(undefined, getRole(CHAT_MANAGER_ROLE_ID));
    return {
      cwd: MANAGER_WORKSPACE,
      additionalDirectories: [process.cwd()],
      systemPrompt,
      maxTurns: 50,
      maxBudgetUsd: getRuntimeConfig().defaults.maxBudgetUsd,
      disallowedTools: ["WebSearch", "WebFetch", "Bash", "Edit", "Write", "NotebookEdit"],
      settingSources: ["project"] as const,
      persistSession: true,
      includePartialMessages: true,
      ...(resolvedModel.model ? { model: resolvedModel.model } : {}),
      ...(resolvedModel.fallbackModel ? { fallbackModel: resolvedModel.fallbackModel } : {}),
      mcpServers: { "adam-tools": adamToolsInstance },
      hooks: cachedHooks,
      canUseTool: this.cachedCanUseTool,
      env: {
        ...buildSdkEnv(),
        ANTHROPIC_SMALL_FAST_MODEL: getRuntimeConfig().anthropic?.smallFastModel
          || process.env.ANTHROPIC_MODEL || "",
      },
      stderr: (data: string) => {
        if (data.trim()) log.debug({ stderr: data.trim().slice(0, 500) }, "ChatManager SDK stderr");
      },
    };
  }

  /**
   * Pair a fresh per-session AbortController with the query() options it must be wired into.
   * The SAME controller goes into both the SDK options and the LiveSession, so the session's
   * inactivity-timeout teardown can kill the live subprocess. Both LiveSession creation paths
   * use this so neither can forget the wiring.
   */
  private buildSessionQueryOptions(
    sharedOptions: Record<string, unknown>,
  ): { abortController: AbortController; queryOptions: Record<string, unknown> } {
    const abortController = new AbortController();
    return { abortController, queryOptions: { ...sharedOptions, abortController } };
  }

  /**
   * Build per-session adam-tools + hooks instances, each closing over the constant
   * chatSessionId/source for that session. Called in processQueue for each dequeued item,
   * and in start() for the boot-time warm subprocess.
   *
   * Task 8 (LiveSession map) will move this construction into LiveSession's constructor.
   */
  private _buildPerSessionTools(
    chatSessionId: string | undefined,
    source: ChatSource | undefined,
  ): {
    adamToolsInstance: ReturnType<typeof createAdamTools>;
    cachedHooks: ReturnType<typeof buildSessionHooks>;
    dispatches: CapturedDispatch[];
    turnTraceHolder: { id: string | undefined };
  } {
    const dispatches: CapturedDispatch[] = [];
    // Shared holder written by LiveSession.dispatchTurn; read by the traced-tool-wrapper
    // and the PostToolUse hook so both attribute rows to the correct per-turn trace.
    const turnTraceHolder: { id: string | undefined } = { id: undefined };
    const adamToolsInstance = createAdamTools({
      hideLegacyDispatchTask: true,
      getActiveChatOrigin: () => chatSessionId && source
        ? { chatSessionId, source }
        : undefined,
      onTaskDispatched: (dispatch) => {
        dispatches.push(dispatch);
        // P-1 race-free origin attribution: this callback is bound to THIS session's CONSTANT
        // chatSessionId/source, so attribute the dispatched task directly. The old task_created
        // listener guessed the "active" session from the live map (first entry) — which misroutes
        // completions under concurrency AND mis-attributes non-chat (cron/template) tasks.
        if (chatSessionId && source) {
          try {
            updateTask(dispatch.taskId, { sourceSessionId: chatSessionId });
            this.taskOriginMap.set(dispatch.taskId, { chatSessionId, source, createdAt: Date.now() });
          } catch (err) {
            log.debug({ err, taskId: dispatch.taskId, chatSessionId }, "onTaskDispatched origin attribution failed");
          }
        }
      },
      getTurnTraceId: () => turnTraceHolder.id,
    });
    const cachedHooks = buildSessionHooks({
      currentTaskId: undefined,
      roleId: "role-chat-manager",
      getChatSessionId: () => chatSessionId,
      getCurrentTurnTraceId: () => turnTraceHolder.id,
    });
    return { adamToolsInstance, cachedHooks, dispatches, turnTraceHolder };
  }

  /**
   * Get or create a LiveSession for the given chat session ID.
   * Reuses an existing live session if present; otherwise creates a new one
   * with per-session constant adam-tools/hooks binding.
   *
   * On resume: if the chat session has a stored sdkSessionId (from a previous
   * server run), creates the query with `resume:<id>` to continue the transcript.
   */
  private async getOrCreateLiveSession(
    chatSessionId: string,
    source: ChatSource | undefined,
  ): Promise<LiveSession> {
    const existing = this.liveSessionMap.get(chatSessionId);
    if (existing) {
      // Touch LRU — move to end (most recently used)
      this._touchLru(chatSessionId);
      return existing;
    }

    // Enforce concurrency cap (DP-001=A: cap=3, evict-LRU with in-flight protection).
    const config = getRuntimeConfig().chat ?? {};
    const cap = (config as { maxConcurrentLiveSessions?: number }).maxConcurrentLiveSessions ?? 3;
    if (this.liveSessionMap.size >= cap) {
      this._evictLru();
    }

    // Build per-session tools/hooks with constant closures bound to this session
    const sessionTools = this._buildPerSessionTools(chatSessionId, source);
    const systemPrompt = this.buildChatManagerPrompt();
    const sharedOptions = this.buildSharedOptions(
      systemPrompt,
      sessionTools.adamToolsInstance,
      sessionTools.cachedHooks,
    );

    // NOTE: We deliberately do NOT pass `resume: <sdkSessionId>`. In streaming-input mode
    // (query({prompt: AsyncIterable})) the CLI does not persist a resumable transcript to
    // ~/.claude/projects/, so `--resume <id>` fails with "No conversation found" → the first
    // turn after any restart/eviction returns empty (处理超时) and loops; rapid follow-ups
    // crash the process with EPIPE. Cross-restart continuity is instead carried by replaying
    // this session's history (from chat_messages) into the first turn's prompt — see the seed
    // injection below. Adam's DB is the source of truth, not the CLI's in-memory session.
    // Per-session AbortController wired into query() + LiveSession so the inactivity-timeout
    // teardown can kill the streaming subprocess (the 100%-CPU spinner).
    const { abortController, queryOptions } = this.buildSessionQueryOptions(sharedOptions);

    log.debug({ chatSessionId }, "ChatManager: creating LiveSession (history replayed via seed; no CLI resume)");

    const liveSession = new LiveSession({
      query: (promptStream) => query({ prompt: promptStream, options: queryOptions as Options }),
      abortController,
      chatSessionId,
      source,
      adamToolsInstance: sessionTools.adamToolsInstance,
      cachedHooks: sessionTools.cachedHooks,
      dispatches: sessionTools.dispatches,
      turnTraceHolder: sessionTools.turnTraceHolder,
      onEnd: (err) => {
        // Remove from map when the session dies so the next message recreates it
        if (this.liveSessionMap.get(chatSessionId) === liveSession) {
          this.liveSessionMap.delete(chatSessionId);
          this._removeLru(chatSessionId);
        }
        this._clearIdleTimer(chatSessionId);
        if (err) {
          log.warn({ err, chatSessionId }, "LiveSession ended with error");
        } else {
          log.debug({ chatSessionId }, "LiveSession ended cleanly");
        }
      },
    });

    this.liveSessionMap.set(chatSessionId, liveSession);
    this.lruOrder.push(chatSessionId); // new session = most recently used (end of array)
    // Arm idle timer for the new session
    this._resetIdleTimer(chatSessionId, liveSession);

    // Seed EVERY cold session with a bounded replay of its prior conversation (from
    // chat_messages) + top-K memories + open prompts, folded into the first turn's prompt.
    // This is the cross-restart continuity mechanism that replaces the broken CLI resume:
    // a freshly-spawned streaming subprocess starts blank, so without this replay the model
    // would have no memory of earlier turns after a restart/eviction. Folding (vs a separate
    // push) keeps one SDK input message per turn — no phantom result (#265). For a brand-new
    // session the replay is empty and only open prompts/memories remain. Non-fatal: a seed
    // failure must not block session creation.
    try {
      const seed = await buildSessionContext(chatSessionId, "", { mode: "seed" });
      if (seed && seed.trim()) {
        liveSession.prependSeedToFirstTurn(seed);
      }
    } catch (err) {
      log.debug({ err, chatSessionId }, "ChatManager: seed context injection failed (non-fatal)");
    }
    return liveSession;
  }

  /**
   * Close the LiveSession for the given chat session ID (if any).
   * Must be called BEFORE deleting/archiving the DB row to avoid FK crash
   * (memory: feedback_chatmanager_session_delete_crash).
   */
  closeLiveSession(chatSessionId: string): void {
    const liveSession = this.liveSessionMap.get(chatSessionId);
    if (liveSession) {
      this._clearIdleTimer(chatSessionId);
      this._removeLru(chatSessionId);
      this.liveSessionMap.delete(chatSessionId);
      try { liveSession.end(); } catch (err) {
        log.debug({ err, chatSessionId }, "closeLiveSession: end() threw");
      }
    }
  }

  // ─── LRU + Idle timer helpers ────────────────────────────────────────────────

  /** Move sessionId to the end of the LRU array (most recently used). */
  private _touchLru(chatSessionId: string): void {
    const idx = this.lruOrder.indexOf(chatSessionId);
    if (idx !== -1) {
      this.lruOrder.splice(idx, 1);
      this.lruOrder.push(chatSessionId);
    }
  }

  /** Remove sessionId from the LRU array (called when session ends). */
  private _removeLru(chatSessionId: string): void {
    const idx = this.lruOrder.indexOf(chatSessionId);
    if (idx !== -1) this.lruOrder.splice(idx, 1);
  }

  /**
   * Evict the LRU (least recently used) session that is NOT in-flight.
   * If ALL sessions are in-flight, evict the oldest anyway (best effort).
   */
  private _evictLru(): void {
    // Find the LRU session that is not in-flight
    let victimId: string | undefined;
    for (const id of this.lruOrder) {
      const ls = this.liveSessionMap.get(id);
      if (ls && !ls.isInFlight) {
        victimId = id;
        break;
      }
    }
    // If all in-flight, prefer NOT evicting (queue new creation after cap check)
    // Per plan verifier R5: prefer queuing over killing busy. If we can't evict
    // a non-busy session, skip eviction (cap will be temporarily exceeded).
    if (!victimId) {
      log.warn({ lruOrder: this.lruOrder }, "ChatManager: all live sessions in-flight, skipping LRU eviction");
      return;
    }
    log.debug({ victimId }, "ChatManager: LRU evicting live session");
    this.closeLiveSession(victimId);
  }

  /** Arm (or reset) the idle eviction timer for a session. */
  private _resetIdleTimer(chatSessionId: string, liveSession: LiveSession): void {
    this._clearIdleTimer(chatSessionId);
    const config = getRuntimeConfig().chat ?? {};
    const idleMinutes = (config as { liveSessionIdleMinutes?: number }).liveSessionIdleMinutes ?? 30;
    const idleMs = idleMinutes * 60 * 1000;
    const handle = setTimeout(() => {
      // Only close if the session is still the same LiveSession (not replaced) and not in-flight
      const current = this.liveSessionMap.get(chatSessionId);
      if (current === liveSession && !liveSession.isInFlight) {
        log.debug({ chatSessionId, idleMinutes }, "ChatManager: idle evicting live session");
        this.closeLiveSession(chatSessionId);
      } else if (current === liveSession && liveSession.isInFlight) {
        // Session is still in-flight at idle expiry — re-arm the timer (wait until idle again)
        this._resetIdleTimer(chatSessionId, liveSession);
      }
    }, idleMs);
    this.idleTimers.set(chatSessionId, handle);
  }

  /** Cancel the idle timer for a session. */
  private _clearIdleTimer(chatSessionId: string): void {
    const handle = this.idleTimers.get(chatSessionId);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.idleTimers.delete(chatSessionId);
    }
  }

  /**
   * Get or create an anonymous LiveSession (no chatSessionId).
   * Used when handleMessageWithDispatches is called without a session ID
   * (e.g. internal system calls). Creates a transient session keyed by a UUID.
   */
  private async getOrCreateAnonymousLiveSession(source: ChatSource | undefined): Promise<LiveSession> {
    const anonKey = "__anon__";
    const existing = this.liveSessionMap.get(anonKey);
    if (existing) return existing;

    const sessionTools = this._buildPerSessionTools(undefined, source);
    const systemPrompt = this.buildChatManagerPrompt();
    const sharedOptions = this.buildSharedOptions(
      systemPrompt,
      sessionTools.adamToolsInstance,
      sessionTools.cachedHooks,
    );

    const { abortController, queryOptions } = this.buildSessionQueryOptions(sharedOptions);
    const liveSession = new LiveSession({
      query: (promptStream) => query({ prompt: promptStream, options: queryOptions as Options }),
      abortController,
      source,
      adamToolsInstance: sessionTools.adamToolsInstance,
      cachedHooks: sessionTools.cachedHooks,
      dispatches: sessionTools.dispatches,
      turnTraceHolder: sessionTools.turnTraceHolder,
      onEnd: () => { this.liveSessionMap.delete(anonKey); },
    });

    this.liveSessionMap.set(anonKey, liveSession);
    return liveSession;
  }

  /**
   * Subscribe to events for task lifecycle tracking.
   */
  private subscribeToEvents(): void {
    if (this.subscribed) return;
    this.subscribed = true;

    // Track task origins: when a task is created during chat message processing,
    // find the active LiveSession for that session (the one with an in-flight turn)
    // and persist the source session ID on the task record.
    serverBus.on("task_created", (event) => {
      // P-1: primary origin attribution now happens RACE-FREE in the per-session
      // onTaskDispatched callback (bound to the dispatching session's constant id). This
      // listener only handles SUBTASK inheritance — a subtask created by a parent task's
      // execution inherits the parent's chat origin (onTaskDispatched does not fire for
      // execution-created subtasks). The old "first live session" guess was removed: it
      // misrouted completions under concurrency and mis-attributed non-chat tasks.
      const task = getTask(event.taskId);
      if (task?.parentId) {
        const parentOrigin = this.taskOriginMap.get(task.parentId);
        const parentTask = parentOrigin ? undefined : getTask(task.parentId);
        const sourceSessionId = parentOrigin?.chatSessionId ?? parentTask?.sourceSessionId;
        if (sourceSessionId) {
          updateTask(event.taskId, { sourceSessionId });
          if (parentOrigin) {
            this.taskOriginMap.set(event.taskId, { ...parentOrigin });
          }
        }
      }
    });

    // When a task completes, route the result back to the originating chat session
    serverBus.on("task_complete_event", (event) => {
      void this.handleTaskCompletion(event.taskId, event.result, event.error);
    });

    // Track intermediate status: task just started running
    serverBus.on("task_status_change", (event) => {
      const origin = this.taskOriginMap.get(event.taskId);
      if (!origin) return;
      if (event.newStatus === "running") {
        void this.handleTaskStatusReport(event.taskId, event.newStatus, origin);
      }
    });

    // Phase 5: when task transitions to terminal state, immediately expire
    // any open pending_prompts linked to that task (UX-015).
    serverBus.on("task_status_change", (event) => {
      if (!isTerminalStatus(event.newStatus)) return;
      void this.handleTaskTerminalForPrompts(event.taskId);
    });

    // Track approval requests (privilege escalation — an intermediate lifecycle event)
    serverBus.on("plan_approval_request", (event) => {
      const origin = this.taskOriginMap.get(event.taskId);
      if (!origin) return;
      void this.handleTaskStatusReport(event.taskId, "approval_requested", origin);
    });

    // Periodic cleanup of stale entries (> 24 hours)
    setInterval(() => {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const [taskId, origin] of this.taskOriginMap) {
        if (origin.createdAt < cutoff) this.taskOriginMap.delete(taskId);
      }
    }, 60 * 60 * 1000);
  }

  /**
   * LLM-based intermediate status report generation.
   * DP-001: 30s timeout with template fallback ensures timely delivery.
   */
  private async handleTaskStatusReport(
    taskId: string,
    status: string,
    origin: { chatSessionId: string; source: ChatSource; createdAt: number },
  ): Promise<void> {
    const task = getTask(taskId);
    const roleName = task?.roleId ? await this.getRoleName(task.roleId) : undefined;
    const taskLabel = roleName ?? taskId.slice(0, 8);
    const prompt = task?.prompt?.slice(0, 1000) ?? "";

    let instruction: string;
    switch (status) {
      case "running":
        instruction = `[System] Task "${taskLabel}" has started execution. Task prompt: "${prompt}". Compose a brief, natural status message for the user (1-2 sentences in the user's language). Do NOT call any tools — just output the message text.`;
        break;
      case "approval_requested":
        instruction = `[System] Task "${taskLabel}" needs user approval (privilege escalation). The approval request has been sent separately. Compose a brief notice for the user (1 sentence). Do NOT call any tools.`;
        break;
      default:
        return; // Unknown status, skip
    }

    const fallbackTemplates: Record<string, string> = {
      running: `任务 ${taskLabel} 已启动`,
      approval_requested: `任务 ${taskLabel} 需要授权`,
    };
    let resolved = false;
    const timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      const fallback = fallbackTemplates[status] ?? `任务 ${taskLabel}: ${status}`;
      this.deliverReport(origin, taskId, fallback);
    }, 30_000);

    // Route through the origin session's LiveSession; fall through to 30s fallback on any error.
    void (async () => {
      try {
        const liveSession = await this.getOrCreateLiveSession(origin.chatSessionId, origin.source);
        const result = await liveSession.push(instruction, getTaskTraceId(taskId));
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        const text = result.text?.trim() || (fallbackTemplates[status] ?? `任务 ${taskLabel}: ${status}`);
        this.deliverReport(origin, taskId, text);
      } catch {
        // S1-3 defense-in-depth: LiveSession error triggers fallback
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        const fallback = fallbackTemplates[status] ?? `任务 ${taskLabel}: ${status}`;
        this.deliverReport(origin, taskId, fallback);
      }
    })();
  }

  /**
   * Write a report message to the chat session and deliver to channel if applicable.
   * Reusable for both intermediate status reports and completion reports.
   *
   * @param dedupTaskId — pass taskId for completion-stage reports to enable gateway dedup.
   *   Omit for intermediate status reports (e.g., "running") to avoid cross-phase dedup conflicts
   *   (intermediate and completion reports share the same dedup key pattern).
   */
  private deliverReport(
    origin: { chatSessionId: string; source: ChatSource; createdAt: number },
    taskId: string,
    text: string,
    dedupTaskId?: string,
  ): void {
    // Write to chat session
    const msg: ChatMessage = {
      id: uuidv4(),
      sessionId: origin.chatSessionId,
      role: "assistant",
      content: text,
      source: origin.source,
      taskId,
      kind: "status_report",
      createdAt: Date.now(),
    };
    createMessage(msg);
    serverBus.emit({ type: "chat_message", sessionId: origin.chatSessionId, message: msg });
    sessionManager.incrementMessageCount(origin.chatSessionId);

    // Deliver to channel if origin is channel (D-006 reportTo origin fallback)
    if (origin.source.type === "channel" && origin.source.channelId && origin.source.chatId) {
      void this.deliverToChannel(origin.source.channelId, origin.source.chatId, text, "status_report", dedupTaskId);
    }
  }

  /**
   * Unified target set used for deduplication in handleTaskCompletion.
   * Dedup key: (type, channelId||sessionId, chatId).
   */
  private buildUnifiedTargets(
    origin: { chatSessionId: string; source: ChatSource; createdAt: number } | undefined,
    taskNow: { reportTo?: { type: string; channelId?: string; sessionId?: string; chatId?: string }[]; deliverTo?: { type: string; channelId?: string; sessionId?: string; chatId?: string }[] } | undefined,
  ): Map<string, { type: "channel" | "session"; channelId?: string; sessionId?: string; chatId?: string }> {
    const targets = new Map<string, { type: "channel" | "session"; channelId?: string; sessionId?: string; chatId?: string }>();
    const addTarget = (t: { type: string; channelId?: string; sessionId?: string; chatId?: string }) => {
      const key = `${t.type}:${t.channelId ?? t.sessionId ?? ""}:${t.chatId ?? ""}`;
      if (!targets.has(key)) {
        targets.set(key, {
          type: t.type as "channel" | "session",
          channelId: t.channelId,
          sessionId: t.sessionId,
          chatId: t.chatId,
        });
      }
    };
    // origin channel
    if (origin?.source.type === "channel" && origin.source.channelId) {
      addTarget({ type: "channel", channelId: origin.source.channelId, chatId: origin.source.chatId });
    }
    // origin session — always included so the originating session receives the delivery.
    // Dedup prevents double-write if session is also in reportTo/deliverTo.
    if (origin?.chatSessionId) {
      addTarget({ type: "session", sessionId: origin.chatSessionId });
    }
    // reportTo
    for (const t of taskNow?.reportTo ?? []) addTarget(t);
    // deliverTo
    for (const t of taskNow?.deliverTo ?? []) addTarget(t);
    return targets;
  }

  /**
   * Send a single envelope of the given kind to all targets in the unified set.
   * Converts ChatAttachment[] to OutboundAttachment[] for gateway transport.
   */
  private async sendEnvelope(args: {
    kind: ChatEnvelopeKind;
    targets: Map<string, { type: "channel" | "session"; channelId?: string; sessionId?: string; chatId?: string }>;
    content: string;
    taskId: string;
    roleId?: string;
    attachments?: ChatAttachment[];
    mirroredToTargets?: DeliveryTarget[];
  }): Promise<void> {
    const { kind, targets, content, taskId, roleId, attachments, mirroredToTargets } = args;

    const outboundAttachments: OutboundAttachment[] | undefined = attachments
      ?.map(chatAttachmentToOutbound)
      .filter((a): a is OutboundAttachment => a !== null);

    for (const [, target] of targets) {
      if (target.type === "channel" && target.channelId && target.chatId) {
        const gateway = getOutboundGateway();
        const result = await gateway.send({
          taskId,
          channelId: target.channelId,
          chatId: target.chatId,
          content,
          messageType: kind,
          attachments: outboundAttachments,
        });
        // Channel delivery persists via delivery_log (gateway.send creates the log entry).
        // platform_message_id (result.messageId) is tracked by the channel adapter's own message store,
        // not on chat_messages — channel deliveries don't create chat_messages rows.
        // Native-quote resolution for channel-originated tasks reads from the adapter, not chat_messages.
        void result;
      } else if (target.type === "session" && target.sessionId) {
        // For session targets: resolve source from session registry if available,
        // otherwise fall back to { type: "web" } (test environment may not have session registered).
        const session = sessionManager.getSession(target.sessionId);
        const resolvedSource = session?.source ?? { type: "web" as const };
        const msg: ChatMessage = {
          id: uuidv4(),
          sessionId: target.sessionId,
          role: "assistant",
          content,
          source: resolvedSource,
          taskId,
          kind,
          roleId,
          attachments,
          mirroredToTargets,
          threadRoot: taskId,
          createdAt: Date.now(),
        };
        createMessage(msg);
        serverBus.emit({ type: "chat_message", sessionId: target.sessionId, message: msg });
        sessionManager.incrementMessageCount(target.sessionId);
      }
    }
  }

  /**
   * Handle task completion: unified target dedup + single envelope per target.
   * Phase 4: replaces all prior deliverReport + deliverToChannel + truncation logic.
   */
  private async handleTaskCompletion(taskId: string, result?: string, error?: string): Promise<void> {
    // Re-fetch to get current status; also populates task.blockReason
    const taskNow = getTask(taskId);
    const task = taskNow;
    const isBlocked = taskNow?.status === "blocked";
    if (taskNow && isTemplateExecutionStepTask(taskNow)) {
      log.debug({ taskId, templateId: taskNow.templateId, stepId: taskNow.stepId }, "Skipping ChatManager delivery for TemplateExecution step task");
      return;
    }

    // Resolve origin: memory cache first, then DB (for post-restart resilience)
    let origin = this.taskOriginMap.get(taskId);
    if (!origin && task?.sourceSessionId) {
      const session = sessionManager.getSession(task.sourceSessionId);
      if (session) {
        origin = { chatSessionId: session.id, source: session.source, createdAt: task.createdAt };
      }
    }

    // Build unified target set: {origin} ∪ reportTo[] ∪ deliverTo[]
    const targets = this.buildUnifiedTargets(origin, taskNow);

    // Compute taskLabel for all error-report branches
    const roleName = taskNow?.roleId ? await this.getRoleName(taskNow.roleId) : undefined;
    const taskLabel = roleName ? `${roleName}` : taskId.slice(0, 8);

    // Build raw deliver content for artifact creation
    const deliverContent = error ? `任务失败: ${error}` : (result ?? "");
    const committedDeliverySummary = error ? "" : await this.fulfillPendingDeliveryCommitments(taskId, task);

    // --- Intermediate status: one status_report envelope per target ---
    if (isBlocked) {
      const reason = taskNow!.blockReason;
      const blockedText = `🟡 任务卡住: ${reason?.reason ?? "unknown"}\n` +
        (reason?.missingPrereqs?.length ? `缺少: ${reason.missingPrereqs.join(", ")}\n` : "") +
        (reason?.resumeHint ? `解决方法: ${reason.resumeHint}` : "");

      await this.sendEnvelope({ kind: "status_report", targets, content: blockedText, taskId, roleId: task?.roleId });
      if (origin) this.taskOriginMap.delete(taskId);

      // Goal aggregation still runs below
    } else if (error) {
      const errorCategory = taskNow?.errorCategory as ErrorCategory | undefined;
      const classified: ClassifiedError | null = errorCategory
        ? ((): ClassifiedError => {
          try { return JSON.parse(taskNow!.error ?? "{}") as ClassifiedError; }
          catch { return { category: errorCategory, originalError: error ?? "", retryable: false }; }
        })()
        : null;

      // RATE_LIMIT: schedule delayed retry
      if (classified?.category === "RATE_LIMIT" && (taskNow?.retryCount ?? 0) < 1) {
        this.scheduleRetry(taskId, 30_000);
        const reportText = `⏳ ${taskLabel} 遇到频率限制，将在 30 秒后自动重试...`;
        await this.sendEnvelope({ kind: "status_report", targets, content: reportText, taskId, roleId: task?.roleId });
        if (origin) this.taskOriginMap.delete(taskId);
        return; // Retry queued — do NOT send LLM completion report yet
      }

      // NETWORK: immediate retry
      if (classified?.category === "NETWORK" && (taskNow?.retryCount ?? 0) < 1) {
        try {
          await this.retryTask(taskId);
          const reportText = `🔄 ${taskLabel} 网络异常，正在重试...`;
          if (origin) this.deliverReport(origin, taskId, reportText, taskId);
        } catch (err) {
          log.warn({ taskId, error: err }, "Network retry dispatch failed, falling through to escalation");
        }
        // Fall through to also send LLM completion report (retry may not have succeeded)
      }

      // AUTH: escalate to user — do NOT retry
      if (classified?.category === "AUTH") {
        const reportText = `🔐 ${taskLabel} 任务遇到认证问题：${classified.userAction ?? "请检查 API 凭证配置"}`;
        await this.sendEnvelope({ kind: "status_report", targets, content: reportText, taskId, roleId: task?.roleId });
        if (origin) this.taskOriginMap.delete(taskId);
        return; // AUTH errors are not retryable — done
      }
    }

    // --- Terminal status: one result_delivery envelope per target with LLM summary ---
    // PRE-1 fix: a blocked task already sent its 🟡 status_report above; it must NOT also send
    // a (misleading) "completed/failed" result_delivery. Goal aggregation below still runs for
    // blocked tasks. (A bare `return` here would skip that aggregation — hence the guard.)
    if (!isBlocked) {
    const completionInstruction = error
      ? `[System] Task "${taskLabel}" failed. Error: ${error.slice(0, 1500)}. Compose a brief failure report for the user (2-3 sentences). Do NOT call any tools.`
      : `[System] Task "${taskLabel}" completed successfully. Result summary: ${(result ?? "").slice(0, 4000)}.${committedDeliverySummary ? `\nDelivery evidence: ${committedDeliverySummary}` : ""} Compose a brief completion report for the user (2-3 sentences, highlight key outcomes). If delivery evidence is present, describe only that stored delivery status. Do NOT call any tools.`;

    const fallbackTemplates: Record<string, string> = {
      success: `任务完成 (${taskLabel})`,
      error: `任务失败 (${taskLabel})`,
    };
    let reportResolved = false;
    const reportTimeoutId = setTimeout(async () => {
      if (reportResolved) return;
      reportResolved = true;
      const fallback = error ? fallbackTemplates.error : fallbackTemplates.success;
      const auditedFallback = this.applyDeliveryClaimAudit(fallback, taskId, origin?.chatSessionId);
      const attachments: ChatAttachment[] = [];
      const reportArtifact = createReportArtifact(deliverContent, taskId, MANAGER_WORKSPACE);
      if (reportArtifact) attachments.push(reportArtifact);
      await this.sendEnvelope({ kind: "result_delivery", targets, content: auditedFallback, taskId, roleId: task?.roleId, attachments });
      if (origin) this.taskOriginMap.delete(taskId);
    }, 30_000);

    // Route the completion-report turn through the origin session's LiveSession.
    // Verifier R4: if origin?.chatSessionId is absent (API-/template-triggered task), do NOT call
    // getOrCreateLiveSession(undefined) — fall through directly to the 30s-timeout fallback above.
    if (origin?.chatSessionId) {
      void (async () => {
        try {
          const liveSession = await this.getOrCreateLiveSession(origin.chatSessionId, origin.source);
          const result = await liveSession.push(completionInstruction, getTaskTraceId(taskId));
          if (reportResolved) return;
          reportResolved = true;
          clearTimeout(reportTimeoutId);
          const text = result.text?.trim() || (error ? fallbackTemplates.error : fallbackTemplates.success);
          const auditedText = this.applyDeliveryClaimAudit(text, taskId, origin.chatSessionId);

          // Build attachments: auto-artifact for large results
          const attachments: ChatAttachment[] = [];
          const reportArtifact = createReportArtifact(deliverContent, taskId, MANAGER_WORKSPACE);
          if (reportArtifact) attachments.push(reportArtifact);

          // Build mirrored_to_targets: non-origin channel targets only (origin is implied by session).
          const mirroredToTargets: DeliveryTarget[] = [];
          for (const [, target] of targets) {
            if (!target.channelId) continue;
            if (origin.source.type === "channel" && target.channelId === origin.source.channelId) continue;
            mirroredToTargets.push({ type: "channel", channelId: target.channelId, chatId: target.chatId });
          }

          await this.sendEnvelope({ kind: "result_delivery", targets, content: auditedText, taskId, roleId: task?.roleId, attachments, mirroredToTargets });
          this.taskOriginMap.delete(taskId);
        } catch {
          if (reportResolved) return;
          reportResolved = true;
          clearTimeout(reportTimeoutId);
          const fallback = error ? fallbackTemplates.error : fallbackTemplates.success;
          const auditedFallback = this.applyDeliveryClaimAudit(fallback, taskId, origin.chatSessionId);
          const attachments: ChatAttachment[] = [];
          const reportArtifact = createReportArtifact(deliverContent, taskId, MANAGER_WORKSPACE);
          if (reportArtifact) attachments.push(reportArtifact);
          await this.sendEnvelope({ kind: "result_delivery", targets, content: auditedFallback, taskId, roleId: task?.roleId, attachments });
          this.taskOriginMap.delete(taskId);
        }
      })();
    }

    if (!origin) {
      log.debug({ taskId }, "Task completed but no chat session origin tracked (may be API-created or template-triggered)");
    }
    } // end if(!isBlocked) — PRE-1: blocked tasks skip the terminal result_delivery

    // --- Goal aggregation: runs for both blocked and non-blocked paths ---
    if (taskNow?.parentId) {
      const parentGoal = getGoal(taskNow.parentId);
      if (parentGoal) {
        const siblingTasks = listTasksByParent(taskNow.parentId);
        const allDone = siblingTasks.every((t) => t.status === "completed" || t.status === "failed" || t.status === "blocked");
        if (allDone) {
          const anyFailed = siblingTasks.some((t) => t.status === "failed" || t.status === "blocked");
          const finalStatus: GoalStatus = anyFailed ? "failed" : "completed";
          updateGoal(taskNow.parentId, { status: finalStatus, updatedAt: Date.now() });
          log.info({ goalId: taskNow.parentId, goalName: parentGoal.name, finalStatus }, "Goal completed");

          // Route Goal completion notification
          const goalCompletionText = `${anyFailed ? "❌" : "✅"} 目标完成: ${parentGoal.name}\n\n${siblingTasks.length} 个子任务全部完成`;
          await this.routeGoalNotification(parentGoal, goalCompletionText, taskNow.parentId);
        }
      }
    }
  }

  private async getRoleName(roleId: string): Promise<string | undefined> {
    try {
      const { getRole } = await import("../store/roles.js");
      return getRole(roleId)?.name;
    } catch {
      return undefined;
    }
  }

  private applyDeliveryClaimAudit(text: string, taskId: string, sessionId?: string): string {
    const traceId = getTaskTraceId(taskId);

    const deliveryAudit = auditDeliveryClaims({
      text,
      traceId,
      taskId,
      sessionId,
    });
    const oldAuditedText = deliveryAudit.status === "blocked"
      ? deliveryAudit.replacementText ?? text
      : text;
    const oldVerdict = deliveryAudit.status;
    const oldReplacementText = deliveryAudit.status === "blocked" ? deliveryAudit.replacementText : undefined;

    let newVerdict: "passed" | "blocked" = "passed";
    let newReplacementText: string | undefined;
    try {
      if (traceId) {
        const claimAudit = auditClaimsForTurn({ traceId, sessionId, text });
        newVerdict = claimAudit.status;
        newReplacementText = claimAudit.replacementText;
      }
    } catch (err) {
      log.warn({ err, taskId, traceId }, "auditClaimsForTurn threw in envelope path; ignoring (fail-open)");
    }

    // Old precedence: if old blocked, use old replacement. Else if new blocked, use new replacement. Else original.
    let finalText: string;
    if (oldVerdict === "blocked") {
      finalText = oldAuditedText;
    } else if (newVerdict === "blocked") {
      finalText = newReplacementText ?? text;
    } else {
      finalText = text;
    }

    if (traceId) {
      try {
        writeDivergenceLog({
          traceId,
          sessionId,
          taskId,
          wirePoint: "chat_manager_envelope",
          oldVerdict,
          newVerdict,
          oldReplacementText,
          newReplacementText,
        });
      } catch (divergenceErr) {
        log.warn({ err: divergenceErr, taskId, traceId }, "writeDivergenceLog failed in envelope path");
      }
    }

    return finalText;
  }

  private async fulfillPendingDeliveryCommitments(
    taskId: string,
    task: ReturnType<typeof getTask>,
  ): Promise<string> {
    if (!task) return "";
    const commitments = findPendingDeliveryCommitmentsForTask(taskId);
    if (commitments.length === 0) return "";

    const summaries: string[] = [];
    for (const commitment of commitments) {
      const resolved = resolveDeliverableArtifacts({ task, commitment });
      if (resolved.attachments.length === 0) {
        summaries.push(`commitment ${commitment.id}: failed no_deliverable_artifacts`);
        continue;
      }

      const outboundAttachments = resolved.attachments
        .map(chatAttachmentToOutbound)
        .filter((attachment): attachment is OutboundAttachment => attachment !== null);
      if (outboundAttachments.length === 0) {
        markDeliveryCommitmentFailed(commitment.id, "no_sendable_attachments", resolved.attachments.map((attachment, index) => ({
          attachmentIndex: index,
          artifactId: attachment.artifactId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          target: commitment.target,
          status: "failed",
          error: "no_sendable_attachments",
        })));
        summaries.push(`commitment ${commitment.id}: failed no_sendable_attachments`);
        continue;
      }

      if (commitment.target.type === "session") {
        const msg: ChatMessage = {
          id: uuidv4(),
          sessionId: commitment.target.sessionId,
          role: "assistant",
          content: "已发送承诺的附件。",
          source: sessionManager.getSession(commitment.target.sessionId)?.source ?? { type: "web" },
          taskId,
          kind: "result_delivery",
          attachments: resolved.attachments,
          threadRoot: taskId,
          roleId: task.roleId,
          createdAt: Date.now(),
        };
        createMessage(msg);
        serverBus.emit({ type: "chat_message", sessionId: commitment.target.sessionId, message: msg });
        sessionManager.incrementMessageCount(commitment.target.sessionId);
        const evidence = resolved.attachments.map((attachment, index) => ({
          attachmentIndex: index,
          eventId: msg.id,
          artifactId: attachment.artifactId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          target: commitment.target,
          status: "delivered" as const,
          deliveredAt: Date.now(),
        }));
        markDeliveryCommitmentFulfilled(commitment.id, evidence);
        summaries.push(`commitment ${commitment.id}: fulfilled ${evidence.length} attachments`);
        continue;
      }

      const capabilities = commitment.target.type === "channel" && commitment.target.channelId
        ? await this.getChannelCapabilities(commitment.target.channelId)
        : null;
      const fanout = await sendCommittedAttachmentFanout({
        gateway: getOutboundGateway(),
        taskId,
        commitmentId: commitment.id,
        target: commitment.target,
        content: "已发送承诺的附件。",
        messageType: "result_delivery",
        attachments: outboundAttachments,
        capabilities,
      });

      if (fanout.success) {
        markDeliveryCommitmentFulfilled(commitment.id, fanout.evidence);
        summaries.push(`commitment ${commitment.id}: fulfilled ${fanout.evidence.length} attachments`);
      } else {
        markDeliveryCommitmentFailed(commitment.id, fanout.failureReason ?? "attachment_delivery_failed", fanout.evidence);
        summaries.push(`commitment ${commitment.id}: failed ${fanout.failureReason ?? "attachment_delivery_failed"}`);
      }
    }
    return summaries.join("; ");
  }

  private async getChannelCapabilities(channelId: string): Promise<import("../shared/types.js").ChannelCapabilities | null> {
    try {
      const { getChannelManager } = await import("../server/routes/channels.js");
      const capabilities = getChannelManager()?.getCapabilities(channelId);
      if (capabilities) return capabilities;
    } catch {
      // Fall through to static platform fallback.
    }
    const channel = getChannel(channelId);
    if (channel?.platform === "wechat") {
      return {
        canEdit: false,
        canQuote: true,
        canParseQuote: true,
        canInlineButtons: false,
        maxTextLength: 4000,
        supportsAttachments: true,
        maxAttachmentsPerMessage: 1,
      };
    }
    return null;
  }

  private async deliverToChannel(channelId: string, chatId: string, text: string, messageType: "report" | "deliver" | "reply" | "status_report" | "result_delivery" = "reply", taskId?: string): Promise<void> {
    if (!channelId || !chatId) {
      log.warn({ channelId, chatId }, "Cannot deliver to channel: missing channelId or chatId");
      return;
    }
    try {
      const gateway = getOutboundGateway();
      const result = await gateway.send({ taskId, channelId, chatId, content: text, messageType });
      if (result.success) {
        log.info({ channelId, chatId: chatId.slice(0, 12), messageType, taskId: taskId?.slice(0, 8), messageId: result.messageId }, "Delivered notification to channel");
      } else {
        log.warn({ channelId, chatId: chatId.slice(0, 12), messageType, taskId: taskId?.slice(0, 8), error: result.error }, "Channel delivery failed");
      }
    } catch (err) {
      log.error({ error: err, channelId, chatId: chatId.slice(0, 12) }, "Failed to deliver to channel");
    }
  }

  private async routeGoalNotification(goal: Goal, text: string, goalId: string): Promise<void> {
    const targets = goal.deliverTo ?? [];
    const sessionId = goal.sourceSessionId;

    if (targets.length === 0 && !sessionId) return;

    const buildGoalNoteMessage = (sid: string, source: ChatSource): ChatMessage => ({
      id: uuidv4(),
      sessionId: sid,
      role: "assistant",
      content: text,
      source,
      kind: "system_note",
      taskId: undefined,
      threadRoot: undefined,
      roleId: undefined,
      createdAt: Date.now(),
    });

    for (const target of targets) {
      if (target.type === "session") {
        try {
          const session = sessionManager.getSession(target.sessionId);
          if (session) {
            const msg = buildGoalNoteMessage(target.sessionId, session.source);
            createMessage(msg);
            sessionManager.incrementMessageCount(target.sessionId);
            serverBus.emit({ type: "chat_message", sessionId: target.sessionId, message: msg });
          }
        } catch (err) {
          log.error({ error: err, goalId, targetSession: target.sessionId }, "Failed to deliver Goal notification to session");
        }
      } else if (target.type === "channel") {
        await this.deliverToChannel(target.channelId, target.chatId ?? "", text);
      }
    }

    // Fallback: also notify the goal's source session if not already covered
    if (sessionId && !targets.some((t) => t.type === "session" && t.sessionId === sessionId)) {
      try {
        const session = sessionManager.getSession(sessionId);
        if (session) {
          const msg = buildGoalNoteMessage(sessionId, session.source);
          createMessage(msg);
          sessionManager.incrementMessageCount(sessionId);
          serverBus.emit({ type: "chat_message", sessionId, message: msg });
        }
      } catch (err) {
        log.error({ error: err, goalId, sessionId }, "Failed to deliver Goal notification to source session");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Error-aware retry handling (DP-003)
  // ---------------------------------------------------------------------------

  private startDelayedRetryPolling(): void {
    if (this.delayedRetryPollInterval) return;
    this.delayedRetryPollInterval = setInterval(() => {
      void this.pollDelayedRetries();
    }, 15_000);
  }

  /**
   * Poll for due delayed retries. Runs every 15s.
   * Polling handler is responsible for row cleanup.
   */
  private async pollDelayedRetries(): Promise<void> {
    if (!this.running) return;
    const due = getDueDelayedRetries(Date.now());
    for (const entry of due) {
      await this.processDelayedRetry(entry);
    }
  }

  private async processDelayedRetry(entry: { id: string; taskId: string }): Promise<void> {
    const task = getTask(entry.taskId);
    if (!task) {
      deleteDelayedRetry(entry.id);
      log.debug({ delayedRetryId: entry.id }, "Deleted stale delayed_retry: task not found");
      return;
    }
    if ((task.retryCount ?? 0) >= 1) {
      deleteDelayedRetry(entry.id);
      log.info({ taskId: entry.taskId }, "Skipping delayed retry: retry_count >= 1");
      return;
    }
    try {
      await this.retryTask(entry.taskId);
      deleteDelayedRetry(entry.id);
      log.info({ taskId: entry.taskId }, "Delayed retry dispatched and row cleaned up");
    } catch (err) {
      log.warn({ taskId: entry.taskId, error: err }, "Delayed retry dispatch failed, will retry on next poll");
    }
  }

  /**
   * Dispatch a retry task linked to the original via parentId.
   * Increments retry_count on the original task to 1.
   */
  private async retryTask(originalTaskId: string): Promise<void> {
    const original = getTask(originalTaskId);
    if (!original) throw new Error(`Task not found: ${originalTaskId}`);
    if ((original.retryCount ?? 0) >= 1) {
      log.info({ taskId: originalTaskId }, "retryTask: retry_count >= 1, skipping");
      return;
    }
    const taskType = original.config?.taskType ?? "generic";
    const result = await createTaskWithAdmission({
      prompt: original.prompt,
      roleId: original.roleId,
      requirements: original.config?.requirements,
      toolOverrides: original.config?.toolOverrides,
      config: original.config,
      parentId: original.parentId,
      templateId: original.templateId,
      stepId: original.stepId,
      deliverTo: original.deliverTo,
      reportTo: original.reportTo,
      sourceSessionId: original.sourceSessionId,
      traceId: original.traceId,
      dispatchSource: "chat_manager_retry",
    });
    if (!result.ok) throw new Error(`Retry admission failed: ${result.code} — ${result.reason}`);
    incrementRetryCount(originalTaskId);
    if (original.traceId) updateTask(result.taskId, { traceId: original.traceId });
    log.info({ originalTaskId, newTaskId: result.taskId, roleId: result.roleId }, "Retry task created");
  }

  /**
   * Schedule a delayed retry by inserting into the delayed_retries table.
   */
  private scheduleRetry(taskId: string, delayMs: number): void {
    const retryAt = Date.now() + delayMs;
    createDelayedRetry({ id: uuidv4(), taskId, retryAt, createdAt: Date.now() });
    log.info({ taskId, retryAt }, "Scheduled delayed retry");
  }

  // ---------------------------------------------------------------------------
  // Health check methods for Watchdog
  // ---------------------------------------------------------------------------
  getLastActivityAt(): number { return this.lastActivityAt; }
  getConsecutiveStaleCount(): number { return this.consecutiveStaleCount; }
  isHealthy(): boolean { return this.running; }
  /**
   * Number of active live sessions that have a turn in-flight or queued.
   * Task 8-impl: counts only sessions with an active in-flight turn (per-session-aware).
   */
  getQueueDepth(): number {
    let count = 0;
    for (const [, ls] of this.liveSessionMap) {
      if (ls.isInFlight) count++;
    }
    return count;
  }

  /**
   * True when any live session has a turn in-flight.
   * Task 8-impl: checks each LiveSession's isInFlight state (per-session-aware).
   */
  isProcessing(): boolean {
    for (const [, ls] of this.liveSessionMap) {
      if (ls.isInFlight) return true;
    }
    return false;
  }

  /**
   * Called by Watchdog when a stale state is detected.
   * Task 8-impl: closes ONLY sessions whose in-flight turn is stale (age > staleDurationMinutes).
   * Healthy sessions (not in-flight, or freshly in-flight) are left untouched.
   * Recovery (recreate) is lazy — `getOrCreateLiveSession` re-creates on the next message.
   */
  async restartSession(): Promise<void> {
    // Use the watchdog's configured stale threshold if available; default 30 min.
    const staleMs = (() => {
      try {
        const cfg = getRuntimeConfig();
        const mins = (cfg as { watchdog?: { rules?: { managerHealthCheck?: { staleDurationMinutes?: number } } } })
          .watchdog?.rules?.managerHealthCheck?.staleDurationMinutes;
        return (typeof mins === "number" && mins > 0) ? mins * 60_000 : 30 * 60_000;
      } catch { return 30 * 60_000; }
    })();

    let restarted = 0;
    for (const [sessionId, liveSession] of this.liveSessionMap) {
      if (liveSession.isStale(staleMs)) {
        log.warn({ sessionId, staleMs }, "ChatManager: watchdog restarting stuck session");
        this.closeLiveSession(sessionId);
        restarted++;
      }
    }
    if (restarted > 0) {
      log.info({ restarted }, "ChatManager: watchdog restarted stuck sessions (healthy sessions untouched)");
    } else {
      log.debug("ChatManager.restartSession(): no stale sessions found");
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 5: prompt expiry on task terminal state
  // ---------------------------------------------------------------------------
  private async handleTaskTerminalForPrompts(taskId: string): Promise<void> {
    const db = getDb();
    const expireTxn = db.transaction((tid: string) => {
      const open = listOpenPromptsByTask(tid);
      for (const p of open) {
        expirePendingPrompt(p.id, "task_terminated");
      }
      return open.length;
    });
    try {
      const count = expireTxn(taskId);
      if (count > 0) {
        log.info({ taskId, count }, "Phase 5: expired open prompts on task terminal");
      }
    } catch (err) {
      log.error({ err, taskId }, "Phase 5: failed to expire open prompts");
    }
  }
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "blocked" || status === "cancelled";
}
