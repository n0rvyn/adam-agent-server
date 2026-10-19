/**
 * DeliveryEngine — event-driven delivery rules execution (D-001).
 *
 * Subscribes to serverBus events, matches against delivery_rules,
 * executes delivery with retry/dead-letter/TTL.
 *
 * Runs in main process (same as serverBus).
 */

import { serverBus } from "../server/events/server-bus.js";
import { findMatchingRules } from "../store/delivery-rules.js";
import { createDeliveryLog, markDelivered, updateDeliveryLogStatus, getPendingDeliveries, getFailedDeliveries, cleanupExpired, TTL_MS } from "../store/delivery-log.js";
import { getTask } from "../store/tasks.js";
import { findMessageByTaskId } from "../store/messages.js";
import { getSession } from "../store/sessions.js";
import { getLogger } from "../lib/logger.js";
import { v4 as uuidv4 } from "uuid";
import { getOutboundGateway } from "./outbound-gateway.js";
import { getChannel } from "../store/channels.js";
import { getTemplateExecution } from "../store/template-executions.js";
import { getTaskTemplate } from "../store/task-templates.js";
import type { DeliveryRule, DeliveryTarget, DeliveryLogEntry, ExecutionPlan } from "../shared/types.js";
import { formatPlanForChannel } from "../channels/approval-handler.js";
import { getDefaultChatIdForChannel } from "../channels/target-resolution.js";
import { isTemplateExecutionStepTask } from "../lib/template-execution-task.js";

const log = getLogger("admin");

// Rate limiting: sliding window per rule (D-006)
const rateLimitWindows = new Map<string, number[]>();

let retryIntervalId: ReturnType<typeof setInterval> | null = null;
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
let engineInstance: DeliveryEngine | null = null;

export class DeliveryEngine {
  constructor() {
    // Subscribe to serverBus events
    serverBus.on("task_status_change", (event) => {
      if (event.newStatus === "completed" || event.newStatus === "failed") {
        this.handleTaskStatusChange(event.taskId, event.newStatus).catch((err) => {
          log.error({ taskId: event.taskId, error: err }, "Delivery processing failed");
        });
      }
    });

    serverBus.on("plan_approval_request", (event) => {
      this.handlePlanApprovalRequest(event.taskId, event.planId, event.plan).catch((err) => {
        log.error({ taskId: event.taskId, error: err }, "Delivery processing failed (plan_approval)");
      });
    });

    // Policy: partial is success-semantic (chains to next template via bree-engine.ts:50).
    // Only true failure (no partial output) emits a user-visible failure alert.
    serverBus.on("template_execution_status_change", (event) => {
      if (event.status === "failed") {
        this.handleTemplateExecutionFailure(event.executionId, event.templateId).catch((err) => {
          log.error({ executionId: event.executionId, error: err }, "Template failure delivery processing failed");
        });
      }
    });

    log.info("DeliveryEngine initialized");
  }

  /**
   * Handle plan_approval_request events for delivery rules matching this event type.
   */
  private async handlePlanApprovalRequest(taskId: string, planId: string, plan: unknown): Promise<void> {
    const task = getTask(taskId);

    // Look up source channel for this task
    const sourceChannel = this.getSourceChannelForTask(taskId);

    if (sourceChannel) {
      // Route interactive approval to the originating channel
      const planSummary = formatPlanForChannel(plan as ExecutionPlan);
      const { sendApprovalToChannel } = await import("../channels/approval-handler.js");
      await sendApprovalToChannel(
        sourceChannel.channelId,
        sourceChannel.chatId,
        planId,
        taskId,
        planSummary,
      );
    }

    // No source channel or no manager: fall through to delivery rules
    const content = formatPlanForChannel(plan as ExecutionPlan) + `\n\nTask: ${taskId}`;
    await this.matchAndDeliver("plan_approval_request", {
      templateId: task?.templateId,
      roleId: task?.roleId,
      prompt: task?.prompt,
      taskStatus: "pending",
    }, content, taskId);
  }

  /**
   * Handle template execution failure events for delivery rule matching.
   * Called only when status === "failed" (partial is success-semantic — see bree-engine.ts:50).
   */
  private async handleTemplateExecutionFailure(
    executionId: string,
    templateId: string,
  ): Promise<void> {
    const exec = getTemplateExecution(executionId);
    const template = templateId ? getTaskTemplate(templateId) : null;
    const failedSteps = exec ? Object.entries(exec.stepStatuses).filter(([, s]) => s.status === "failed") : [];
    const content = [
      `⚠️ TemplateExecution failed`,
      `Template: ${template?.name ?? templateId}`,
      `Execution: ${executionId}`,
      `Failed steps: ${failedSteps.map(([id]) => id).join(", ") || "(unknown — no failed step recorded)"}`,
      failedSteps[0]?.[1]?.error ? `\nFirst error: ${failedSteps[0][1].error.slice(0, 300)}` : "",
    ].filter(Boolean).join("\n");

    await this.matchAndDeliver(
      "template_execution_failed",
      {
        templateId,
        roleId: undefined,
        prompt: undefined, // template failures have no prompt; excludePromptPatterns won't apply
        taskStatus: "failed",
      },
      content,
      /* taskId */ undefined, // executionId is NOT a taskId — keep distinct
      /* executionId */ executionId, // new param, stored in delivery_log.execution_id
    );
  }

