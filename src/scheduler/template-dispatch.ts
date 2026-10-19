/**
 * Shared template dispatch logic used by both BreeEngine and EventDispatcher.
 * Extracted from BreeEngine.executeTemplateExecution (DP-001: A).
 */

import { TemplateExecutor } from "./template-executor.js";
import { updateTaskTemplate } from "../store/task-templates.js";
import { listSessions } from "../store/sessions.js";
import { getMessagesBySession } from "../store/messages.js";
import { v4 as uuidv4 } from "uuid";
import { getLogger } from "../lib/logger.js";
import type { NotifyTarget, TaskTemplate, TaskStep } from "../shared/types.js";

const log = getLogger("scheduler");

const templateExecutor = new TemplateExecutor();

// ---------------------------------------------------------------------------
// Feature-mining pre-fetch guard (DP-V.4 §5)
// ---------------------------------------------------------------------------

/** In-flight dispatch guard: prevents concurrent runs of the same template. */
const inflightDispatches = new Map<string, Promise<TaskTemplate>>();

/**
 * Pre-fetches chat sessions modified since last_run_at and substitutes placeholders
 * into the feature-mining template before dispatch.
 *
 * Guard: if a dispatch for the same templateId is already in flight, throws
 * "already in flight" without mutating last_run_at.
 *
 * Pre-fetch: lists sessions from src/store/sessions.ts (not session-manager.ts),
 * filters in-memory by lastActiveAt > last_run_at, fetches messages per session
 * from src/store/messages.ts (getMessagesBySession), truncates each message
 * content to message_char_cap chars.
 *
 * Substitution: replaces {{CHAT_DATA}} and {{LAST_RUN_AT_HUMAN}} in each step.prompt.
 * Operates on a cloned template — original is not mutated.
 *
 * Does NOT execute or write back — those happen in dispatchTemplate after this returns.
 */
async function renderFeatureMiningTemplate(
  template: TaskTemplate,
): Promise<TaskTemplate> {
  if (inflightDispatches.has(template.id)) {
    log.warn({ templateId: template.id }, "Feature-mining dispatch already in flight");
    throw new Error("already in flight");
  }

  const promise = doRenderFeatureMiningTemplate(template);
  inflightDispatches.set(template.id, promise);
  try {
    return await promise;
  } finally {
    inflightDispatches.delete(template.id);
  }
}

async function doRenderFeatureMiningTemplate(
  template: TaskTemplate,
): Promise<TaskTemplate> {
  const config = (template.config ?? {}) as Record<string, unknown>;
  const lastRunAt = config.last_run_at as number | null ?? null;
  // DP-006: enforce hard ceilings in the dispatcher (defense-in-depth beyond Settings UI)
  const rawMaxSessions = (config.max_sessions as number) ?? 15;
  const rawMaxMessages = (config.max_messages_per_session as number) ?? 30;
  const rawCharCap = (config.message_char_cap as number) ?? 500;
  const maxSessions = Math.min(rawMaxSessions, 50);
  const maxMessagesPerSession = Math.min(rawMaxMessages, 100);
  const messageCharCap = Math.min(rawCharCap, 2000);
  if (maxSessions !== rawMaxSessions || maxMessagesPerSession !== rawMaxMessages || messageCharCap !== rawCharCap) {
    log.warn(
      { templateId: template.id, rawMaxSessions, rawMaxMessages, rawCharCap, maxSessions, maxMessagesPerSession, messageCharCap },
      "Feature-mining caps clamped to hard ceilings (50/100/2000)",
    );
  }

  // Fetch sessions modified since last_run_at
  const sessions = listSessions(undefined, maxSessions, 0);
  const recentSessions = sessions.filter(
    (s) => lastRunAt === null || s.lastActiveAt > lastRunAt,
  );

  // Build chat excerpts
  const excerpts: string[] = [];
  for (const session of recentSessions) {
    const messages = getMessagesBySession(session.id, maxMessagesPerSession, 0);
    for (const msg of messages) {
      const truncated = msg.content.length > messageCharCap
        ? msg.content.slice(0, messageCharCap) + " [...truncated]"
        : msg.content;
      excerpts.push(
        `[${new Date(msg.createdAt).toLocaleString()}] ${msg.role}: ${truncated}`,
      );
    }
  }

  const chatData = excerpts.length > 0 ? excerpts.join("\n") : "No new sessions.";
  const lastRunHuman = lastRunAt
    ? new Date(lastRunAt).toLocaleString()
    : "the beginning of recorded history";

  // Clone template and substitute placeholders in step.prompt
  const substitutedSteps: TaskStep[] = template.steps.map((step) => ({
    ...step,
    prompt: step.prompt
      .replace(/\{\{CHAT_DATA\}\}/g, chatData)
      .replace(/\{\{LAST_RUN_AT_HUMAN\}\}/g, lastRunHuman),
  }));

  const substitutedTemplate: TaskTemplate = {
    ...template,
    steps: substitutedSteps,
  };

  log.info(
    { templateId: template.id, sessionCount: recentSessions.length, lastRunAt },
    "Feature-mining template rendered",
  );

  return substitutedTemplate;
}

