/**
 * OutboundGateway — unified outbound message layer.
 * All 7 outbound paths route through here: dedup, platform format, anti-loop, delivery_log, retry, rate limit.
 * No LLM involvement.
 */

import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { serverBus } from "../server/events/server-bus.js";
import { formatForChannel } from "./format.js";
import { createDeliveryLog, markDelivered, updateDeliveryLogStatus } from "../store/delivery-log.js";
import { getChannel } from "../store/channels.js";
import { getTaskTemplate } from "../store/task-templates.js";
import { getTemplateExecution } from "../store/template-executions.js";
import { recordAuditDiagnostic } from "../store/audit-diagnostics.js";
import { recordUserVisibleDeliveryEvent } from "../store/user-visible-events.js";
import { resolveViewerKeyForDeliveryTarget } from "../chat/viewer-identity.js";
import { getLogger } from "../lib/logger.js";
import { v4 as uuidv4 } from "uuid";
import { writeEffectReceipt, InvalidReceiptError } from "../store/effect-receipts.js";
import { getCurrentTraceId } from "../lib/trace-context.js";
import type { DeliveryTarget, DeliveryStatus, OutboundAttachment, UserVisibleAttachment, UserVisibleTarget, ViewerKey } from "../shared/types.js";
import { getDeliverableFileArtifacts, buildAttachmentsFromArtifacts } from "../lib/artifact-attachments.js";
import type { Artifact } from "../store/artifacts.js";
import { packForEmailTarget } from "./email-target-packing.js";

const log = getLogger("adam");

export type LegacyMessageType = "report" | "deliver" | "reply" | "approval";
/** Envelope kinds also accepted as messageType (envelope-aware send). */
export type EnvelopeMessageType =
  | "user_message"
  | "assistant_text"
  | "status_report"
  | "result_delivery"
  | "approval_prompt"
  | "system_note";
export type MessageType = LegacyMessageType | EnvelopeMessageType;

export interface OutboundSendOptions {
  taskId?: string;
  /** Session ID for effect receipt sessionId field (Phase 2 DP-002). */
  sessionId?: string;
  channelId?: string;
  chatId?: string;
  content: string;
  /**
   * Message type tag used for filtering + dedup. The 4 known values (`report`/`deliver`/`reply`/`approval`)
   * are the primary set; custom tags like `"mistake_digest"` flow through from Template `config.delivery_message_type`
   * (DP-4.8) for per-template-execution filtering. IDE autocomplete is preserved for the known 4; `string & {}` allows
   * arbitrary tags without collapsing the union.
   */
  messageType: MessageType | (string & {});
  platform?: string;
  webhookUrl?: string;
  replyMarkup?: Record<string, unknown>;  // Passthrough for interactive messages (e.g., Telegram inline keyboard)
  /** Parent platform message ID for quote/reply. Adapter consumes per platform semantics. */
  replyToMessageId?: string;
  /** WeChat-specific: text shown inside ref_msg quote block. */
  quoteExcerpt?: string;
  /** WeChat-specific: title above ref_msg quote. */
  quoteTitle?: string;
  mediaUrl?: string;
  mediaType?: "image" | "audio" | "video" | "file";
  attachments?: OutboundAttachment[];
  dedupDiscriminator?: string;
  viewerKey?: ViewerKey;
  /** Tool name for effect receipt actor.toolName (Phase 2 DP-002). */
  actorToolName?: string;
}

export interface OutboundSendResult {
  success: boolean;
  messageId?: string;
  logEntryId: string;
  error?: string;
}

export class OutboundGateway {
  /** Dedup cache: key = `${taskId}:${channelId}:${chatId}:${messageType}`, TTL 5 min */
  private _dedupCache = new Map<string, { logEntryId: string; timestamp: number }>();

  /** Sliding window rate limit per channelId, max 60/min */
  private _rateLimitWindows = new Map<string, number[]>();

  /** Anti-loop: recently sent platform message IDs, 5-min TTL */
  private _recentlySentIds = new Set<string>();

  /** Per-(channelId, chatId) serialization. Tail-promise pattern: each acquire
   *  chains onto the previous task's promise; release happens automatically when
   *  that promise settles. Different (channelId, chatId) pairs run independently. */
  private _laneTails = new Map<string, Promise<void>>();

