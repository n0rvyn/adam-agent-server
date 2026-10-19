import { v4 as uuidv4 } from "uuid";
import type { CapturedDispatch, ChatManagerResponse, ChatMessage, ChatSource, PromptResolvedVia } from "../shared/types.js";
import { AUDIT_SIDECAR_LABEL } from "../shared/constants.js";
import * as sessionManager from "./session-manager.js";
import { createMessage, findEnvelopeByPlatformMessageId, updateMessagePromptBinding, getMessage, updateMessageCost } from "../store/messages.js";
import {
  listOpenPromptsBySession,
  resolvePendingPrompt,
  getPendingPrompt,
  type PendingPrompt,
} from "../store/pending-prompts.js";
import { serverBus } from "../server/events/server-bus.js";
import { callClaudeForEvaluation } from "../lib/llm-eval.js";
import { updateSession } from "../store/sessions.js";
import { getLogger } from "../lib/logger.js";
import { withNewTrace } from "../lib/trace-context.js";
import { getChannel } from "../store/channels.js";
import { syncResolvedPrompt } from "./cross-channel-sync.js"; // Task 4
import { auditAssistantCommitment, auditDeliveryClaims } from "../audit/audit-manager.js";
import { auditClaimsForTurn } from "../audit/claim-receipt-auditor.js";
import { writeDivergenceLog } from "../store/auditor-divergence.js";
import { getCurrentTraceId } from "../lib/trace-context.js";
import { applyFutureDeliveryCommitmentGate } from "./delivery-commitment-gate.js";
import { checkPreflightGate, GATE_RETRY_PROMPT, GATE_FALLBACK_TEXT } from "./preflight-delivery-gate.js";
import { recordLlmCost } from "../lib/record-llm-cost.js";
import type { CostRecompute } from "../lib/cost-pricing.js";
const log = getLogger("message-handler");
const pendingBackgroundTasks = new Set<Promise<void>>();

function trackBackgroundTask(task: Promise<void>): void {
  pendingBackgroundTasks.add(task);
  void task.finally(() => {
    pendingBackgroundTasks.delete(task);
  });
}

/**
 * Generate a short session title from the first user message.
 * Called after the first user message is stored. Returns silently on failure.
 */
export async function generateSessionTitle(sessionId: string, firstMessage: string): Promise<void> {
  const config = await import("../config/index.js").then((m) => m.getChatConfig());
  if (!config.autoTitle) return;

  const prompt = [
    "Generate a very short title (max 50 characters) for a chat session that started with this message:",
    `"${firstMessage.slice(0, 200)}"`,
    "Respond with only the title, no quotes or explanation.",
  ].join("\n");

  try {
    const result = await callClaudeForEvaluation(
      prompt,
      "You are a concise title generator. Reply with only the title, max 50 characters.",
    );
    const title = result.trim().slice(0, 50);
    if (title.length > 0) {
      updateSession(sessionId, { title });
    }
  } catch {
    // Title generation failure is non-fatal
  }
}

// ChatManager is set by index.ts after instantiation
let chatManager: import("../manager/chat-manager.js").ChatManager | null = null;

export function setChatManager(manager: import("../manager/chat-manager.js").ChatManager): void {
  chatManager = manager;
}