  /**
   * Returns the source channel info for a task, or null if not from a channel.
   */
  private getSourceChannelForTask(taskId: string): { channelId: string; chatId: string } | null {
    try {
      const message = findMessageByTaskId(taskId);
      if (!message) return null;
      const session = getSession(message.sessionId);
      if (!session) return null;
      if (session.source.type !== "channel") return null;
      if (!session.source.channelId || !session.source.chatId) return null;
      return { channelId: session.source.channelId, chatId: session.source.chatId };
    } catch {
      return null;
    }
  }

  /**
   * Handle task completion/failure — hydrate context and match rules (S1-1 fix).
   */
  private async handleTaskStatusChange(taskId: string, newStatus: string): Promise<void> {
    const task = getTask(taskId);
    if (!task) return;

    if (isTemplateExecutionStepTask(task)) {
      log.debug({ taskId, templateId: task.templateId, stepId: task.stepId }, "Skipping delivery for TemplateExecution step task");
      return;
    }

    // DP-007: skip delivery for contract-verifier tasks to prevent recursion
    if (task.config?.taskType === "contract-verifier") {
      log.debug({ taskId }, "Skipping delivery for contract-verifier task");
      return;
    }

    const context = {
      templateId: task.templateId,
      roleId: task.roleId,
      prompt: task.prompt,
      taskStatus: newStatus,
    };
    const eventType = newStatus === "completed" ? "task_complete" : "task_error";
    const content = task.result ?? task.error ?? "";

    await this.matchAndDeliver(eventType, context, content, taskId);
  }

  /**
   * Find matching rules and deliver to each target.
   */
  private async matchAndDeliver(
    eventType: string,
    context: { templateId?: string; roleId?: string; prompt?: string; taskStatus?: string },
    content: string,
    taskId?: string,
    executionId?: string,
  ): Promise<void> {
    const rules = findMatchingRules(eventType, context);
    if (rules.length === 0) return;

    log.debug({ eventType, ruleCount: rules.length, taskId }, "Matched delivery rules");

    for (const rule of rules) {
      // Rate limit check (D-006)
      if (!this.checkRateLimit(rule)) {
        log.warn({ ruleId: rule.id, maxPerMinute: rule.maxPerMinute }, "Delivery rate limit exceeded, skipping");
        continue;
      }

      // Dedup: skip if task originated from same channel (S2-R2 fix)
      if (rule.skipOriginChannel && rule.target.type === "channel" && taskId) {
        if (this.isOriginChannel(taskId, rule.target)) continue;
      }

      // Create log entry
      const logEntry: DeliveryLogEntry = {
        id: uuidv4(),
        ruleId: rule.id,
        taskId,
        executionId,
        status: "pending",
        target: rule.target,
        content,
        attempts: 0,
        createdAt: Date.now(),
        expiresAt: Date.now() + TTL_MS,
        source: "rule",
      };
      createDeliveryLog(logEntry);

      // Attempt delivery
      await this.attemptDelivery(logEntry, rule);
    }
  }

  /**
   * Public wrapper for test route.
   */
  async attemptDeliveryPublic(entry: DeliveryLogEntry, rule: DeliveryRule): Promise<void> {
    return this.attemptDelivery(entry, rule);
  }

