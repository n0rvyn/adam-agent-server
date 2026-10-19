/**
 * Bree Engine — job scheduler for task templates with cron, manual, and event triggers.
 * Crystal ref: D-009 (Bree as task orchestration engine)
 */

import { getLogger } from "../lib/logger.js";
import { listTaskTemplates, getTaskTemplate, disableTaskTemplate } from "../store/task-templates.js";
import { getDefaults } from "../config/index.js";
import { listRoles } from "../store/roles.js";
import { cleanupMemories } from "../store/memories.js";
import { getGoal } from "../store/goals.js";
import { v4 as uuidv4 } from "uuid";
import { CronExpressionParser } from "cron-parser";
import type { TaskTemplate } from "../shared/types.js";
import { serverBus } from "../server/events/server-bus.js";
import { dispatchTemplate, type DispatchContext } from "./template-dispatch.js";

const log = getLogger("scheduler");

export class BreeEngine {
  private cronJobs = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;
  private templateExecutionCompletionHandler: ((event: { executionId: string; templateId: string; status: string }) => void) | null = null;

  async start(): Promise<void> {
    if (this.started) return; // Guard against duplicate start (verifier S1-A)
    this.started = true;

    // Schedule all enabled cron templates
    const templates = listTaskTemplates(true);
    let cronCount = 0;
    for (const template of templates) {
      if (template.trigger.type === "cron" && template.trigger.cron) {
        this.scheduleCronJob(template);
        cronCount++;
      }
    }

    // Recover one-shot scheduled templates
    let onceCount = 0;
    for (const template of templates) {
      if (template.trigger.type === "once" && template.trigger.runAt) {
        this.scheduleOnceJob(template.id);
        onceCount++;
      }
    }

    // Subscribe to TemplateExecution finalization events for template_complete:<templateId> triggers.
    this.templateExecutionCompletionHandler = (event) => {
      // Policy: partial counts as success here (chain to next template). Failure alerts handled
    // by DeliveryEngine on status === "failed" only. See delivery/engine.ts subscriber.
    if (event.status === "completed" || event.status === "partial") {
        this.checkTemplateCompleteTriggers(event.templateId).catch((err) => {
          log.error({ templateId: event.templateId, error: err }, "Template-complete trigger check failed");
        });
      }
    };
    serverBus.on("template_execution_status_change", this.templateExecutionCompletionHandler);

    // Schedule background memory cleanup (every hour)
    this.cronJobs.set("memory-cleanup", setInterval(() => {
      this.runMemoryCleanup();
    }, 3600000) as unknown as ReturnType<typeof setTimeout>);

    log.info({ cronCount, onceCount }, "Bree engine started with cron jobs + memory cleanup");
  }

  private runMemoryCleanup(): void {
    try {
      const roles = listRoles(undefined, 1000, 0);
      let totalCleaned = 0;
      for (const role of roles) {
        totalCleaned += cleanupMemories(role.id);
      }
      if (totalCleaned > 0) {
        log.info({ totalCleaned }, "Memory cleanup completed");
      }
    } catch (err) {
      log.warn({ error: err }, "Memory cleanup failed");
    }
  }

  async stop(): Promise<void> {
    for (const [, handle] of this.cronJobs) {
      clearTimeout(handle);
      clearInterval(handle as unknown as ReturnType<typeof setInterval>);
    }
    this.cronJobs.clear();
    if (this.templateExecutionCompletionHandler) {
      serverBus.off("template_execution_status_change", this.templateExecutionCompletionHandler);
      this.templateExecutionCompletionHandler = null;
    }
    this.started = false;
    log.info("Bree engine stopped");
  }

  /**
   * Schedule a cron job using cron-parser for accurate timing.
   * Uses setTimeout chains instead of setInterval for precise cron scheduling.
   */
  private scheduleCronJob(template: TaskTemplate): void {
    const jobName = `template-${template.id}`;

    // Remove existing if any
    if (this.cronJobs.has(jobName)) {
      clearTimeout(this.cronJobs.get(jobName)!);
      this.cronJobs.delete(jobName);
    }

    // Validate cron expression using cron-parser v5 API
    let cronExpr: ReturnType<typeof CronExpressionParser.parse>;
    try {
      cronExpr = CronExpressionParser.parse(template.trigger.cron!);
    } catch {
      log.warn({ templateId: template.id, cron: template.trigger.cron }, "Invalid cron expression");
      return;
    }

    const scheduleNext = (): number => {
      const next = cronExpr.next();
      const delay = next.getTime() - Date.now();
      return Math.max(delay, 1000); // minimum 1s to prevent tight loops
    };

    const runJob = () => {
      this.executeCronTrigger(template.id).catch((err) => {
        log.error({ templateId: template.id, error: err }, "Cron trigger failed");
      });
      // Reschedule for next occurrence — reuse same jobName key
      const nextTimeout = setTimeout(runJob, scheduleNext());
      this.cronJobs.set(jobName, nextTimeout);
    };

    // Initial delay
    const initialDelay = scheduleNext();
    const timeout = setTimeout(runJob, initialDelay);
    this.cronJobs.set(jobName, timeout);
    log.debug({ jobName, nextRun: new Date(Date.now() + initialDelay).toISOString() }, "Scheduled cron job");
  }