  private async _acquireLane(channelId: string, chatId: string): Promise<() => void> {
    const key = `${channelId}:${chatId}`;
    const prev = this._laneTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this._laneTails.set(key, next);
    next.then(() => {
      if (this._laneTails.get(key) === next) this._laneTails.delete(key);
    });
    await prev;
    return release;
  }

  /**
   * Check if a platform message ID was recently sent by this gateway (anti-loop).
   */
  isRecentlySent(id: string): boolean {
    return this._recentlySentIds.has(id);
  }

  async send(options: OutboundSendOptions): Promise<OutboundSendResult> {
    const { taskId, channelId, chatId, content, messageType: optionsMessageType, platform, webhookUrl, replyMarkup, replyToMessageId, quoteExcerpt, quoteTitle, mediaUrl, mediaType, attachments, dedupDiscriminator } = options;
    // Translate legacy messageType to envelope kind. After this line, all internal
    // uses (dedupKey, delivery_log, serverBus emits) operate on the translated value.
    const messageType = translateLegacyMessageType(optionsMessageType);

    // Dedup: only for task-scoped messages (report/deliver) with a known taskId.
    // Reply type = conversational messages, never dedup. No taskId = no meaningful dedup key.
    const canDedup = messageType !== "reply" && !!taskId;
    let dedupKey: string | undefined;
    if (canDedup) {
      dedupKey = `${taskId}:${channelId ?? "none"}:${chatId ?? "none"}:${messageType}${dedupDiscriminator ? `:${dedupDiscriminator}` : ""}`;
      const cached = this._dedupCache.get(dedupKey);
      if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
        log.debug({ dedupKey }, "Dedup hit, returning cached log entry");
        return { success: true, logEntryId: cached.logEntryId };
      }
    }

    // Step b: Rate limit check
    if (channelId) {
      const now = Date.now();
      const windowMs = 60_000;
      let timestamps = this._rateLimitWindows.get(channelId);
      if (!timestamps) {
        timestamps = [];
        this._rateLimitWindows.set(channelId, timestamps);
      }
      // Remove old entries
      const cutoff = now - windowMs;
      while (timestamps.length > 0 && timestamps[0] < cutoff) {
        timestamps.shift();
      }
      if (timestamps.length >= 60) {
        const logEntryId = uuidv4();
        log.warn({ channelId, count: timestamps.length }, "Rate limited, not sending");
        // Phase 2 DP-002: rate limit is a confirmed terminal failure — receipt is appropriate.
        const rlTarget: DeliveryTarget = { type: "channel", channelId, chatId: chatId ?? "" };
        this._writeOutboundReceipt(options, rlTarget, content, "failure");
        return { success: false, logEntryId, error: "rate_limited" };
      }
      timestamps.push(now);
    }

    // Step c: Detect platform
    const resolvedPlatform = platform ?? (channelId ? getChannel(channelId)?.platform : undefined) ?? "unknown";

    // Step d: Format content (skip for webhooks — raw data)
    const formattedContent = webhookUrl ? content : formatForChannel(content, resolvedPlatform, taskId);

    // Step e: Create delivery log entry
    const logEntryId = uuidv4();
    const target: DeliveryTarget = (channelId && chatId)
      ? { type: "channel", channelId, chatId }
      : (webhookUrl ? { type: "webhook", webhookUrl } : { type: "channel", channelId: channelId ?? "", chatId: chatId ?? "" });
    const entry = {
      id: logEntryId,
      ruleId: undefined,
      taskId: taskId ?? undefined,
      status: "pending" as DeliveryStatus,
      target,
      content: formattedContent,
      attempts: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      source: "direct" as const,
      messageType,
    };
    createDeliveryLog(entry);

    // Optimistic dedup: claim the key before sending so concurrent sends for the same
    // task+channel+messageType are blocked. Cleared on failure to allow retries.
    if (dedupKey) {
      this._dedupCache.set(dedupKey, { logEntryId, timestamp: Date.now() });
    }