  /**
   * Attempt delivery to a target. Delegates to OutboundGateway (D-004).
   */
  private async attemptDelivery(entry: DeliveryLogEntry, rule: DeliveryRule): Promise<void> {
    const gateway = getOutboundGateway();
    try {
      if (entry.target.type === "channel") {
        // Resolve chatId from channel config when rule target only has channelId
        let chatId = entry.target.chatId;
        if (!chatId && entry.target.channelId) {
          const ch = getChannel(entry.target.channelId);
          chatId = ch ? getDefaultChatIdForChannel(ch) : undefined;
        }
        const result = await gateway.send({
          taskId: entry.taskId,
          channelId: entry.target.channelId,
          chatId,
          content: entry.content,
          messageType: "deliver",
        });
        if (result.success) {
          markDelivered(entry.id);
          log.info({ entryId: entry.id, ruleId: rule.id, targetType: "channel" }, "Delivery successful");
        } else {
          updateDeliveryLogStatus(entry.id, "failed", result.error ?? "Gateway returned failure");
        }
      } else if (entry.target.type === "webhook") {
        const result = await gateway.send({
          taskId: entry.taskId,
          webhookUrl: entry.target.webhookUrl,
          content: entry.content,
          messageType: "deliver",
        });
        if (result.success) {
          markDelivered(entry.id);
          log.info({ entryId: entry.id, ruleId: rule.id, targetType: "webhook" }, "Webhook delivery successful");
        } else {
          updateDeliveryLogStatus(entry.id, "failed", result.error ?? "Gateway returned failure");
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      updateDeliveryLogStatus(entry.id, "failed", errorMsg);
      log.warn({ entryId: entry.id, error: errorMsg }, "Delivery attempt failed");
    }
  }

  /**
   * Rate limit check — sliding window (D-006).
   */
  private checkRateLimit(rule: DeliveryRule): boolean {
    const now = Date.now();
    const windowMs = 60_000;
    let timestamps = rateLimitWindows.get(rule.id);

    if (!timestamps) {
      timestamps = [];
      rateLimitWindows.set(rule.id, timestamps);
    }

    // Remove old entries outside window
    const cutoff = now - windowMs;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= rule.maxPerMinute) {
      return false;
    }

    timestamps.push(now);
    return true;
  }

  /**
   * Check if task originated from the same channel as the delivery target (S2-R2 dedup).
   * Uses the task's chat message to look up the source session's channel IDs.
   * Returns true if the delivery target matches the origin — caller should skip delivery.
   */
  private isOriginChannel(taskId: string, target: DeliveryTarget): boolean {
    try {
      if (target.type !== "channel" || !target.channelId) return false;

      const message = findMessageByTaskId(taskId);
      if (!message) return false;

      const session = getSession(message.sessionId);
      if (!session) return false;

      return (
        session.source.type === "channel" &&
        session.source.channelId === target.channelId &&
        (!target.chatId || session.source.chatId === target.chatId)
      );
    } catch {
      return false;
    }
  }

  /**
   * Retry pending and failed deliveries (D-004, D-005).
   */
  async retryPending(): Promise<void> {
    // Only retry rule-sourced entries; Gateway retries its own direct/tool entries
    const pending = getPendingDeliveries("rule", 50);
    const failed = getFailedDeliveries("rule", 50);
    const toRetry = [...pending, ...failed];

    if (toRetry.length === 0) return;

    log.debug({ count: toRetry.length }, "Retrying pending/failed deliveries");

    for (const entry of toRetry) {
      if (entry.attempts >= 3) {
        // Dead letter — mark as failed permanently
        updateDeliveryLogStatus(entry.id, "failed", "Max retries (3) exceeded");
        continue;
      }

      // Re-attempt
      const rule: DeliveryRule = {
        id: entry.ruleId ?? "retry-synthetic",
        eventType: "*",
        matchCriteria: {},
        target: entry.target,
        maxPerMinute: 5,
        skipOriginChannel: true,
        enabled: true,
        createdAt: 0,
      };
      await this.attemptDelivery(entry, rule);
    }
  }
}

export function getDeliveryEngine(): DeliveryEngine | null {
  return engineInstance;
}

/**
 * Initialize DeliveryEngine and start periodic timers.
 */
export function initDeliveryEngine(): void {
  if (engineInstance) return;

  engineInstance = new DeliveryEngine();

  // Retry pending deliveries every 60s
  retryIntervalId = setInterval(() => {
    engineInstance?.retryPending().catch((err) => {
      log.error({ error: err }, "Delivery retry scan failed");
    });
  }, 60_000);

  // Cleanup expired entries every hour
  cleanupIntervalId = setInterval(() => {
    try {
      const cleaned = cleanupExpired();
      if (cleaned > 0) {
        log.info({ cleaned }, "Expired delivery log entries cleaned up");
      }
    } catch (err) {
      log.error({ error: err }, "Delivery cleanup failed");
    }
  }, 3600_000);

  log.info("DeliveryEngine started with retry (60s) and cleanup (1h) timers");
}

/**
 * Stop DeliveryEngine and clear timers.
 */
export function stopDeliveryEngine(): void {
  if (retryIntervalId) { clearInterval(retryIntervalId); retryIntervalId = null; }
  if (cleanupIntervalId) { clearInterval(cleanupIntervalId); cleanupIntervalId = null; }
  // Note: serverBus listeners persist but check engineInstance === null guard.
  // Node.js EventEmitter doesn't support removing anonymous arrow function listeners easily.
  // The handlers will be no-ops since engineInstance is nulled and methods are bound to the old instance.
  engineInstance = null;
  rateLimitWindows.clear();
  log.info("DeliveryEngine stopped");
}