  private async executeCronTrigger(templateId: string): Promise<void> {
    const template = getTaskTemplate(templateId);
    if (!template || !template.enabled) return;

    log.info({ templateName: template.name }, "Cron triggered");
    await this.executeTemplateExecution(template, uuidv4());
  }

  async scheduleJob(templateId: string): Promise<void> {
    const template = getTaskTemplate(templateId);
    if (!template) return;
    if (template.trigger.type === "cron" && template.trigger.cron) {
      this.scheduleCronJob(template);
    }
  }

  async unscheduleJob(templateId: string): Promise<void> {
    const jobName = `template-${templateId}`;
    const handle = this.cronJobs.get(jobName);
    if (handle) {
      clearTimeout(handle);
      this.cronJobs.delete(jobName);
    }
  }

  /**
   * Execute template immediately (manual trigger).
   */
  async runNow(templateId: string, ctx?: DispatchContext): Promise<string> {
    const template = getTaskTemplate(templateId);
    if (!template) throw new Error(`Template ${templateId} not found`);

    const executionId = uuidv4();
    // Execute async — don't block the API response
    this.executeTemplateExecution(template, executionId, ctx).catch((err) => {
      log.error({ templateId, error: err }, "TemplateExecution failed");
    });

    return executionId;
  }

  /**
   * Check for template_complete triggers matching a finalized TemplateExecution.
   * Fires templates with trigger.event = 'template_complete:<templateId>'
   * when the completed TemplateExecution's Template matches.
   */
  async checkTemplateCompleteTriggers(completedTemplateId: string): Promise<void> {
    const templates = listTaskTemplates(true);
    const matches = templates.filter((t) => {
      if (t.trigger.type !== "template_complete" || !t.trigger.event) return false;
      return t.trigger.event === `template_complete:${completedTemplateId}`;
    });

    for (const template of matches) {
      log.info({ templateName: template.name, sourceTemplateId: completedTemplateId }, "Template-complete trigger matched");
      await this.executeTemplateExecution(template, uuidv4());
    }
  }

  private async executeTemplateExecution(
    template: TaskTemplate,
    executionId: string,
    ctx: DispatchContext = {},
  ): Promise<void> {
    await dispatchTemplate(template, {
      ...ctx,
      executionId,
      triggerContext: ctx.triggerContext ?? { source: "bree" },
    });
  }

  /**
   * Schedule a one-shot delayed task from a 'once' template.
   * Timer fires at trigger.runAt, executes the template execution, then disables the template.
   */
  scheduleOnceJob(templateId: string): void {
    const template = getTaskTemplate(templateId);
    if (!template || !template.enabled || template.trigger.type !== "once") return;

    const runAtMs = template.trigger.runAt ? new Date(template.trigger.runAt).getTime() : 0;
    const delay = runAtMs - Date.now();

    if (delay <= 0) {
      // Already past due — execute immediately
      log.info({ templateId, runAt: template.trigger.runAt }, "Once-shot template past due, executing immediately");
      this.executeOnceTrigger(templateId).catch((err) => {
        log.error({ templateId, error: err }, "Once trigger execution failed");
      });
      return;
    }

    const jobName = `template-${templateId}`;
    if (this.cronJobs.has(jobName)) {
      clearTimeout(this.cronJobs.get(jobName)!);
    }

    const timer = setTimeout(() => {
      this.cronJobs.delete(jobName);
      this.executeOnceTrigger(templateId).catch((err) => {
        log.error({ templateId, error: err }, "Once trigger execution failed");
      });
    }, delay);
    this.cronJobs.set(jobName, timer);
    log.info({ templateId, runAt: template.trigger.runAt, delayMs: delay }, "Scheduled once-shot job");
  }

  private async executeOnceTrigger(templateId: string): Promise<void> {
    const template = getTaskTemplate(templateId);
    if (!template || !template.enabled) return;

    log.info({ templateName: template.name }, "Once-shot triggered");
    await this.executeTemplateExecution(template, uuidv4());

    // Auto-disable after execution
    disableTaskTemplate(templateId);
    log.info({ templateId }, "Once-shot template auto-disabled after execution");
  }
}

let _breeInstance: BreeEngine | null = null;
export function getBreeEngine(): BreeEngine | null { return _breeInstance; }
export function setBreeEngine(engine: BreeEngine): void { _breeInstance = engine; }