export interface DispatchContext {
  /** Externally-allocated executionId for log/task correlation. If absent, dispatchTemplate allocates one. */
  executionId?: string;
  /** Chat-origin status report target for ad-hoc run_template calls without explicit reportTo. */
  originReportTo?: NotifyTarget[];
  /** Opaque context passed by the caller (cron / template_complete / event). */
  triggerContext?: { source?: string; eventId?: string; payload?: unknown; [k: string]: unknown };
}

export async function dispatchTemplate(
  template: TaskTemplate,
  ctx: DispatchContext = {},
): Promise<void> {
  const executionId = ctx.executionId ?? uuidv4();
  log.info({ templateName: template.name, executionId, trigger: ctx.triggerContext }, "Dispatching template");

  // Feature-mining: pre-fetch chat sessions and substitute placeholders before dispatch.
  // DP-002: capture new_last_run_at BEFORE execute so events arriving during execution are not lost.
  let renderedTemplate: TaskTemplate = template;
  let featureMiningDispatchAt: number | null = null;
  if (template.presetId === "feature-mining") {
    try {
      renderedTemplate = await renderFeatureMiningTemplate(template);
      featureMiningDispatchAt = Date.now();
    } catch (err) {
      if ((err as Error).message === "already in flight") {
        log.warn({ templateId: template.id }, "Skipping feature-mining dispatch — already in flight");
        return;
      }
      throw err;
    }
  }

  const result = await templateExecutor.execute(renderedTemplate, executionId, {
    eventId: ctx.triggerContext?.eventId,
    originReportTo: ctx.originReportTo,
    triggerContext: ctx.triggerContext,
  });

  // DP-002: Write back last_run_at ONLY on successful completion or partial success.
  // On failure (status "failed" or "cancelled") last_run_at is preserved so retry re-scans the same window.
  if (template.presetId === "feature-mining" && featureMiningDispatchAt !== null) {
    if (result.status === "completed" || result.status === "partial") {
      try {
        updateTaskTemplate(template.id, {
          config: { ...(template.config ?? {}), last_run_at: featureMiningDispatchAt } as Record<string, unknown>,
        });
        log.info({ templateId: template.id, last_run_at: featureMiningDispatchAt }, "Feature-mining last_run_at updated");
      } catch (err) {
        // Log but do not propagate — next run re-scans same window
        log.error({ templateId: template.id, err }, "Failed to write back feature-mining last_run_at");
      }
    } else {
      log.warn(
        { templateId: template.id, status: result.status },
        "Feature-mining execute did not succeed; last_run_at preserved for retry",
      );
    }
  }

  log.info({
    templateName: template.name,
    executionId,
    status: result.status,
    steps: result.stepResults.size,
  }, "TemplateExecution finished");
}