    try {
      const mediaValidationError = validateOutboundMediaUrl(mediaUrl);
      if (mediaValidationError) {
        updateDeliveryLogStatus(logEntryId, "failed", mediaValidationError);
        if (dedupKey) this._dedupCache.delete(dedupKey);
        serverBus.emit({
          type: "delivery_status_change",
          logEntryId,
          taskId,
          target: entry.target,
          status: "failed",
          error: mediaValidationError,
          messageType,
        });
        // Phase 2 DP-002: media validation failure
        this._writeOutboundReceipt(options, entry.target, content, "failure");
        return { success: false, logEntryId, error: mediaValidationError };
      }

      if (webhookUrl) {
        // Step f/g: Webhook path
        const response = await fetch(webhookUrl, {
          method: "POST",
          body: JSON.stringify({ result: content, taskId, timestamp: new Date().toISOString() }),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
          markDelivered(logEntryId);
          this._recordDeliveryLedgerAfterSuccess(options, entry.target, messageType, content);
          serverBus.emit({
            type: "delivery_status_change",
            logEntryId,
            taskId,
            target: entry.target,
            status: "delivered",
            messageType,
          });
          return { success: true, logEntryId };
        } else {
          const errMsg = `Webhook returned ${response.status}`;
          updateDeliveryLogStatus(logEntryId, "failed", errMsg);
          if (dedupKey) this._dedupCache.delete(dedupKey);
          serverBus.emit({
            type: "delivery_status_change",
            logEntryId,
            taskId,
            target: entry.target,
            status: "failed",
            error: errMsg,
            messageType,
          });
          return { success: false, logEntryId, error: errMsg };
        }
      } else if (channelId && chatId) {
        // Step f/g: Channel path. Use module-level cached import to avoid the
        // concurrent-import race where vitest's mock interceptor only intercepts
        // the first dynamic import.
        const { getChannelManager } = await loadChannelManagerModule();
        const mgr = getChannelManager();
        if (!mgr) {
          const errMsg = "ChannelManager not available";
          updateDeliveryLogStatus(logEntryId, "failed", errMsg);
          if (dedupKey) this._dedupCache.delete(dedupKey);
          serverBus.emit({
            type: "delivery_status_change",
            logEntryId,
            taskId,
            target: entry.target,
            status: "failed",
            error: errMsg,
            messageType,
          });
          // Phase 2 DP-002: ChannelManager unavailable failure
          this._writeOutboundReceipt(options, entry.target, content, "failure");
          return { success: false, logEntryId, error: errMsg };
        }

        const sendPayload = {
          content: formattedContent,
          messageType,
          ...(replyMarkup ? { replyMarkup } : {}),
          ...(replyToMessageId ? { replyToMessageId } : {}),
          ...(quoteExcerpt ? { quoteExcerpt } : {}),
          ...(quoteTitle ? { quoteTitle } : {}),
          ...(mediaUrl ? { mediaUrl } : {}),
          ...(mediaType ? { mediaType } : {}),
          ...(attachments ? { attachments } : {}),
        };

        const release = await this._acquireLane(channelId, chatId);
        let messageId: string | null;
        try {
          messageId = await mgr.sendMessage(channelId, chatId, sendPayload as import("../shared/types.js").OutboundMessage);
        } finally {
          release();
        }

        // ChannelManager returns null on send failure (adapter threw)
        if (messageId === null) {
          const errMsg = "Channel adapter send failed (returned null)";
          updateDeliveryLogStatus(logEntryId, "failed", errMsg);
          if (dedupKey) this._dedupCache.delete(dedupKey);
          serverBus.emit({
            type: "delivery_status_change",
            logEntryId,
            taskId,
            target: entry.target,
            status: "failed",
            error: errMsg,
            messageType,
          });
          // Phase 2 DP-002: adapter-null failure
          this._writeOutboundReceipt(options, entry.target, content, "failure");
          return { success: false, logEntryId, error: errMsg };
        }

        // Track for anti-loop
        if (messageId) {
          this._recentlySentIds.add(messageId);
          setTimeout(() => this._recentlySentIds.delete(messageId), 5 * 60 * 1000);
        }

        if (messageId?.startsWith("queued-")) {
          const errMsg = "queued_not_delivered";
          if (dedupKey) this._dedupCache.delete(dedupKey);
          serverBus.emit({
            type: "delivery_status_change",
            logEntryId,
            taskId,
            target: entry.target,
            status: "pending",
            error: errMsg,
            messageType,
          });
          return { success: false, messageId, logEntryId, error: errMsg };
        }

        markDelivered(logEntryId);
        this._recordDeliveryLedgerAfterSuccess(options, entry.target, messageType, content);
        // Phase 2 DP-002: confirmed channel delivery success
        this._writeOutboundReceipt(options, entry.target, content, "success");
        serverBus.emit({
          type: "delivery_status_change",
          logEntryId,
          taskId,
          target: entry.target,
          status: "delivered",
          messageType,
        });

        return { success: true, messageId: messageId ?? undefined, logEntryId };
      } else {
        const errMsg = "No channelId/chatId or webhookUrl provided";
        updateDeliveryLogStatus(logEntryId, "failed", errMsg);
        if (dedupKey) this._dedupCache.delete(dedupKey);
        return { success: false, logEntryId, error: errMsg };
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      updateDeliveryLogStatus(logEntryId, "failed", errorMessage);
      if (dedupKey) this._dedupCache.delete(dedupKey);
      serverBus.emit({
        type: "delivery_status_change",
        logEntryId,
        taskId,
        target: entry.target,
        status: "failed",
        error: errorMessage,
        messageType,
      });
      // Phase 2 DP-002: catch-all failure
      this._writeOutboundReceipt(options, entry.target, content, "failure");
      return { success: false, logEntryId, error: errorMessage };
    }
  }

  /**
   * Write an outbound_message effect receipt (Phase 2 DP-002).
   * Called at terminal-state-confirmed success and failure paths.
   * Skips webhook targets (no channelId) and skips gracefully when no trace context.
   */
  private _writeOutboundReceipt(
    options: OutboundSendOptions,
    target: DeliveryTarget,
    rawContent: string,
    outcome: "success" | "failure",
  ): void {
    if (target.type !== "channel" || !target.channelId) return;
    const traceId = getCurrentTraceId();
    if (!traceId) {
      log.debug({ taskId: options.taskId, channelId: target.channelId, outcome }, "Outbound receipt skipped: no active trace context");
      return;
    }
    const attachmentRefs = (options.attachments ?? [])
      .map((a) => a.artifactId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const toolName = options.actorToolName ?? "OutboundGateway.send";
    try {
      writeEffectReceipt({
        traceId,
        taskId: options.taskId,
        sessionId: options.sessionId,
        effectCategory: "outbound_message",
        verb: "send",
        entityType: "channel_message",
        target: {
          channelId: target.channelId,
          chatId: target.chatId,
          platform: options.platform,
        },
        payload: {
          textChars: rawContent.length,
          attachmentCount: options.attachments?.length ?? 0,
          attachmentRefs: attachmentRefs.length > 0 ? attachmentRefs : undefined,
        },
        actor: {
          traceId,
          toolName,
          taskId: options.taskId,
        },
        outcome,
      });
    } catch (err) {
      if (err instanceof InvalidReceiptError) {
        log.warn({ errors: err.errors, taskId: options.taskId, channelId: target.channelId }, "Outbound receipt validation failed");
      } else {
        log.warn({ error: err instanceof Error ? err.message : String(err), taskId: options.taskId }, "Outbound receipt write failed");
      }
    }
  }

  /**
   * Redeliver an execution's full artifact bundle to one or more channel targets.
   * Used by dispatch_outbound_batch and by template-executor's deliverTo loop (Task 4).
   *
   * Returns per-target delivery status including log entry ID for audit trail.
   */
  async redeliverExecutionTo(args: {
    executionId: string;
    targets: Array<{ channelId: string; chatId?: string }>;
    content: string;
    messageType?: MessageType | (string & {});
    fileArtifacts?: Artifact[];
    includeArtifacts?: boolean;
    actorToolName?: string;
    sessionId?: string;
    dedupDiscriminator?: string;
    /** Ready-to-ship attachments composed by the caller (delivery composer). When given, the
     *  gateway ships these as-is and does NOT build/select from artifacts; pass the matching raw
     *  artifacts in `fileArtifacts` so the email size-cap packer can size them. */
    attachments?: OutboundAttachment[];
  }): Promise<{
    deliveries: Array<{
      target: { channelId: string; chatId?: string };
      deliveryLogId: string;
      status: "delivered" | "failed";
      attachmentCount: number;
      error?: string;
    }>;
  }> {
    const includeArtifacts = args.includeArtifacts ?? true;
    const messageType = args.messageType ?? "result_delivery";
    const dedupDiscriminator = args.dedupDiscriminator ?? `redelivery:${Date.now()}`;
    const artifacts = includeArtifacts
      ? (args.fileArtifacts ?? getDeliverableFileArtifacts(args.executionId))
      : [];
    const attachments = args.attachments ?? (artifacts.length > 0 ? buildAttachmentsFromArtifacts(artifacts) : undefined);

    const deliveries: Array<{
      target: { channelId: string; chatId?: string };
      deliveryLogId: string;
      status: "delivered" | "failed";
      attachmentCount: number;
      error?: string;
    }> = [];

    for (const target of args.targets) {
      const channel = getChannel(target.channelId);
      if (!channel) {
        deliveries.push({
          target: { channelId: target.channelId, chatId: target.chatId },
          deliveryLogId: "",
          status: "failed",
          attachmentCount: 0,
          error: `Channel not found: ${target.channelId}`,
        });
        continue;
      }

      // Per-target packing for email channels. Non-email (WeChat, Telegram, etc.) use full set.
      let perTargetAttachments = attachments;
      let perTargetContent = args.content;
      if (channel.platform === "email" && attachments && attachments.length > 0) {
        const packOutcome = packForEmailTarget(
          target.channelId,
          target.chatId,
          artifacts,
          attachments,
          args.content,
        );
        if (!packOutcome.ok) {
          // First-item overflow: emit a per-target failure without calling this.send
          const logEntryId = uuidv4();
          const failTarget = { type: "channel" as const, channelId: target.channelId, chatId: target.chatId ?? "" };
          createDeliveryLog({
            id: logEntryId,
            ruleId: undefined,
            taskId: args.executionId,
            status: "pending" as const,
            target: failTarget,
            content: args.content,
            attempts: 0,
            createdAt: Date.now(),
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            source: "direct" as const,
            messageType: translateLegacyMessageType(messageType),
          });
          updateDeliveryLogStatus(logEntryId, "failed", packOutcome.error);
          deliveries.push({
            target: { channelId: target.channelId, chatId: target.chatId },
            deliveryLogId: logEntryId,
            status: "failed",
            attachmentCount: 0,
            error: packOutcome.error,
          });
          continue;
        }
        perTargetAttachments = packOutcome.result.perTargetAttachments;
        perTargetContent = packOutcome.result.perTargetContent;
      }

      const result = await this.send({
        taskId: args.executionId,
        sessionId: args.sessionId,
        channelId: target.channelId,
        chatId: target.chatId,
        content: perTargetContent,
        messageType,
        platform: channel.platform,
        attachments: perTargetAttachments,
        dedupDiscriminator,
        actorToolName: args.actorToolName,
      });
      deliveries.push({
        target: { channelId: target.channelId, chatId: target.chatId },
        deliveryLogId: result.logEntryId,
        status: result.success ? "delivered" : "failed",
        attachmentCount: perTargetAttachments?.length ?? 0,
        ...(result.error ? { error: result.error } : {}),
      });
    }

    return { deliveries };
  }

  private _recordDeliveryLedgerAfterSuccess(
    options: OutboundSendOptions,
    target: DeliveryTarget,
    messageType: string,
    rawContent: string,
  ): void {
    if (!isLedgerEligibleMessage(messageType, options.taskId)) return;

    try {
      const viewerKey = resolveLedgerViewerKey(options, target);
      if (!viewerKey) {
        recordAuditDiagnostic({
          source: "delivery_ledger",
          severity: "warning",
          sourceId: options.taskId,
          message: `Skipped user-visible delivery ledger write for ${messageType}: viewer identity unresolved`,
        });
        return;
      }

      const source = resolveLedgerSource(options.taskId!);
      const rawContentHash = hashContent(rawContent);
      recordUserVisibleDeliveryEvent({
        eventKey: `${viewerKey}|${source.sourceId}|${messageType}|${rawContentHash}`,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        taskId: options.taskId,
        templateId: source.templateId,
        templateName: source.templateName,
        messageType,
        viewerKey,
        title: source.templateName,
        contentPreview: rawContent,
        attachments: (options.attachments ?? []).map(attachmentToLedgerMetadata),
        targets: [deliveryTargetToVisibleTarget(target)],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ error: message, taskId: options.taskId, messageType }, "User-visible delivery ledger write failed");
      try {
        recordAuditDiagnostic({
          source: "delivery_ledger",
          severity: "error",
          sourceId: options.taskId,
          message,
        });
      } catch {
        // Diagnostics are best-effort and must not affect delivery success.
      }
    }
  }
}

function isLedgerEligibleMessage(messageType: string, taskId: string | undefined): taskId is string {
  if (!taskId) return false;
  return !["reply", "assistant_text", "user_message", "approval", "approval_prompt"].includes(messageType);
}

function resolveLedgerViewerKey(options: OutboundSendOptions, target: DeliveryTarget): ViewerKey | undefined {
  if (options.viewerKey) return options.viewerKey;
  if (target.type === "channel" && target.channelId) {
    return resolveViewerKeyForDeliveryTarget({ type: "channel", channelId: target.channelId, chatId: target.chatId });
  }
  return undefined;
}

function resolveLedgerSource(sourceId: string): {
  sourceType: "task" | "template_execution";
  sourceId: string;
  templateId?: string;
  templateName?: string;
} {
  const execution = getTemplateExecution(sourceId);
  if (!execution) {
    return { sourceType: "task", sourceId };
  }
  const template = getTaskTemplate(execution.templateId);
  return {
    sourceType: "template_execution",
    sourceId: execution.id,
    templateId: execution.templateId,
    templateName: template?.name,
  };
}

function attachmentToLedgerMetadata(attachment: OutboundAttachment): UserVisibleAttachment {
  return {
    artifactId: attachment.artifactId,
    locator: attachment.locator,
    filename: attachment.filename,
    mimeType: attachment.mimeType ?? attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    purpose: attachment.purpose,
    contentHash: attachment.contentHash,
  };
}

function deliveryTargetToVisibleTarget(target: DeliveryTarget): UserVisibleTarget {
  if (target.type === "webhook") {
    return { type: "webhook", webhookUrl: target.webhookUrl };
  }
  const channel = target.channelId ? getChannel(target.channelId) : undefined;
  return {
    type: "channel",
    channelId: target.channelId,
    chatId: target.chatId,
    label: channel?.name,
  };
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Module-level promise cache for the channels route module.
 *  Concurrent dynamic imports of the same ESM module can race in vitest's mock
 *  interceptor — only the first import resolves to the mocked module; subsequent
 *  imports may resolve to the real (unmocked) module, returning `undefined` from
 *  `getChannelManager()`. Caching one shared promise ensures all callers await
 *  the same resolution and observe the same module reference. */
let _channelManagerModulePromise: Promise<typeof import("../server/routes/channels.js")> | null = null;
function loadChannelManagerModule(): Promise<typeof import("../server/routes/channels.js")> {
  if (!_channelManagerModulePromise) {
    _channelManagerModulePromise = import("../server/routes/channels.js");
  }
  return _channelManagerModulePromise;
}

/** Reset the module-level cache. Test-only — vi.mock factories rebind on test
 *  isolation, so the cached module reference must be cleared between test files. */
export function _resetChannelManagerModuleCache(): void {
  _channelManagerModulePromise = null;
}

function validateOutboundMediaUrl(mediaUrl?: string): string | undefined {
  if (!mediaUrl) return undefined;
  if (mediaUrl.includes("://") && !mediaUrl.startsWith("file://")) return "mediaUrl must be a local file path";
  const localPath = mediaUrl.startsWith("file://") ? new URL(mediaUrl).pathname : mediaUrl;
  if (!isAbsolute(localPath)) return "mediaUrl must be absolute";
  if (!existsSync(localPath)) return "mediaUrl file does not exist";
  return undefined;
}

/** Translate legacy messageType to envelope kind for dedup-key + delivery_log consistency.
 *  Only `'report'` -> `'status_report'` and `'deliver'` -> `'result_delivery'`.
 *  Other values (including `'reply'`, `'approval'`, custom tags like `mistake_digest`) pass through unchanged. */
function translateLegacyMessageType(mt: string): string {
  if (mt === "report") return "status_report";
  if (mt === "deliver") return "result_delivery";
  return mt;
}

let _gateway: OutboundGateway | null = null;

export function getOutboundGateway(): OutboundGateway {
  if (!_gateway) _gateway = new OutboundGateway();
  return _gateway;
}

/**
 * Anti-loop check: is this message ID one we recently sent?
 * Delegates to the singleton gateway instance.
 */
export function isRecentlySent(id: string): boolean {
  return getOutboundGateway().isRecentlySent(id);
}