export async function handleChatMessage(
  content: string,
  source: ChatSource,
  roleId?: string,
  sessionId?: string,
  inboundMeta?: { quotedPlatformMessageId?: string; buttonPayload?: { promptId: string; rawValue: string } },
): Promise<{ sessionId: string; messageId: string }> {
  return withNewTrace("chat", async () => {
  // Find session: explicit sessionId > source match > create new
  let session: import("../shared/types.js").ChatSession | undefined;
  if (sessionId) {
    session = sessionManager.getSession(sessionId);
  }
  if (!session) {
    session = sessionManager.getActiveSession(source);
  }
  if (!session) {
    session = sessionManager.createSession(source, roleId);
  }

  // Store user message
  const messageId = uuidv4();
  const userMessage: ChatMessage = {
    id: messageId,
    sessionId: session.id,
    role: "user",
    content,
    source,
    createdAt: Date.now(),
  };
  createMessage(userMessage);
  serverBus.emit({ type: "chat_message", sessionId: session.id, message: userMessage });

  // Auto-generate session title on first message
  if (session.messageCount === 0) {
    trackBackgroundTask(generateSessionTitle(session.id, content));
  }
  sessionManager.incrementMessageCount(session.id);
  sessionManager.touchSession(session.id);

  // === Phase 5 prompt resolution pipeline (runs before LLM dispatch) ===
  const openPrompts = listOpenPromptsBySession(session.id);

  // === Stale-prompt early branch (BEFORE invoking resolvePromptForUserMessage) ===

  // Native-quote stale: quotedPlatformMessageId 反查到 envelope 但其 prompt 不在 openPrompts
  if (inboundMeta?.quotedPlatformMessageId) {
    const parent = findEnvelopeByPlatformMessageId(inboundMeta.quotedPlatformMessageId);
    if (parent?.promptId && !openPrompts.find((p) => p.id === parent.promptId)) {
      const stale = getPendingPrompt(parent.promptId);
      if (stale?.resolvedAt) {
        await emitSystemNote(session.id, source, `该决策已处理 (#${parent.promptId})`);
        return { sessionId: session.id, messageId };
      }
      if (stale?.expiredReason) {
        await emitSystemNote(session.id, source, `该决策窗口已过期 (#${parent.promptId})`);
        return { sessionId: session.id, messageId };
      }
    }
  }

  // Token stale: text contains #XXXX but the matching prompt is not open
  const tokenMatchEarly = content.match(/#([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4})\b/);
  if (tokenMatchEarly && !openPrompts.find((p) => p.id === tokenMatchEarly[1])) {
    const stale = getPendingPrompt(tokenMatchEarly[1]);
    if (stale?.resolvedAt) {
      await emitSystemNote(session.id, source, `该决策已处理 (#${tokenMatchEarly[1]})`);
      return { sessionId: session.id, messageId };
    }
    if (stale?.expiredReason) {
      await emitSystemNote(session.id, source, `该决策窗口已过期 (#${tokenMatchEarly[1]})`);
      return { sessionId: session.id, messageId };
    }
  }

  // === Now invoke pure resolver ===
  let resolution: { promptId: string; resolvedVia: PromptResolvedVia; verdict: string } | null = null;
  if (openPrompts.length > 0) {
    resolution = await resolvePromptForUserMessage(userMessage, inboundMeta, openPrompts);
  }

  if (resolution) {
    // Bind user_message to the resolved prompt
    updateMessagePromptBinding(messageId, resolution.promptId);

    // Update pending_prompts row
    resolvePendingPrompt(resolution.promptId, messageId, resolution.resolvedVia, resolution.verdict);

    // auto_unique: emit system_note appended after user message (D-P5-05 simplified)
    if (resolution.resolvedVia === "auto_unique") {
      await emitSystemNote(session.id, source, `（已自动绑定到 #${resolution.promptId}）`);
    }

    // Cross-channel sync: edit / broadcast on every channel that received this prompt
    const sourceLabel = describeChatSource(source);
    void syncResolvedPrompt({
      promptId: resolution.promptId,
      verdict: resolution.verdict,
      originatorLabel: sourceLabel,
      skipSource: source,
    });

    // RESOLVED prompt → bypass LLM dispatch, return early
    return { sessionId: session.id, messageId };
  }

  // Stale button click: buttonPayload.promptId set but resolution returned null →
  // the prompt is either resolved or expired. Emit explicit system_note.
  if (inboundMeta?.buttonPayload?.promptId) {
    const stale = getPendingPrompt(inboundMeta.buttonPayload.promptId);
    if (stale?.resolvedAt) {
      await emitSystemNote(session.id, source, `该决策已处理 (#${inboundMeta.buttonPayload.promptId})`);
    } else if (stale?.expiredReason) {
      await emitSystemNote(session.id, source, `该决策窗口已过期 (#${inboundMeta.buttonPayload.promptId})`);
    } else {
      await emitSystemNote(session.id, source, `未找到对应决策 (#${inboundMeta.buttonPayload.promptId})`);
    }
    return { sessionId: session.id, messageId };
  }

  // Disambiguation case: multiple open prompts, no match → emit system_note, do NOT call LLM
  if (openPrompts.length > 1) {
    const lines: string[] = [`收到回复，但有 ${openPrompts.length} 个待决策项：`];
    for (const p of openPrompts) {
      const originRow = getMessage(p.messageId);
      const excerpt = (originRow?.content ?? "").slice(0, 30).replace(/\s+/g, " ");
      lines.push(`- #${p.id} — ${excerpt}`);
    }
    lines.push(`请用 #XXXX 或引用具体决策项再回复。`);
    await emitSystemNote(session.id, source, lines.join("\n"));
    return { sessionId: session.id, messageId };
  }

  // Route to ChatManager in background — don't block the HTTP response
  if (chatManager) {
    const sessionId = session.id;
    const sessionSource = session.source;
    const backgroundTask = (async () => {
      try {
        const response = await callChatManagerForChat(content, sessionId, source);
        const assistantMessageId = uuidv4();
        // turnCostRecords accumulates CostRecompute from EVERY billed callChatManagerForChat call
        // in this turn (original :209 + optional gate-retry :363). Both are billed; only one text
        // is persisted. All cost records link to assistantMessageId for full platform accounting.
        const turnCostRecords: CostRecompute[] = [];
        if (response.cost) {
          turnCostRecords.push(response.cost);
        }

        // Audit chain (commitment gate + delivery claim + assistant commitment).
        // Fail-open: any audit-layer exception falls back to the raw response.text
        // and records an audit_diagnostics row for visibility.
        let finalResponse: string;
        // Hoisted: a blocked commitment claim surfaces as a separate, clearly-labeled
        // `audit_note` message (Option A) instead of replacing the reply. Declared before
        // the inner try so the post-audit store path AND channel delivery can read it.
        let auditNoteText: string | undefined;
        // Hoisted: used by audit chain AND L2 gate; initialized before inner try so the gate
        // (which sits at outer-try level) can reference it regardless of which branch ran.
        let turnTraceId = "";
        try {
          // Resolve turnTraceId once — guards against falsy values affecting the new-auditor +
          // divergence-log paths (which gate on truthy turnTraceId per plan Pre-flight risks).
          turnTraceId = response.traceId ?? getCurrentTraceId() ?? "";

          const commitmentGate = applyFutureDeliveryCommitmentGate({
            text: response.text,
            traceId: turnTraceId,
            sessionId,
            source,
            sourceMessageId: assistantMessageId,
            dispatches: response.dispatches,
          });
          const deliveryAudit = auditDeliveryClaims({
            text: commitmentGate.text,
            traceId: turnTraceId,
            sessionId,
          });
          const deliveryAuditedText = deliveryAudit.status === "blocked"
            ? deliveryAudit.replacementText ?? commitmentGate.text
            : commitmentGate.text;
          const commitmentAudit = auditAssistantCommitment({
            text: deliveryAuditedText,
            traceId: turnTraceId,
            sessionId,
            messageId: assistantMessageId,
          });
          const oldVerdict: "passed" | "blocked" =
            deliveryAudit.status === "blocked" || commitmentAudit.status === "blocked"
              ? "blocked"
              : "passed";
          const oldReplacementText =
            commitmentAudit.status === "blocked"
              ? commitmentAudit.replacementText
              : deliveryAudit.status === "blocked"
                ? deliveryAudit.replacementText
                : undefined;

          // New auditor is text-independent: it compares declared claims (assistant_claims for this trace)
          // against effect_receipts (for this trace). The audit input is traceId, NOT the message text.
          // IMPORTANT: wrap in its own try/catch so a throw from the new auditor cannot
          // undo the OLD auditor's replacement. dual-write contract: OLD must keep working.
          // `recordAuditDiagnostic.source` accepts `AuditDiagnosticSource = "delivery_ledger" | "viewer_identity"
          // | "commitment_audit" | (string & {})` per src/shared/types.ts:1408 — free-text literal "claim_receipt_auditor"
          // and "auditor_divergence_log" pass type-check via the (string & {}) escape hatch.
          let newVerdict: "passed" | "blocked" = "passed";
          let newReplacementText: string | undefined;
          try {
            // Skip new auditor when turnTraceId is unresolved — it persists rows keyed on trace_id,
            // and a "" key pollutes future queries. claim-receipt-auditor.ts:32-34 also early-returns
            // on falsy traceId, but the guard makes this explicit and prevents an empty divergence row below.
            if (turnTraceId) {
              // Phase 6: pass the PRE-old-auditor text so the new auditor's
              // completion-language-detector sees the LLM's original confirmation verbs.
              // If we pass deliveryAuditedText, the old auditor may have already replaced
              // e.g. "已补发..." with its stock "结果已生成，但没有发送动作的记录。" message,
              // and the new auditor would observe no completion language → vacuous pass.
              const claimAudit = auditClaimsForTurn({
                traceId: turnTraceId,
                sessionId,
                messageId: assistantMessageId,
                text: commitmentGate.text,
              });
              newVerdict = claimAudit.status;
              newReplacementText = claimAudit.replacementText;
            }
          } catch (claimErr) {
            try {
              const { recordAuditDiagnostic } = await import("../store/audit-diagnostics.js");
              recordAuditDiagnostic({
                source: "claim_receipt_auditor",
                severity: "warning",
                sourceId: sessionId,
                message: claimErr instanceof Error ? `${claimErr.name}: ${claimErr.message}` : String(claimErr),
              });
            } catch { /* swallow */ }
            // newVerdict stays "passed"; OLD verdict + OLD replacement still drive finalResponseLocal below.
          }

          // Audit presentation (2026-06-02 fix): the commitment/mutation audit no longer
          // REPLACES the reply. The OLD commitment auditor is shadow-only now — its audit row
          // and the divergence log below are still written for monitoring, but it no longer
          // drives user-facing output. A blocked NEW verdict surfaces as a separate, clearly
          // labeled `audit_note` message (Option A), so ChatManager's real reply is preserved.
          //
          // Delivery-claim audit (auditDeliveryClaims) keeps its existing replace behavior:
          // deliveryAuditedText is the enriched text when delivery is blocked, else the real
          // reply (commitmentGate.text) — so it is the correct finalResponse in both cases.
          const finalResponseLocal = deliveryAuditedText;
          // A blocked commitment claim becomes a non-destructive note — but only when delivery
          // itself passed (a blocked delivery already replaced the reply with its own text).
          if (deliveryAudit.status !== "blocked" && newVerdict === "blocked" && newReplacementText) {
            auditNoteText = newReplacementText;
          }

          // Divergence recording (no-op when verdicts agree, skip when turnTraceId unresolved)
          try {
            if (turnTraceId) {
              writeDivergenceLog({
                traceId: turnTraceId,
                sessionId,
                messageId: assistantMessageId,
                wirePoint: "message_handler",
                oldVerdict,
                newVerdict,
                oldReplacementText,
                newReplacementText,
              });
            }
          } catch (divergenceErr) {
            // Divergence-log write failure is not fatal — log via diagnostic, continue
            try {
              const { recordAuditDiagnostic } = await import("../store/audit-diagnostics.js");
              recordAuditDiagnostic({
                source: "auditor_divergence_log",
                severity: "warning",
                sourceId: sessionId,
                message: divergenceErr instanceof Error ? `${divergenceErr.name}: ${divergenceErr.message}` : String(divergenceErr),
              });
            } catch { /* swallow */ }
          }

          finalResponse = finalResponseLocal;
        } catch (auditErr) {
          finalResponse = response.text;
          try {
            const { recordAuditDiagnostic } = await import("../store/audit-diagnostics.js");
            recordAuditDiagnostic({
              source: "chat_audit_chain",
              severity: "error",
              sourceId: sessionId,
              message: auditErr instanceof Error ? `${auditErr.name}: ${auditErr.message}` : String(auditErr),
            });
          } catch {
            // Diagnostic write itself failed — last-resort log only.
            log.error({ err: auditErr, sessionId }, "Chat audit chain failed and diagnostic write also failed");
          }
        }

        // L2 pre-flight gate (Path β): AFTER the audit chain (which may replace finalResponse),
        // BEFORE storing the assistant message. Both success-path finalResponseLocal and
        // catch-path response.text must be gated. Gate is fail-open per DP-Plan-2 Option A.
        try {
          const gateResult = checkPreflightGate({ traceId: turnTraceId, text: finalResponse, sessionId });
          if (gateResult.shouldRetry) {
            // The retry discards the original response, so any audit note derived from it
            // no longer applies — drop it to avoid emitting a stale/misleading note.
            auditNoteText = undefined;
            log.info({ sessionId, turnTraceId, reason: gateResult.reason }, "L2 pre-flight gate triggered — retrying with query prompt");
            try {
              const retryResp = await callChatManagerForChat(GATE_RETRY_PROMPT, sessionId, source);
              // Accumulate retry cost IMMEDIATELY after the call succeeds — covers both
              // retry-won (:384) and retry→fallback (:381) cases (the retry was billed either way).
              if (retryResp.cost) {
                turnCostRecords.push(retryResp.cost);
              }
              // Critically: reuse turnTraceId (NOT retryResp.traceId) for the second gate check.
              // Any query_* calls during retry write to chat_tool_calls with the inherited trace context
              // (retry runs inside the same withNewTrace("chat", …) block at message-handler.ts:76).
              // Using turnTraceId explicitly ensures the gate's "did this turn call query_*?" check
              // is scoped to the original user turn, not the retry sub-trace.
              const retryGateResult = checkPreflightGate({ traceId: turnTraceId, text: retryResp.text, sessionId });
              if (retryGateResult.shouldRetry) {
                finalResponse = GATE_FALLBACK_TEXT;
                log.warn({ sessionId, turnTraceId }, "L2 gate retry also triggered — using fallback text");
              } else {
                finalResponse = retryResp.text;
              }
            } catch (retryErr) {
              // Retry call threw — no cost to record (the call failed before billing)
              finalResponse = GATE_FALLBACK_TEXT;
              log.error({ err: retryErr, sessionId, turnTraceId }, "L2 gate retry call failed — using fallback text");
            }
          }
        } catch (gateErr) {
          // Detector throw: fail-open per DP-Plan-2 Option A.
          // Log diagnostic but leave finalResponse unchanged (gateErr is logged but not propagated).
          try {
            const { recordAuditDiagnostic } = await import("../store/audit-diagnostics.js");
            recordAuditDiagnostic({
              source: "preflight_gate",
              severity: "error",
              sourceId: sessionId,
              message: gateErr instanceof Error ? `${gateErr.name}: ${gateErr.message}` : String(gateErr),
            });
          } catch { /* swallow */ }
        }

        // Store assistant response
        const assistantMessage: ChatMessage = {
          id: assistantMessageId,
          sessionId,
          role: "assistant",
          content: finalResponse,
          source,
          createdAt: Date.now(),
        };
        createMessage(assistantMessage);
        serverBus.emit({ type: "chat_message", sessionId, message: assistantMessage });
        sessionManager.incrementMessageCount(sessionId);
        sessionManager.touchSession(sessionId);

        // Non-destructive audit note (Option A): when a commitment claim lacked evidence,
        // the real reply is kept above and the guardrail speaks in a separate labeled note.
        if (auditNoteText) {
          await emitAuditNote(sessionId, source, auditNoteText);
        }

        // Record ALL billed LLM calls for this turn into llm_costs (DP-002=B).
        // turnCostRecords has 1 entry (normal) or 2 (gate-retry fired).
        // Wrap in try/catch so a cost-record failure never breaks the reply.
        try {
          if (turnCostRecords.length === 1) {
            // Normal path: single billed call, mirror writes chat_messages cost columns.
            void recordLlmCost({
              source: "chat",
              sessionId,
              messageId: assistantMessageId,
              recompute: turnCostRecords[0],
              numTurns: response.numTurns,
              mirror: true,
            });
          } else if (turnCostRecords.length > 1) {
            // Retry path: multiple billed calls — insert each under its own call_id with
            // mirror:false, then do a single updateMessageCost to set the per-message scalar
            // to the sum (so existing consumers see the total, not just one call's cost).
            for (const rec of turnCostRecords) {
              void recordLlmCost({
                source: "chat",
                sessionId,
                messageId: assistantMessageId,
                recompute: rec,
                mirror: false,
              });
            }
            // Mirror scalar: sum all records
            const totalCostUsd = turnCostRecords.reduce((s, r) => s + r.costUsd, 0);
            const totalInput = turnCostRecords.reduce((s, r) => s + r.perModel.reduce((p, m) => p + m.inputTokens, 0), 0);
            const totalOutput = turnCostRecords.reduce((s, r) => s + r.perModel.reduce((p, m) => p + m.outputTokens, 0), 0);
            // Use primary model from last record (retry text is what was persisted)
            const primaryModel = turnCostRecords[turnCostRecords.length - 1].perModel[0]?.model ?? "unknown";
            updateMessageCost(assistantMessageId, {
              costUsd: totalCostUsd,
              tokenUsage: JSON.stringify({ input: totalInput, output: totalOutput }),
              model: primaryModel,
            });
          }
        } catch (costErr) {
          log.warn({ err: costErr, sessionId, messageId: assistantMessageId }, "message-handler: cost record failed (non-fatal)");
        }

        // Route to channel if applicable
        if (sessionSource.type === "channel" && sessionSource.channelId && sessionSource.chatId) {
          log.info({ sessionId, sourceType: sessionSource.type, hasChannelId: !!sessionSource.channelId, hasResponse: !!finalResponse }, "Chat response ready, checking channel delivery");
          // Channels render plain text and never receive the separate `audit_note` message,
          // so the guardrail note must be inlined into the delivered text — otherwise channel
          // users would see the unverified claim with no self-check warning at all.
          const channelText = auditNoteText
            ? `${finalResponse}\n\n⚠️ ${AUDIT_SIDECAR_LABEL}：${auditNoteText}`
            : finalResponse;
          await deliverToChannel(sessionSource.channelId, sessionSource.chatId, channelText);
        }
      } catch (err) {
        const log = (await import("../lib/logger.js")).getLogger("message-handler");
        log.error({ error: err, sessionId }, "ChatManager response failed");

        // Emit error as assistant message so the user sees it
        const errorMessage: ChatMessage = {
          id: uuidv4(),
          sessionId,
          role: "assistant",
          content: `⚠️ 处理失败: ${err instanceof Error ? err.message : String(err)}`,
          source,
          createdAt: Date.now(),
        };
        createMessage(errorMessage);
        serverBus.emit({ type: "chat_message", sessionId, message: errorMessage });
        sessionManager.incrementMessageCount(sessionId);
      }
    })();
    trackBackgroundTask(backgroundTask);
  }

  // Return immediately — user message stored, LLM processing in background
  return { sessionId: session.id, messageId };
  });
}

async function callChatManagerForChat(
  content: string,
  sessionId: string,
  source: ChatSource,
): Promise<ChatManagerResponse> {
  const manager = chatManager as unknown as {
    handleMessageWithDispatches?: (content: string, sessionId?: string, source?: ChatSource) => Promise<ChatManagerResponse>;
    handleMessage: (content: string, sessionId?: string, source?: ChatSource) => Promise<string | ChatManagerResponse>;
  };
  if (manager.handleMessageWithDispatches) {
    return manager.handleMessageWithDispatches(content, sessionId, source);
  }
  const result = await manager.handleMessage(content, sessionId, source);
  if (typeof result === "string") {
    return { text: result, traceId: getCurrentTraceId(), dispatches: [] };
  }
  return {
    text: result.text,
    traceId: result.traceId ?? getCurrentTraceId(),
    dispatches: (result.dispatches ?? []) as CapturedDispatch[],
  };
}

export function handleTaskCompletion(taskId: string, result: string): void {
  // Deprecated: ChatManager handles task completion routing internally via serverBus subscription.
  // This function is kept as a no-op for backward compatibility with any external callers.
}

async function deliverToChannel(channelId: string, chatId: string, text: string): Promise<void> {
  log.info({ channelId, chatId: chatId.slice(0, 12) }, "Delivering chat response to channel");
  try {
    const { getOutboundGateway } = await import("../delivery/outbound-gateway.js");
    const gateway = getOutboundGateway();
    await gateway.send({ channelId, chatId, content: text, messageType: "reply" });
  } catch (err) {
    log.error({ error: err, channelId, chatId: chatId.slice(0, 12) }, "Channel delivery failed (non-fatal)");
  }
}

/**
 * Phase 5 prompt resolution pipeline (runs before LLM dispatch).
 * Returns { promptId, resolvedVia, verdict } if user message resolves an open prompt; null otherwise.
 * Pure resolver: no side effects (no emitSystemNote, no session access).
 */
async function resolvePromptForUserMessage(
  userMessage: ChatMessage,
  inbound: { quotedPlatformMessageId?: string; buttonPayload?: { promptId: string; rawValue: string } } | undefined,
  openPrompts: PendingPrompt[],
): Promise<{ promptId: string; resolvedVia: PromptResolvedVia; verdict: string } | null> {
  // Step 1: native_quote (channel adapter parsed inbound quote)
  if (inbound?.quotedPlatformMessageId) {
    const parentEnvelope = findEnvelopeByPlatformMessageId(inbound.quotedPlatformMessageId);
    if (parentEnvelope?.promptId) {
      const candidate = openPrompts.find((p) => p.id === parentEnvelope.promptId);
      if (candidate) {
        return { promptId: candidate.id, resolvedVia: "native_quote", verdict: userMessage.content };
      }
    }
  }

  // Step 2: token (#XXXX in text)
  const tokenMatch = userMessage.content.match(/#([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4})\b/);
  if (tokenMatch) {
    const candidate = openPrompts.find((p) => p.id === tokenMatch[1]);
    if (candidate) {
      return { promptId: candidate.id, resolvedVia: "token", verdict: userMessage.content };
    }
  }

  // Step 3: button (callback_data / action_id / Web button submit carries promptId)
  if (inbound?.buttonPayload?.promptId) {
    const candidate = openPrompts.find((p) => p.id === inbound.buttonPayload!.promptId);
    if (candidate) {
      return { promptId: candidate.id, resolvedVia: "button", verdict: inbound.buttonPayload.rawValue };
    }
    // Stale button: prompt id present but no longer in open list. Caller wrapper detects via
    // getPendingPrompt() and emits system_note — DO NOT fall through to step 4.
    return null;
  }

  // Step 4: auto_unique (exactly one open prompt, no explicit reference)
  if (openPrompts.length === 1) {
    return { promptId: openPrompts[0].id, resolvedVia: "auto_unique", verdict: userMessage.content };
  }

  // Step 5: disambiguation (multiple open prompts, no match) — caller emits system_note
  return null;
}

/** Emit a non-reply "note" message (web/TUI render it by `kind`; channels don't receive it). */
async function emitNote(
  sessionId: string,
  source: ChatSource,
  content: string,
  kind: "system_note" | "audit_note",
): Promise<void> {
  const note: ChatMessage = {
    id: uuidv4(),
    sessionId,
    role: "assistant",
    content,
    source,
    kind,
    createdAt: Date.now(),
  };
  createMessage(note);
  serverBus.emit({ type: "chat_message", sessionId, message: note });
  sessionManager.incrementMessageCount(sessionId);
}

/** Neutral system note (prompt-resolution notices, etc.). */
function emitSystemNote(sessionId: string, source: ChatSource, content: string): Promise<void> {
  return emitNote(sessionId, source, content, "system_note");
}

/**
 * Emit a non-destructive, clearly-labeled audit note (Option A).
 *
 * The commitment/mutation audit no longer replaces ChatManager's reply; when a claim
 * lacks supporting evidence, the real reply is preserved and the guardrail speaks here,
 * in a separate `audit_note`-kind message that Web/TUI render with a "⚠️ 自检 · 审计边车"
 * label. Channel sessions inline this text instead (see the channel delivery path), since
 * they never receive this message.
 */
function emitAuditNote(sessionId: string, source: ChatSource, content: string): Promise<void> {
  return emitNote(sessionId, source, content, "audit_note");
}

function describeChatSource(source: ChatSource): string {
  if (source.type === "channel" && source.channelId) {
    const channel = getChannel(source.channelId);
    return channel?.name ?? source.channelId;
  }
  if (source.type === "web") return "Web";
  if (source.type === "tui") return "TUI";
  return source.type;
}

// Deprecated: ChatManager handles task completion directly via serverBus subscription.
export function registerCompletionListener(): void {
  // No-op: ChatManager subscribes to task_complete_event via serverBus and handles routing internally.
}

export async function _waitForIdleForTest(): Promise<void> {
  while (pendingBackgroundTasks.size > 0) {
    await Promise.allSettled([...pendingBackgroundTasks]);
  }
}

export async function _resetListenerForTest(): Promise<void> {
  await _waitForIdleForTest();
}
