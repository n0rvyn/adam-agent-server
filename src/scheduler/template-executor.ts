/**
 * TemplateExecution Executor — handles multi-step task template execution with
 * layer-based parallel dispatch, per-step role assignment, dependency ordering,
 * output chaining, continueOnError + skip_dependents, and retry with
 * exponential backoff.
 *
 * Crystal ref: D-001, D-002, D-003, D-006, D-S01 (Issue #154)
 */

import { getLogger } from "../lib/logger.js";
import { getTask, updateTaskConfig } from "../store/tasks.js";
import { getRole, getRoleByName } from "../store/roles.js";
import { updateGoal } from "../store/goals.js";
import { getDb } from "../store/db.js";
import { createTaskWithAdmission } from "../lib/task-dispatch.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureArtifactsDir,
  cleanSlatePriorAttempt,
  captureTextArtifact,
} from "../lib/artifact-storage.js";
import { isTextCapturable, stepRequiresFileArtifact, stepIsPureStructuredOutput, isInternalSentinel, isValidDeliverable } from "../lib/resolve-contract-rules.js";
import { getChannel } from "../store/channels.js";
import { getDefaults } from "../config/index.js";
import { getOutboundGateway, type OutboundSendOptions } from "../delivery/outbound-gateway.js";
import { deliverAssistantMessageToSession } from "../chat/session-delivery.js";
import { getDefaultChatIdForChannel } from "../channels/target-resolution.js";
import { listSessions } from "../chat/session-manager.js";
import { checkDeliveryCompleteness } from "../lib/delivery-completeness.js";
import {
  createTemplateExecution,
  getTemplateExecution,
  updateTemplateExecution,
  type TemplateExecutionStepStatus,
} from "../store/template-executions.js";
import {
  getArtifact,
  createArtifact,
  listArtifactsByExecution,
  type Artifact,
} from "../store/artifacts.js";
import { createDeliveryLog, TTL_MS } from "../store/delivery-log.js";
import { insertEditorScores, parseEditorScoreCandidates, markSelectedByScore } from "../store/editor-scores.js";
import type { ArtifactCollectionManifest, NotifyTarget, TaskTemplate, TaskStep, TaskConfig, StepResult, TemplateExecutionResult } from "../shared/types.js";
import { v4 as uuidv4 } from "uuid";
import { serverBus } from "../server/events/server-bus.js";
import { getConfigValue } from "../store/config.js";
import { withNewTrace } from "../lib/trace-context.js";
import {
  expandGoalTemplateSteps,
  parseGoalReviewResult,
  type GoalExecutionStepMeta,
} from "./goal-template-expansion.js";
import type { Goal } from "../shared/types.js";
import { assemblePrompt, assembleUpstreamArtifactsBlock, MissingRequiredArtifactError, truncateArtifactContent } from "./prompt-assembler.js";
import { waitForTaskCompletion } from "./wait-for-task.js";
import { runLayerA, runLayerB, type LayerAResult, type LayerBResult } from "../audit/contract-verifier.js";
import { runCustomAssertionsCheck } from "../audit/assertion-judge.js";
import { getStepOutput, StepOutputBinaryError } from "../lib/step-output.js";
import { persistClaimsFromArtifactValue, settlePredictionsFromArtifactValue, findDuePredictions, checkSettlementCompleteness } from "../agent/belief-ledger.js";
import { recordAuditViolation } from "../store/audit-violations.js";
import type { AuditViolation, Role } from "../shared/types.js";
import {
  assembleSummary,
  tryAssembleFallbackDelivery,
  primaryArtifactFileAttachments,
} from "./template-summary-assembler.js";
import { setExecutionStepResults } from "../store/template-executions.js";
import {
  getDeliverableFileArtifacts,
} from "../lib/artifact-attachments.js";
import { composeDeliveryFromManifest } from "../delivery/compose-delivery.js";
import { getTaskFiles } from "../store/task-files.js";

/** Exported for direct unit test coverage of bigint/KB/null branches. */
export function formatSize(bytes: number | bigint | null): string {
  if (bytes === null) return "size unknown";
  const n = typeof bytes === "bigint" ? Number(bytes) : bytes;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function buildNudgePrompt(opts: {
  priorTaskId: string;
  outputAs: string;
  maxTurns?: number;
}): string {
  const { priorTaskId, outputAs, maxTurns = 50 } = opts;
  const taskFiles = getTaskFiles(priorTaskId).filter((r) => r.op !== "deleted");
  const filePaths = taskFiles.map((r) => `${r.path}  (${r.op}, ${formatSize(r.size_bytes)})`);

  return [
    `# Corrective Step — final attempt before failure`,
    ``,
    `Your previous task (\`${priorTaskId}\`) for this TemplateExecution step ended without publishing the required artifact \`${outputAs}\`. This was needed for the pipeline to continue.`,
    ``,
    `## What this list means`,
    ``,
    `Below is the **exhaustive** list of files your previous task wrote or modified (sourced from the platform's workspace-snapshot diff). If a file is not on this list, your previous task did not create it. Files in your workspace that are NOT on this list are leftovers from prior executions — publishing them as "${outputAs}" is forbidden and will deliver wrong content to users.`,
    ``,
    `Files from your previous task:`,
    ...(filePaths.length > 0
      ? filePaths.map((p) => `   - \`${p}\``)
      : ["   (the previous task wrote no files)"]),
    ``,
    `## Your two equal options`,
    ``,
    `Pick ONE of the following — both are valid; neither is a fallback for the other:`,
    ``,
    `**Option A — Publish from the list above.** If a file in the list above is actually a complete, correct version of "${outputAs}", call:`,
    `\`publish_artifact_file({key: "${outputAs}", sourcePath: "<path from list above>"})\``,
    `(For a JSON-shaped artifact instead of a file: \`write_artifact({key: "${outputAs}", value: <JSON>})\`.)`,
    ``,
    `**Option B — Declare no content.** If the list above contains nothing that is a complete, correct "${outputAs}" (e.g., your previous task crashed mid-work, hit a quota, or all data sources were unreachable), call:`,
    `\`write_artifact({key: "${outputAs}", value: {status: "no_content", reason: "<short reason>"}})\``,
    ``,
    `## What is forbidden`,
    ``,
    `- Publishing any file NOT in the list above — including any file with a "today's date" filename, any \`.mp3\`/\`.md\`/\`.json\` already in your workspace from a prior execution, or anything you find via \`ls\` of the workspace directory. Do not search, scan, browse, or ls the workspace beyond what is listed above.`,
    `- Re-doing the entire collection/generation work — you have ${maxTurns} turns, just enough to publish or declare. Use what your previous task already produced; if it produced nothing usable, take Option B.`,
  ].join("\n");
}


export interface TemplateExecutionContext {
  templateId: string;
  templateName: string;
  /** Full template object — required for delivery config access in assembleTemplateExecutionSummary. */
  template: TaskTemplate;
  executionId: string;
  stepResults: Map<string, StepResult>;
  stepStatuses: Record<string, TemplateExecutionStepStatus>;
  config: TaskConfig;
  continueOnError: boolean;
  failedStepIds: Set<string>;
  rolePreference?: string;
  deliverTo?: NotifyTarget[];
  reportTo?: NotifyTarget[];
  /** DP-4.8: flows template.config.delivery_message_type to gw.send(messageType). */
  deliveryMessageType?: string;
  goalSteps: GoalExecutionStepMeta[];
  triggerContext?: { source?: string; [k: string]: unknown };
  /** Phase 4: validator retry policy surfaced from template.retryPolicy for the dispatch loop. */
  templateRetryPolicy?: { maxAttempts: number };
}

// Re-exported from template-summary-assembler for backward compat with existing test imports
export { PrimaryArtifactNotFoundError, DeliveryNotImplementedError } from "./template-summary-assembler.js";

const log = getLogger("scheduler");

/**
 * Count how many contract sub-fields are actually checked for a given step.
 * Used by both the original-task and retry-task `outputContractCheckCount` writes,
 * so they stay in sync. Adding a new contract dimension means editing only here.
 */
function countCheckedContracts(step: TaskStep): number {
  const rules = step.outputContract?.contractRules ?? [];
  return (
    (rules.some((r) => r.kind === "lengthTarget") ? 1 : 0)
    + (rules.some((r) => r.kind === "format") ? 1 : 0)
    + (step.persona?.speakAs ? 1 : 0)
    + (step.outputContract?.mustReferenceArtifacts === true ? 1 : 0)
    + (step.outputContract?.customAssertions && step.outputContract.customAssertions.length > 0 ? 1 : 0)
  );
}

export class TemplateExecutor {
  private maxRetries: number;
  private baseDelayMs: number;

  constructor(options?: { maxRetries?: number; baseDelayMs?: number }) {
    this.maxRetries = options?.maxRetries ?? 2;
    this.baseDelayMs = options?.baseDelayMs ?? 1000;
  }

  private persistStepStatuses(executionId: string, context: TemplateExecutionContext): void {
    updateTemplateExecution(executionId, {
      stepStatuses: context.stepStatuses,
    });
  }

  async execute(template: TaskTemplate, executionId: string, opts?: { eventId?: string; originReportTo?: NotifyTarget[]; triggerContext?: { source?: string; [k: string]: unknown } }): Promise<TemplateExecutionResult> {
    const goalExpansion = expandGoalTemplateSteps(template);
    const executionSteps = goalExpansion.steps;
    const defaults = getDefaults();
    const config: TaskConfig = {
      timeout: (template.config?.timeout as number) ?? defaults.timeout,
      approvalRequired: defaults.approvalRequired,
      approvalTimeout: defaults.approvalTimeout,
      plugins: template.config?.plugins as string[] | undefined,
      mcpServers: template.config?.mcpServers as Record<string, unknown> | undefined,
      model: (template.config?.model as string) ?? defaults.model,
      effortTier: template.config?.effortTier as "low" | "medium" | "high" | undefined,
      maxTurns: (template.config?.maxTurns as number) ?? defaults.maxTurns,
      maxBudgetUsd: (template.config?.maxBudgetUsd as number) ?? defaults.maxBudgetUsd,
      env: {
        ...defaults.env,
        ...(template.config?.env as Record<string, string> | undefined),
      },
      claudeCodePath: defaults.claudeCodePath,
    };

    const _deliveryMsgType = typeof (template.config as { delivery_message_type?: unknown } | undefined)?.delivery_message_type === "string"
      ? ((template.config as { delivery_message_type: string }).delivery_message_type.length > 0
          ? (template.config as { delivery_message_type: string }).delivery_message_type
          : undefined)
      : undefined;
    const context: TemplateExecutionContext = {
      templateId: template.id,
      templateName: template.name,
      template,
      executionId,
      stepResults: new Map(),
      stepStatuses: {},
      config,
      continueOnError: template.config?.continueOnError ?? false,
      failedStepIds: new Set(),
      rolePreference: template.rolePreference,
      deliverTo: template.deliverTo,
      reportTo: (() => {
        if (template.reportTo && template.reportTo.length > 0) return template.reportTo;
        if (opts?.originReportTo) return opts.originReportTo;
        // Cron fallback: if no reportTo configured and this execution is cron-triggered,
        // try the system default, then emit a CRITICAL warning if also unset.
        const triggerSource = opts?.triggerContext?.source;
        const isCronTriggered = opts?.triggerContext
          ? triggerSource === "bree" || triggerSource === "cron"
          : template.trigger.type === "cron";
        if (isCronTriggered) {
          const fallback = getConfigValue("delivery.cronDefaultReportTo") as NotifyTarget[] | null | undefined;
          if (fallback && Array.isArray(fallback) && fallback.length > 0) return fallback;
          log.error({ executionId, templateId: template.id }, "CRITICAL: cron template has no reportTo and no system default; failures will be silent");
          serverBus.emit({
            type: "cron_no_target_warning",
            executionId,
            templateId: template.id,
            reason: "cron_template_no_reportTo_and_no_system_default",
            timestamp: Date.now(),
          });
        }
        return [];
      })(),
      deliveryMessageType: _deliveryMsgType,
      goalSteps: goalExpansion.goalSteps,
      triggerContext: opts?.triggerContext,
      templateRetryPolicy: template.retryPolicy,
    };

    // Create TemplateExecution record (event_id links dispatches back to triggering event for Dispatches view).
    createTemplateExecution(executionId, template.id, opts?.eventId);
    ensureArtifactsDir(executionId);
    serverBus.emit({
      type: "template_execution_status_change",
      executionId,
      templateId: template.id,
      status: "running",
    });

    // Group steps into parallel layers
    const layers = this.groupIntoLayers(executionSteps);

    for (const layer of layers) {
      // G-06 fix: Sync externally-modified template execution/step state from DB
      // before processing each layer, so dependents of API-skipped steps are also skipped.
      if (this.syncExternalState(context) === "cancelled") {
        return await this.finalizeCancelledTemplateExecution(template, context);
      }

      // Filter out steps that should be skipped (dependents of failed steps)
      const runnableSteps = layer.filter((step) => !this.shouldSkip(step, context));
      const skippedSteps = layer.filter((step) => this.shouldSkip(step, context));

      // Mark skipped steps
      for (const step of skippedSteps) {
        const result: StepResult = {
          stepId: step.id,
          taskId: "",
          status: "skipped",
          error: "Skipped: dependency failed",
        };
        context.stepResults.set(step.id, result);
        context.stepStatuses[step.id] = {
          taskId: "",
          status: "skipped",
          error: "Skipped: dependency failed",
        };
        log.info({ stepId: step.id, executionId }, "Step skipped due to failed dependency");
      }

      if (runnableSteps.length === 0) continue;

      // Dispatch all steps in this layer concurrently
      const results = await Promise.allSettled(
        runnableSteps.map((step) => this.executeStep(step, context)),
      );

      if (this.syncExternalState(context) === "cancelled") {
        return await this.finalizeCancelledTemplateExecution(template, context);
      }

      // Process results
      for (let i = 0; i < runnableSteps.length; i++) {
        const step = runnableSteps[i];
        const settledResult = results[i];

        if (settledResult.status === "rejected") {
          log.error({ stepId: step.id, error: settledResult.reason }, "TemplateExecution step threw");
          const failResult: StepResult = {
            stepId: step.id,
            taskId: "",
            status: "failed",
            error: String(settledResult.reason),
          };
          context.stepResults.set(step.id, failResult);
          context.failedStepIds.add(step.id);
          context.stepStatuses[step.id] = {
            taskId: "",
            status: "failed",
            error: String(settledResult.reason),
          };
        }

        const stepResult = context.stepResults.get(step.id);
        if (stepResult?.status === "failed") {
          context.failedStepIds.add(step.id);
          if (!context.continueOnError) {
            if (this.isTemplateExecutionCancelled(context.executionId)) {
              return await this.finalizeCancelledTemplateExecution(template, context);
            }
            return await this.finalizeFailedTemplateExecution(template, context, stepResult);
          }
        }
      }

      // Update template execution record with current step statuses
      if (this.isTemplateExecutionCancelled(context.executionId)) {
        return await this.finalizeCancelledTemplateExecution(template, context);
      }
      updateTemplateExecution(executionId, { stepStatuses: context.stepStatuses });
    }

    if (this.isTemplateExecutionCancelled(context.executionId)) {
      return await this.finalizeCancelledTemplateExecution(template, context);
    }

    // Determine final status
    const hasFailures = context.failedStepIds.size > 0;
    const hasSkipped = [...context.stepResults.values()].some((r) => r.status === "skipped" || r.status === "cancelled");
    const hasNoContent = [...context.stepResults.values()].some((r) => r.status === "no_content");
    const completeness = checkDeliveryCompleteness(context.executionId, template);
    const finalStatus: TemplateExecutionResult["status"] =
      (hasFailures || hasSkipped || hasNoContent || !completeness.complete) ? "partial" : "completed";

    this.applyGoalReviewResults(context);

    // Podcast Phase 2: persist 钱钟书 review-editor scores to editor_scores for the retrospective.
    this.persistEditorScores(executionSteps, context);

    // Phase 2 DP-001: persist step results for post-hoc redelivery
    setExecutionStepResults(executionId, context.stepResults);
    updateTemplateExecution(executionId, {
      status: finalStatus,
      stepStatuses: context.stepStatuses,
      completedAt: Date.now(),
    });
    serverBus.emit({
      type: "template_execution_status_change",
      executionId,
      templateId: template.id,
      status: finalStatus,
    });

    log.info(
      {
        executionId,
        status: finalStatus,
        completedSteps: context.stepResults.size,
        totalSteps: executionSteps.length,
        failedSteps: context.failedStepIds.size,
      },
      "TemplateExecution completed",
    );

    // D-007: Aggregated delivery — send TemplateExecution summary to deliverTo/reportTo
    await this.deliverTemplateExecutionResult(context, finalStatus);

    return { executionId, status: finalStatus, stepResults: context.stepResults };
  }

  /**
   * Podcast Phase 2: for each step flagged `recordEditorScores` that completed, parse its
   * result as the 钱钟书 scoring JSON and persist each candidate to editor_scores.
   *
   * `brief_diff` is NOT taken from the LLM output — the retrospective groups on it, so it
   * comes from the template's canonical candidateId → briefPerturbation map, declared by
   * the template author. The LLM is trusted only to echo candidate_id faithfully.
   *
   * Parse/persist failures are logged at WARN and never fail the run — the episode
   * already succeeded; only the retrospective row is lost.
   */
  private persistEditorScores(steps: TaskStep[], context: TemplateExecutionContext): void {
    // Canonical map: candidateId → briefPerturbation, declared by the template author
    // on the parallel write steps. This is the trusted source of brief_diff.
    const perturbationByCandidate = new Map<string, Record<string, unknown>>();
    for (const s of steps) {
      if (s.candidateId && s.briefPerturbation) {
        perturbationByCandidate.set(s.candidateId, { ...s.briefPerturbation });
      }
    }

    for (const step of steps) {
      if (!step.recordEditorScores) continue;
      const stepResult = context.stepResults.get(step.id);
      if (stepResult?.status !== "completed") {
        log.warn(
          { stepId: step.id, executionId: context.executionId, status: stepResult?.status },
          "recordEditorScores step did not complete — skipping editor_scores persist",
        );
        continue;
      }
      try {
        // The review-editor publishes its scoring JSON as the step's outputAs artifact;
        // stepResult.result is only the agent's closing message ("评分结果已发布…").
        // Resolve the artifact via getStepOutput; fall back to result text if absent.
        let raw: string;
        try {
          raw = getStepOutput({
            step,
            executionId: context.executionId,
            taskId: stepResult.taskId,
          }).content;
        } catch (outErr) {
          raw = stepResult.result ?? "";
          log.info(
            { stepId: step.id, executionId: context.executionId, err: String(outErr) },
            "editor_scores: no step-output artifact — falling back to step result text",
          );
        }
        const candidates = parseEditorScoreCandidates(raw);
        if (candidates.length === 0) {
          log.warn(
            { stepId: step.id, executionId: context.executionId },
            "recordEditorScores step parsed to zero candidates — skipping editor_scores persist",
          );
          continue;
        }
        // Attach the canonical brief_diff by candidate_id — never the LLM's value.
        for (const c of candidates) {
          const canonical = perturbationByCandidate.get(c.candidate_id);
          if (canonical) {
            c.brief_diff = canonical;
          } else {
            log.warn(
              { stepId: step.id, executionId: context.executionId, candidateId: c.candidate_id },
              "review-editor scored a candidate_id with no matching template briefPerturbation — brief_diff left null",
            );
          }
        }
        // Selection is a pure function of the recorded scores — the review-editor
        // LLM has set `selected` inconsistently with its own totals. Override it
        // (same canonical-over-LLM principle as brief_diff above).
        markSelectedByScore(candidates);
        insertEditorScores(context.executionId, candidates);
        log.info(
          { stepId: step.id, executionId: context.executionId, candidateCount: candidates.length },
          "Persisted editor_scores for podcast Phase 2 retrospective",
        );
      } catch (err) {
        log.warn(
          { stepId: step.id, executionId: context.executionId, err: String(err) },
          "Failed to parse/persist editor_scores — episode unaffected, retrospective row missing",
        );
      }
    }
  }

  /**
   * Group steps into parallel layers using Kahn's algorithm.
   * Steps in the same layer have no mutual dependencies and can run concurrently.
   */
  private groupIntoLayers(steps: TaskStep[]): TaskStep[][] {
    const stepMap = new Map(steps.map((s) => [s.id, s]));
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    // Initialize
    for (const step of steps) {
      inDegree.set(step.id, 0);
      dependents.set(step.id, []);
    }

    // Build adjacency
    for (const step of steps) {
      if (step.dependsOn) {
        for (const depId of step.dependsOn) {
          if (stepMap.has(depId)) {
            inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
            dependents.get(depId)?.push(step.id);
          }
        }
      }
    }

    const layers: TaskStep[][] = [];
    const remaining = new Set(steps.map((s) => s.id));

    while (remaining.size > 0) {
      // Find all steps with in-degree 0
      const layer: TaskStep[] = [];
      for (const id of remaining) {
        if ((inDegree.get(id) ?? 0) === 0) {
          const step = stepMap.get(id);
          if (step) layer.push(step);
        }
      }

      if (layer.length === 0) {
        // Cycle detected — break to avoid infinite loop, run remaining sequentially
        log.warn({ remaining: [...remaining] }, "Cycle detected in step dependencies");
        for (const id of remaining) {
          const step = stepMap.get(id);
          if (step) layers.push([step]);
        }
        break;
      }

      layers.push(layer);

      // Remove this layer's steps and update in-degrees
      for (const step of layer) {
        remaining.delete(step.id);
        for (const depId of dependents.get(step.id) ?? []) {
          inDegree.set(depId, (inDegree.get(depId) ?? 0) - 1);
        }
      }
    }

    return layers;
  }

  /**
   * G-06: Sync externally-modified step statuses from DB into in-memory context.
   * This catches manual skip/cancel operations performed via the REST API
   * while the template execution is running.
   */
  private syncExternalState(context: TemplateExecutionContext): TemplateExecutionResult["status"] | undefined {
    const execution = getTemplateExecution(context.executionId);
    if (!execution) return undefined;

    for (const [stepId, dbStatus] of Object.entries(execution.stepStatuses)) {
      if (dbStatus.status === "skipped" || dbStatus.status === "failed" || dbStatus.status === "cancelled") {
        // If DB says skipped/failed/cancelled but in-memory doesn't know yet
        if (!context.stepResults.has(stepId) && !context.failedStepIds.has(stepId)) {
          if (dbStatus.status === "skipped") {
            context.stepResults.set(stepId, {
              stepId,
              taskId: dbStatus.taskId,
              status: "skipped",
              error: dbStatus.error ?? "Manually skipped via API",
            });
          } else if (dbStatus.status === "cancelled") {
            context.stepResults.set(stepId, {
              stepId,
              taskId: dbStatus.taskId,
              status: "cancelled",
              error: dbStatus.error ?? "Cancelled",
            });
          } else {
            context.failedStepIds.add(stepId);
            context.stepResults.set(stepId, {
              stepId,
              taskId: dbStatus.taskId,
              status: "failed",
              error: dbStatus.error,
            });
          }
          // Merge: preserve in-memory metadata (retryReason, validatorAttempt, etc.) added
          // by the validator retry loop, while accepting the external terminal status.
          context.stepStatuses[stepId] = {
            ...context.stepStatuses[stepId],
            ...dbStatus,
          };
          log.info({ stepId, status: dbStatus.status, executionId: context.executionId }, "Synced external step status from DB");
        }
      }
    }

    return execution.status === "cancelled" ? "cancelled" : undefined;
  }

  /**
   * Check if a step should be skipped because its dependency threshold is not met.
   * - Without minDependencies: strict-AND (any failed/skipped/no_content/cancelled dep → skip)
   * - With minDependencies=N: skip only if fewer than N deps succeeded
   * - no_content always gates downstream (DP-002 Chosen A)
   * - cancelled always gates downstream (strict-AND promise)
   */
  private shouldSkip(step: TaskStep, context: TemplateExecutionContext): boolean {
    if (!step.dependsOn || step.dependsOn.length === 0) return false;
    const failedCount = step.dependsOn.filter((depId) => {
      if (context.failedStepIds.has(depId)) return true;
      const depResult = context.stepResults.get(depId);
      return depResult?.status === "skipped"
        || depResult?.status === "no_content"
        || depResult?.status === "cancelled";
    }).length;
    const succeededCount = step.dependsOn.length - failedCount;
    const threshold = step.minDependencies ?? step.dependsOn.length;
    return succeededCount < threshold;
  }

  private async executeStep(step: TaskStep, context: TemplateExecutionContext): Promise<void> {
    // Step 1: Resolve user-written prompt (handles {{stepId.result}} text interpolation)
    const resolvedPrompt = this.resolveVariables(step.prompt, context.stepResults);

    // Per-step role: step.roleId overrides template rolePreference (D-002).
    // The variable holds either a role id (from step.roleId) OR a role name
    // (from template rolePreference, which yaml templates ship as a name like
    // "达芬奇" / "周杰伦"). Fall back to name lookup when id lookup misses,
    // otherwise rolePreference-only templates fail Admission with "Role not found".
    const rawRoleRef = step.roleId ?? context.rolePreference;
    const role = rawRoleRef ? (getRole(rawRoleRef) ?? getRoleByName(rawRoleRef)) : undefined;
    // Downstream (createTaskWithAdmission, env injection) expects a canonical id.
    // If we resolved by name, pass role.id so admission's id-based lookup succeeds.
    const roleId = role?.id ?? rawRoleRef;

    // Step 2: Assemble wrapped prompt (DP-000/001/004 — injects artifact content, persona, contract).
    // This runs once outside the retry loop so artifact reads are not repeated per attempt.
    // Throws MissingRequiredArtifactError when explicit consumesFrom is set and an artifact is absent.
    let finalPrompt: string;
    try {
      const assembled = assemblePrompt({
        step,
        executionId: context.executionId,
        userPromptResolved: resolvedPrompt,
      });
      finalPrompt = assembled.prompt;
    } catch (err) {
      if (err instanceof MissingRequiredArtifactError) {
        const result: StepResult = {
          stepId: step.id,
          taskId: "",
          status: "failed",
          roleId,
          roleName: role?.name,
          error: `Missing required upstream artifacts from step(s): ${err.missingProducerStepIds.join(", ")}`,
        };
        context.stepResults.set(step.id, result);
        context.failedStepIds.add(step.id);
        context.stepStatuses[step.id] = {
          taskId: "",
          status: "failed",
          roleId,
          error: result.error,
        };
        log.warn({ stepId: step.id, missingProducerStepIds: err.missingProducerStepIds, executionId: context.executionId }, "Step failed: missing required upstream artifacts");
        return;
      }
      throw err;
    }

    const timeoutMs = ((step.config?.timeout ?? context.config?.timeout ?? 600)) * 1000;

    // G-05 fix: Create a new task for each retry attempt so transient failures
    // are actually retried (and re-admitted) instead of re-polling the same failed task.
    let taskId = "";
    let lastStatus: "completed" | "failed" | "cancelled" | "blocked" = "failed";
    let lastDispatchFailure: Awaited<ReturnType<typeof createTaskWithAdmission>> | undefined;
    let dispatchAttempt = 0;
    // Phase 4: tracks whether the validator retry loop was entered (for metadata in final stepStatuses).
    // Declared here (before transient loop) so the validator loop body can write to it without TDZ.
    let validatorLoopRan = false;
    let validatorLoopAttempt: number | undefined;

    // Shared dispatch params for both the transient-retry loop and the validator-retry loop.
    const dispatchParams = {
      prompt: finalPrompt,
      roleId,
      requirements: step.requirements,
      autoSelectRole: step.autoSelectRole,
      config: {
        ...context.config,
        ...(step.config?.timeout !== undefined ? { timeout: step.config.timeout } : {}),
        ...(step.config?.maxTurns !== undefined ? { maxTurns: step.config.maxTurns } : {}),
      },
      parentId: context.executionId,
      templateId: context.templateId,
      stepId: step.id,
      stepKind: step.kind,
    };

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      dispatchAttempt = attempt;
      // D-011: TemplateExecution step = Task. Route through admission to validate role compatibility.
      // S6-A: wrap in withNewTrace so createTask picks up trace_id via AsyncLocalStorage.
      const dispatchResult = await withNewTrace("template", async () => createTaskWithAdmission({
        ...dispatchParams,
        dispatchSource: "template_step_dispatch",
      }));

      if (!dispatchResult.ok) {
        lastDispatchFailure = dispatchResult;
        break; // admission failure is not a transient retry-able condition
      }

      taskId = dispatchResult.taskId;
      context.stepStatuses[step.id] = {
        taskId,
        status: "running",
        roleId,
        attempt,
        maxAttempts: this.maxRetries,
        retryReason: attempt > 1 ? "transient" : undefined,
        // Phase 4: use context.templateRetryPolicy directly (not maxValidatorAttempts, declared later).
        ...((context.templateRetryPolicy?.maxAttempts ?? 1) > 1 ? { validatorAttempt: 1 } : {}),
      };
      this.persistStepStatuses(context.executionId, context);
      log.debug({ stepId: step.id, taskId, roleId, attempt }, "TemplateExecution step task created via admission");

      lastStatus = await waitForTaskCompletion(taskId, timeoutMs);
      if (lastStatus === "completed") break;
      if (lastStatus === "cancelled") break;
      if (attempt < this.maxRetries) {
        const delay = this.baseDelayMs * Math.pow(2, attempt - 1);
        log.info({ stepId: step.id, attempt, maxRetries: this.maxRetries, delayMs: delay }, "TemplateExecution step failed, retrying");
        await this.sleep(delay);
      }
    }

    // D-004: If admission failed (not a transient task error), record and skip
    if (lastDispatchFailure && !lastDispatchFailure.ok) {
      const result: StepResult = {
        stepId: step.id,
        taskId: "",
        status: "failed",
        roleId,
        roleName: role?.name,
        error: `Admission failed: ${lastDispatchFailure.reason}`,
        admissionError: {
          code: lastDispatchFailure.code,
          reason: lastDispatchFailure.reason,
          candidates: lastDispatchFailure.candidates?.map(c => ({
            roleId: c.roleId,
            name: c.name,
            fitScore: c.fitScore,
          })),
        },
      };
      context.stepResults.set(step.id, result);
      context.stepStatuses[step.id] = {
        taskId: "",
        status: "failed",
        roleId,
        error: lastDispatchFailure.reason,
      };
      log.warn({ stepId: step.id, admissionCode: lastDispatchFailure.code, reason: lastDispatchFailure.reason }, "TemplateExecution step admission failed");
      return;
    }

    // ===== Retry topology for one step (Task 4 documentation) =====
    // Two sequential retry loops; they do NOT multiply:
    //
    //  (a) Transient `for` loop (line 693-728):
    //      - Triggers: lastStatus !== "completed" (i.e., "failed", "cancelled")
    //      - Budget: this.maxRetries (default 2)
    //      - Use case: transient failures, inactivity timeouts (→ "failed" after Task 2)
    //      - After Task 2: timed-out step → "failed" → auto-retried here
    //
    //  (b) Validator `while` loop (below, line 767-830):
    //      - Triggers: `validator_error` step_log row OR `hasMissingArtifact`
    //        (step.outputAs declared, step completed, artifact not yet in DB at loop time)
    //      - Budget: context.templateRetryPolicy?.maxAttempts ?? 1
    //        (defaults to 1 = loop never enters; templates set retryPolicy.maxAttempts ≥ 2
    //         to enable this retry path)
    //      - Use case: role completed but skipped publish_artifact_file, or contract violation
    //
    //  (c) capture-primary (line 907): runs AFTER both loops close. For text-capturable steps,
    //      captureTextArtifact is called here — meaning hasMissingArtifact at validator-loop time
    //      is TRUE even for a timeout-completed step (artifact not yet written). Budget at (b)
    //      must be ≥ 2 to re-dispatch; Task 5's isValidDeliverable handles the role-published-
    //      but-degenerate case (artifact present at loop time but empty/sentinel).
    //
    //  Total per-step dispatches ≤ this.maxRetries (transient) + (maxValidatorAttempts - 1) (validator).
    //  Loops are sequential so budgets ADD, not multiply.

    // ===== Validator-driven retry loop (Phase 4) =====
    // Detects structured validator_error step_log rows written by execution-tools.ts
    // and re-dispatches the step with a clean slate when retryPolicy allows it.
    // Runs BEFORE length/verifier retry section so the two budgets are independent.
    const maxValidatorAttempts = context.templateRetryPolicy?.maxAttempts ?? 1;
    let validatorAttempt = 1; // initial dispatch counts as attempt 1
    // L3 (#228) + Task 5: the step's declared outputAs artifact is "invalid" when it was
    // never published OR is present but degenerate (empty / internal sentinel). Treated
    // like a missing artifact → triggers a validator re-dispatch.
    const outputArtifactInvalid = (): boolean => {
      if (!step.outputAs) return false;
      const art = getArtifact(context.executionId, step.id, step.outputAs);
      return !art || !isValidDeliverable(art);
    };
    while (validatorAttempt < maxValidatorAttempts) {
      const hasValidatorErr = getDb().prepare(
        "SELECT 1 FROM step_logs WHERE task_id = ? AND type = 'validator_error' LIMIT 1",
      ).get(taskId);
      const hasMissingArtifact = lastStatus === "completed" && outputArtifactInvalid();
      if (!hasValidatorErr && !hasMissingArtifact) break; // no retry-able signal — normal path

      const retryCause = hasValidatorErr ? "validator_error" : "missing_artifact";
      log.info(
        { stepId: step.id, executionId: context.executionId, taskId, attempt: validatorAttempt, retryCause },
        "Validator retry: cleaning slate and re-dispatching step",
      );

      // Clean up platform-side artifacts from the failed attempt
      const cleanResult = await cleanSlatePriorAttempt(context.executionId, step.id);
      log.debug({ cleanResult }, "cleanSlatePriorAttempt done");

      validatorAttempt++;

      // Re-dispatch the same step
      const reDispatch = await withNewTrace("template", async () =>
        createTaskWithAdmission({
          ...dispatchParams,
          stepId: step.id,
          dispatchSource: "template_step_dispatch",
        }),
      );

      if (!reDispatch.ok) {
        lastDispatchFailure = reDispatch;
        break;
      }

      const newTaskId = reDispatch.taskId;
      context.stepStatuses[step.id] = {
        taskId: newTaskId,
        status: "running",
        roleId,
        validatorAttempt,
        maxAttempts: maxValidatorAttempts,
        retryReason: "validator",
        originalTaskId: taskId,
      };
      this.persistStepStatuses(context.executionId, context);

      lastStatus = await waitForTaskCompletion(newTaskId, timeoutMs);
      taskId = newTaskId;
      validatorLoopRan = true;
      validatorLoopAttempt = validatorAttempt;

      // If the re-dispatch completed without a validator error or missing artifact, exit the loop
      if (lastStatus === "completed") {
        const reHasErr = getDb().prepare(
          "SELECT 1 FROM step_logs WHERE task_id = ? AND type = 'validator_error' LIMIT 1",
        ).get(taskId);
        if (!reHasErr && !outputArtifactInvalid()) break; // success
      }
      if (lastStatus === "cancelled") break;
    }

    // Phase 4: When the validator loop ran but exited without re-dispatch (both attempts
    // had validator_error rows), the loop never called persistStepStatuses for the retry
    // metadata. Persist it here so both-path assertions succeed (retryReason + validatorAttempt).
    if (maxValidatorAttempts > 1 && validatorAttempt > 1) {
      const existing = context.stepStatuses[step.id];
      context.stepStatuses[step.id] = {
        ...existing,
        validatorAttempt,
        retryReason: "validator",
      };
      this.persistStepStatuses(context.executionId, context);
    }

    let finalTask = getTask(taskId);
    const latestExecution = getTemplateExecution(context.executionId);
    const latestStepStatus = latestExecution?.stepStatuses[step.id];

    // Fix A: check whether the artifact is already in DB regardless of wrapper exit status.
    // The SDK may force-close a task (status="failed") even after the role successfully called
    // publish_artifact_file. The DB row is the source of truth, not the wrapper's exit status.
    const artifactAlreadyPublished = step.outputAs
      ? !!getArtifact(context.executionId, step.id, step.outputAs)
      : false;
    // raceRescued = artifact landed despite wrapper failure, AND the execution was NOT cancelled
    // or skipped at any level (wrapper task / step row / execution row). Tagged explicitly so
    // logs/audit can distinguish silent rescue from normal completion. The cancellation guards
    // are critical: a user-cancelled step that happens to have an artifact in DB (from a prior
    // attempt or partial publish before the cancel landed) must NOT be reclassified to completed
    // (Lens A finding #2 — cancellation precedence inversion). `lastStatus === "cancelled"` is
    // the runtime cancel signal returned by waitForTaskCompletion; the other two are DB-persisted.
    const raceRescued = artifactAlreadyPublished
      && lastStatus !== "completed"
      && lastStatus !== "cancelled"
      && latestStepStatus?.status !== "skipped"
      && latestStepStatus?.status !== "cancelled"
      && latestExecution?.status !== "cancelled";

    // v90 (Gap 1 fix, gate 2): per-step locals for D-022 settled==due check.
    // Scoped to the outer function so the settle block (below) and the 门②
    // check (further below) share state without touching globalThis. Each
    // template execution runs its own scope; no cross-execution leakage.
    let __gap1SettledCount = 0;
    let __gap1HadSettleCall = false;
    let __gap1DueCount: number | undefined = undefined;

    let finalStepStatus: "completed" | "failed" | "skipped" | "cancelled" | "no_content" =
      lastStatus === "completed"
        ? "completed"
        : (lastStatus === "cancelled"
            || latestStepStatus?.status === "cancelled"
            || latestExecution?.status === "cancelled")
          ? "cancelled"
          : latestStepStatus?.status === "skipped"
            ? "skipped"
            : raceRescued
              ? "completed"
              : "failed";

    // ===== Step-output completion enforcement (Phase 2/Phase 4 root-cause fix) =====
    // When step declares outputAs but no artifact was published, attempt one corrective
    // nudge dispatch before declaring failure. This gives the role a final chance
    // to publish the artifact with an enriched prompt. See plan Task 2 (L4 / #229).
    let stepOutputCheckFailed = false;
    // L4 (#229): tracks whether the nudge dispatch fired (success OR fail). Threaded into
    // retryStatusReason so the final stepStatuses write doesn't overwrite our nudge marker.
    let nudgeFired = false;
    if (step.outputAs && (lastStatus === "completed" || artifactAlreadyPublished)) {
      const artifact = getArtifact(context.executionId, step.id, step.outputAs);
      // Capture-primary (adam-artifact-contract.md): a TEXT deliverable IS the step's final
      // response — the role is not required to call a publish tool. The platform captures the
      // completed step's result into the outputAs artifact. Only BINARY deliverables
      // (audio/image/file, per stepRequiresFileArtifact) must publish a real file, because
      // there is no text response to capture; those still fall to the presence-gate nudge.
      if (!artifact) {
        const capturedText = finalTask?.result ?? "";
        if (
          lastStatus === "completed"
          && latestStepStatus?.status !== "cancelled"
          && latestExecution?.status !== "cancelled"
          && isTextCapturable(step)
          && !!roleId
          && capturedText.trim().length > 0
          && !isInternalSentinel(capturedText)
        ) {
          const captured = await captureTextArtifact({
            executionId: context.executionId,
            stepId: step.id,
            key: step.outputAs,
            roleId,
            text: capturedText,
          });
          log.info({ stepId: step.id, executionId: context.executionId, taskId, sizeBytes: captured.sizeBytes }, "Capture: text step response captured as outputAs artifact");
          finalStepStatus = "completed";
          context.stepStatuses[step.id] = {
            ...context.stepStatuses[step.id],
            taskId,
            status: "completed",
          };
          this.persistStepStatuses(context.executionId, context);
        } else {
        log.info({ stepId: step.id, executionId: context.executionId, priorTaskId: taskId }, "Nudge dispatch: prior attempt missed artifact, dispatching corrective task");
        nudgeFired = true;
        const nudgeResult = await this.dispatchNudge(context, step, taskId, roleId ?? "", timeoutMs);
        // Look up the artifact directly. The SDK wrapper may have reported the nudge
        // task as failed (inactivity force-close) even when the role successfully
        // called publish_artifact_file before the timeout. The DB row is the source
        // of truth, not the wrapper's exit status.
        const nudgeArtifact = getArtifact(
          context.executionId,
          step.id,
          step.outputAs,
        );

        if (nudgeArtifact) {
          // Check whether the published artifact is a no_content marker (quota/crash signal)
          // vs. a real deliverable file. Both are truthy nudgeArtifact values, so we must
          // inspect kind + value to distinguish them.
          const isNoContentMarker =
            nudgeArtifact.kind === "json"
            && typeof nudgeArtifact.value === "object"
            && nudgeArtifact.value !== null
            && (nudgeArtifact.value as { status?: unknown }).status === "no_content";

          const originalTaskId = context.stepStatuses[step.id]?.originalTaskId ?? taskId;
          taskId = nudgeResult.taskId;
          finalTask = getTask(taskId);

          if (isNoContentMarker) {
            // Nudge ran but the role declared empty output — record no_content status
            // so the delivery pipeline can surface the gap to the user.
            const noContentReason = (nudgeArtifact.value as { reason?: string }).reason;
            log.info({ stepId: step.id, executionId: context.executionId, nudgeTaskId: nudgeResult.taskId, reason: noContentReason }, "Nudge dispatch: succeeded but artifact is no_content marker");
            finalStepStatus = "no_content";
            context.stepStatuses[step.id] = {
              ...context.stepStatuses[step.id],
              taskId: nudgeResult.taskId,
              status: "no_content",
              retryReason: "nudge",
              nudgeAttempted: true,
              noContentReason,
              originalTaskId,
            };
          } else {
            // Nudge succeeded with a real deliverable artifact.
            log.info({ stepId: step.id, executionId: context.executionId, nudgeTaskId: nudgeResult.taskId }, "Nudge dispatch: succeeded, artifact published");
            finalStepStatus = "completed";
            context.stepStatuses[step.id] = {
              ...context.stepStatuses[step.id],
              taskId: nudgeResult.taskId,
              status: "completed",
              retryReason: "nudge",
              nudgeAttempted: true,
              originalTaskId,
            };
          }
          this.persistStepStatuses(context.executionId, context);
        } else {
          // Nudge failed: fall through to original violation recording.
          log.warn({ stepId: step.id, executionId: context.executionId, nudgeStatus: nudgeResult.status }, "Nudge dispatch: also missed artifact, recording violation");
          finalStepStatus = "failed";
          stepOutputCheckFailed = true;
          const missingOutputError = this.formatMissingOutputError(step);
          recordAuditViolation({
            id: uuidv4(),
            stepTaskId: taskId,
            executionId: context.executionId,
            roleId: roleId ?? "",
            contractField: "outputAs",
            layer: "A",
            severity: "error",
            message: missingOutputError,
            metadata: { nudgeAttempted: true },
            createdAt: Date.now(),
          });
          context.stepStatuses[step.id] = {
            ...context.stepStatuses[step.id],
            nudgeAttempted: true,
          };
          this.persistStepStatuses(context.executionId, context);
        }
        }
      }
    }

    // ===== Deferred ledger persistence (Fix 1b: validate-before-commit) =====
    // Claims + settlement + 门② are DEFINED here but EXECUTED after contract validation
    // (Layer A/B/C) via deferLedgerPersist() below. A step whose task completed but FAILS
    // contract must not leave orphaned belief/settlement writes in the ledger; deferring lets
    // the writes' `finalStepStatus === "completed"` gate reflect the post-contract status.
    // The closure captures `finalStepStatus` and `taskId` (both `let`, reassigned by contract
    // retries) by reference, so it reads their final values at call time.
    const deferLedgerPersist = (): void => {
    // ===== v90 Belief Ledger: opt-in claims persistence (Phase 1) =====
    // Step declares `publishesClaimsTo` → platform reads THIS step's `outputAs`
    // artifact (NOT another step's), parses as JSON array of structured claims,
    // and persists each via `recordPrediction`. Best-effort: a malformed payload
    // (e.g. the script step's `{title,body}` shape by mistake) is logged at
    // WARN and skipped — never blocks step completion. The `Array.isArray`
    // guard is non-negotiable: iterating a non-array object would treat its
    // keys as claims and write garbage to the ledger.
    if (step.publishesClaimsTo && step.outputAs && finalStepStatus === "completed") {
      try {
        const claimsArtifact = getArtifact(context.executionId, step.id, step.outputAs);
        if (claimsArtifact && claimsArtifact.kind === "json" && claimsArtifact.value !== undefined) {
          // SINGLE SOURCE OF TRUTH: the parse/guard/validate/persist contract
          // lives in belief-ledger.persistClaimsFromArtifactValue, which the
          // unit test calls directly — so this real path is what's tested.
          const r = persistClaimsFromArtifactValue(step.publishesClaimsTo, claimsArtifact.value, {
            onWarn: (msg, meta) =>
              log.warn({ ...meta, stepId: step.id, executionId: context.executionId }, msg),
          });
          log.info(
            {
              stepId: step.id,
              executionId: context.executionId,
              owner: step.publishesClaimsTo,
              persisted: r.persisted,
              skipped: r.skipped,
              reason: r.reason,
            },
            "publishesClaimsTo: claims persistence complete",
          );
        }
      } catch (err) {
        // Best-effort: never let settlement persistence block step completion.
        log.warn(
          { err: (err as Error).message, stepId: step.id, executionId: context.executionId, owner: step.publishesClaimsTo },
          "publishesClaimsTo: unexpected failure, step continues",
        );
      }
    }

    // ===== v90 Belief Ledger: opt-in settle-verdict consumption (Phase 1.5) =====
    // Step declares `settlesPredictionsFor` → platform reads THIS step's `outputAs`
    // artifact (a JSON array of settle-verdicts) and calls `settlePrediction` for
    // each, closing the self-falsification loop. EXACT reverse of the publish block
    // above; identical safety posture (best-effort, never blocks step completion,
    // Array.isArray guard inside the helper). `skipped > 0` is surfaced at INFO so a
    // silent partial (one mis-copied predictionId → that bet never settles → re-injects
    // forever) is visible in production logs.
    //
    // v90 (Gap 1 fix, gate 2): D-022 settled==due invariant enforcement.
    // Snapshot due-count BEFORE settle (settle drains the unsettled set, so a
    // post-settle findDue would always return 0). 门② is hoisted OUTSIDE the
    // inner kind==="json" gate so the no_content + due>0 path also leaves a
    // trace (the same residual hole the shape gate can't cover when the LLM
    // emits the no_content marker instead of a verdicts array).
    if (
      step.settlesPredictionsFor &&
      step.outputAs &&
      (finalStepStatus === "completed" || finalStepStatus === "no_content")
    ) {
      try {
        // Snapshot BEFORE settle — findDuePredictions is over the unsettled set,
        // and settle() drains those rows via supersede. Post-settle would be 0.
        // Guard includes "no_content": a settle step that published nothing still
        // gets finalStepStatus="no_content", and with due>0 that is a silent drop
        // 门② must catch (the residual the kind==="json" hoist alone misses).
        // Default dueDays=3 (matches belief-ledger.ts DUE_DAYS private constant;
        // not imported to keep the public API narrow).
        const __gap1Today = new Date().toISOString().slice(0, 10);
        __gap1DueCount = findDuePredictions(step.settlesPredictionsFor, __gap1Today).length;

        const verdictArtifact = getArtifact(context.executionId, step.id, step.outputAs);
        if (verdictArtifact && verdictArtifact.kind === "json" && verdictArtifact.value !== undefined) {
          // SINGLE SOURCE OF TRUTH: parse/guard/validate-id/settle contract lives in
          // belief-ledger.settlePredictionsFromArtifactValue, which the unit test calls
          // directly — so this real path is what's tested.
          const r = settlePredictionsFromArtifactValue(step.settlesPredictionsFor, verdictArtifact.value, {
            onWarn: (msg, meta) =>
              log.warn({ ...meta, stepId: step.id, executionId: context.executionId }, msg),
          });
          log.info(
            {
              stepId: step.id,
              executionId: context.executionId,
              owner: step.settlesPredictionsFor,
              settled: r.settled,
              skipped: r.skipped,
              reason: r.reason,
            },
            "settlesPredictionsFor: settlement complete",
          );
          __gap1SettledCount = r.settled;
          __gap1HadSettleCall = true;
        }
      } catch (err) {
        // Best-effort: never let settlement consumption block step completion.
        log.warn(
          { err: (err as Error).message, stepId: step.id, executionId: context.executionId, owner: step.settlesPredictionsFor },
          "settlesPredictionsFor: unexpected failure, step continues",
        );
      }
    }

    // 门② enforcement: D-022 settled==due check. Runs after the settle block
    // (so __gap1SettledCount is final), and is hoisted out of the inner
    // kind==="json" gate so the no_content+due>0 path also leaves a trace.
    // D-004: violation does NOT flip finalStepStatus to failed — the manuscript
    // still delivers; settlement bookkeeping is just incomplete and is left
    // auditable via audit_violations.
    if (
      step.settlesPredictionsFor &&
      step.outputAs &&
      (finalStepStatus === "completed" || finalStepStatus === "no_content") &&
      __gap1DueCount !== undefined
    ) {
      const comp = checkSettlementCompleteness({ due: __gap1DueCount, settled: __gap1SettledCount });
      if (__gap1DueCount > 0 && !comp.complete) {
        recordAuditViolation({
          id: uuidv4(),
          createdAt: Date.now(),
          stepTaskId: taskId,
          executionId: context.executionId,
          roleId: roleId ?? "",
          contractField: "customAssertions",
          severity: "error",
          layer: "C",
          message: `settlement incomplete: settled ${__gap1SettledCount} < due ${__gap1DueCount} (shortfall ${comp.shortfall}) — D-022 settled==due violated (settleCall=${__gap1HadSettleCall})`,
        });
        log.warn(
          {
            stepId: step.id,
            executionId: context.executionId,
            owner: step.settlesPredictionsFor,
            due: __gap1DueCount,
            settled: __gap1SettledCount,
            shortfall: comp.shortfall,
            settleCallFired: __gap1HadSettleCall,
          },
          "Gap 1 门②: D-022 settled<due — audit_violation recorded",
        );
      }
    }
    }; // end deferLedgerPersist — invoked after contract validation (see below)

    // ===== Race-rescue: explicit contract-verification skip with audit trail =====
    // When the step is rescued by artifact-already-published (wrapper task force-closed but
    // artifact landed in DB), the wrapper's `finalTask.result` is unreliable — it's whatever
    // partial text the role emitted before SDK inactivity timeout fired. Running Layer A length
    // / format / persona / mustReferenceArtifacts checks against that partial text would either
    // false-fail (incomplete text) or false-pass (text happened to look complete). Skip the
    // checks and record a warning-severity violation so audit consumers can see the gap.
    if (raceRescued && (step.outputContract || step.persona)) {
      log.info(
        { stepId: step.id, executionId: context.executionId, taskId },
        "Race-rescue path: contract verification skipped (wrapper force-closed; finalTask.result unreliable). Audit-trail violation recorded.",
      );
      recordAuditViolation({
        id: uuidv4(),
        stepTaskId: taskId,
        executionId: context.executionId,
        roleId: roleId ?? "",
        contractField: "race-rescue",
        layer: "A",
        severity: "warning",
        message: `Contract verification skipped for race-rescued step "${step.id}". Wrapper task force-closed but artifact was published. lengthTarget/persona/format/mustReferenceArtifacts checks could not run because finalTask.result is unreliable.`,
        metadata: {
          raceRescued: true,
          hasOutputContract: !!step.outputContract,
          hasPersona: !!step.persona,
        },
        createdAt: Date.now(),
      });
    }

    // ===== Contract verification (Phase 2) =====
    // Only verify successful steps that declare a contract or persona.
    // NOTE: gate intentionally stays on `lastStatus === "completed"` (NOT broadened to honor
    // raceRescued). When the wrapper failed, finalTask.result is partial/unreliable; running
    // checks against it produces noise. Race-rescue gets explicit audit-trail above instead.
    let retriedResult: RetryResult | null = null;
    let layerAResult: LayerAResult | null = null;
    let layerBResult: import("../audit/contract-verifier.js").LayerBResult | null = null;
    let contractStatus: "pass" | "fail-A" | "fail-B" | "retried-pass" | "retried-fail" = "pass";
    // Tracks which retry path (if any) produced the final state for error message discrimination
    let retryReason: TemplateExecutionStepStatus["retryReason"] | null = null;
    let contractOriginalTaskId: string | undefined;
    if (lastStatus === "completed" && !stepOutputCheckFailed && (step.outputContract || step.persona)) {
      const taskResult = finalTask?.result ?? "";
      const resultByteSize = Buffer.byteLength(taskResult, "utf8");

      // Persist the count of contract sub-fields actually checked.
      // computeTaskScore reads task.config.outputContractCheckCount + audit_violations
      // to derive contractCompliance; without this write the metric stays null forever.
      const contractsCheckedThisTask = countCheckedContracts(step);
      if (contractsCheckedThisTask > 0) {
        updateTaskConfig(taskId, { outputContractCheckCount: contractsCheckedThisTask });
      }

      // Layer A: synchronous rule-based checks
      layerAResult = runLayerA({ step, executionId: context.executionId, taskId });

      if (!layerAResult.passed) {
        // Pure design: Layer A failures (presence / persona) are NOT retried post-hoc — content
        // correction happens in-session at the PreToolUse boundary hook (Track A). Any Layer A
        // failure is an immediate fail-A.
        contractStatus = "fail-A";
        finalStepStatus = "failed";
        for (const v of layerAResult.violations) {
          const field = this.mapLayerAContractField(v.contractField);
          recordAuditViolation({
            id: uuidv4(),
            stepTaskId: taskId,
            executionId: context.executionId,
            roleId: roleId ?? "",
            contractField: field as AuditViolation["contractField"],
            layer: "A",
            severity: "error",
            message: v.message,
            createdAt: Date.now(),
          });
        }
      } else {
        // Layer B: semantic check via Reviewer Role dispatch
        let semanticContent: string | null = null;
        if (stepRequiresFileArtifact(step)) {
          // Skip Layer B for binary deliverables (audio/image/file) — the semantic verifier is a
          // text LLM, so feeding it binary bytes is meaningless. Guard on the step CONTRACT, not the
          // artifact mime: a binary step that published with a missing/empty mime would slip past the
          // StepOutputBinaryError mime check below (isTextMime(null)=true → bytes decoded as UTF-8 →
          // spurious low-confidence fail). The contract is the reliable signal.
          semanticContent = null;
        } else if (stepIsPureStructuredOutput(step)) {
          // Skip Layer B for pure data-JSON steps (本期下注 bets / 结算 verdicts: format=json|jsonArray,
          // no persona, no mustReferenceArtifacts). The narrative verifier asks "does this narrate as 我
          // in first person" — a category error for a data array → it hedges (~0.7) → spurious fail-B.
          // JSON structure is already validated at the publish boundary (Track A, pre-tool-verifier).
          // A JSON step WITH a persona (定稿) or grounding (mustReferenceArtifacts) keeps Layer B.
          semanticContent = null;
        } else {
          try {
            semanticContent = getStepOutput({ step, executionId: context.executionId, taskId }).content;
          } catch (err) {
            if (err instanceof StepOutputBinaryError) {
              // Secondary guard: binary mime on a step without a file contract (legacy / edge cases).
              semanticContent = null;
            } else {
              semanticContent = finalTask?.result ?? "";  // legacy fallback for non-template / missing-outputAs cases
            }
          }
        }
        if (semanticContent !== null) {
          layerBResult = await runLayerB({
            step,
            producerRoleId: roleId ?? "",
            producerRoleName: role?.name ?? "",
            producerTaskId: taskId,
            executionId: context.executionId,
            stepResult: semanticContent,
          });
        } else {
          layerBResult = { passed: true, verifierTaskId: null, identityCoherent: null, upstreamGrounded: null, confidence: null, issues: [], failed: false };
        }

        if (layerBResult.failed) {
          // Infrastructure failure — Layer B "skipped", accept Layer A pass
          contractStatus = "pass";
          log.warn({ stepId: step.id, layerBIssues: layerBResult.issues }, "Layer B failed (skipped), accepting Layer A pass");
        } else if (!layerBResult.passed && layerBResult.confidence !== null && layerBResult.confidence >= 0.7) {
          // High-confidence Layer B failure — retry once with verifier feedback
          const verifierFeedbackBlock = `<verifier_feedback>
Your previous attempt was rejected by the contract verifier with these findings:
${layerBResult.issues.map((issue) => `- ${issue}`).join("\n")}
Please rewrite your output addressing each issue. Maintain persona "${step.persona?.speakAs ?? "(none)"}" and the declared length/format/grounding contract.
</verifier_feedback>`;
          retryReason = "verifier";
          contractOriginalTaskId = taskId;
          retriedResult = await this.retryStepWithFeedback({
            step,
            originalTaskId: taskId,
            executionId: context.executionId,
            feedbackBlock: verifierFeedbackBlock,
            role,
            roleId,
            context,
            finalPrompt,
          });

          if (retriedResult.layerAPassed) {
            contractStatus = "retried-pass";
            finalStepStatus = "completed";
            taskId = retriedResult.taskId;
            finalTask = retriedResult.finalTask;
          } else {
            contractStatus = "retried-fail";
            finalStepStatus = "failed";
            // Record audit violations from the retry's Layer A failure
            if (retriedResult.layerAViolations) {
              for (const v of retriedResult.layerAViolations.violations) {
                const field = this.mapLayerAContractField(v.contractField);
                recordAuditViolation({
                  id: uuidv4(),
                  stepTaskId: retriedResult.taskId,
                  executionId: context.executionId,
                  roleId: roleId ?? "",
                  contractField: field as AuditViolation["contractField"],
                  layer: "A",
                  severity: "error",
                  message: v.message,
                  createdAt: Date.now(),
                });
              }
            }
          }
        } else if (!layerBResult.passed) {
          contractStatus = "fail-B";
          finalStepStatus = "failed";
        }
      }

      // ===== Layer C: customAssertions judge =====
      // Runs only when (a) the step succeeded through Layer A+B (contractStatus in {pass, retried-pass})
      // AND (b) the step declares customAssertions.
      // Layer C has its own retry budget (up to 2 retries via retryStepWithFeedback), independent of
      // Layer A length-retry and Layer B verifier-retry. Final failure records audit_violations but
      // does NOT change finalStepStatus — per design D-004 "violation 不死锁，仍交付".
      //
      // CRITICAL non-deadlock invariant (plan-verifier finding): if a Layer C retry's output fails
      // Layer A (e.g., length drift due to assertion-focused rewrite), we FALL BACK to the ORIGINAL
      // output (which passed A+B) and record customAssertions violations on the original taskId.
      // We do NOT mark the step failed — that would betray D-004 by discarding good output for a
      // Layer C concern.
      const customAssertions = step.outputContract?.customAssertions;
      const layerCEligible = customAssertions && customAssertions.length > 0
        && (contractStatus === "pass" || contractStatus === "retried-pass");
      if (layerCEligible) {
        const MAX_LAYER_C_RETRIES = 2;
        // Anchor original passing state (used as fallback if a retry breaks Layer A)
        const originalTaskId = taskId;
        const originalResult = finalTask?.result ?? "";
        const originalFinalTask = finalTask;

        let currentTaskId = originalTaskId;
        let currentResult = originalResult;
        let layerCPassed = false;
        let lastJudgeResult: import("../audit/assertion-judge.js").CustomAssertionsCheckResult | null = null;
        let layerCAttempts = 0;
        let retryAbandoned = false;  // true if a retry's Layer A failed → falling back to original

        // Success-path log on entry (kb lesson 2026-05-16 prevention #1)
        log.info({ stepId: step.id, assertionsCount: customAssertions.length, maxRetries: MAX_LAYER_C_RETRIES }, "Layer C: starting customAssertions judge");

        for (let attempt = 0; attempt <= MAX_LAYER_C_RETRIES; attempt++) {
          layerCAttempts = attempt + 1;
          const judgeResult = await runCustomAssertionsCheck({
            assertions: customAssertions,
            stepResult: currentResult,
          });
          lastJudgeResult = judgeResult;

          if (judgeResult.passed) {
            layerCPassed = true;
            break;
          }

          if (attempt < MAX_LAYER_C_RETRIES) {
            const failedItems = judgeResult.results.filter((r) => !r.passed);
            const assertionFeedbackBlock = `<assertion_feedback>
Your previous output failed these editorial assertions:
${failedItems.map((r) => `- ${r.assertion}: ${r.reason}`).join("\n")}
Rewrite your output to satisfy ALL assertions. Maintain persona "${step.persona?.speakAs ?? "(none)"}" and the declared length/format/grounding contract.
</assertion_feedback>`;
            retryReason = "customAssertions" as TemplateExecutionStepStatus["retryReason"];
            contractOriginalTaskId = currentTaskId;
            const layerCRetry = await this.retryStepWithFeedback({
              step,
              originalTaskId: currentTaskId,
              executionId: context.executionId,
              feedbackBlock: assertionFeedbackBlock,
              role,
              roleId,
              context,
              finalPrompt,
            });

            if (!layerCRetry.layerAPassed) {
              // FIXED (plan-verifier must-revise #3): retry's Layer A failed (e.g., length drift caused
              // by assertion-focused rewrite). Falling back to the ORIGINAL output preserves D-004
              // semantics — original passed A+B, so deliver it; record customAssertions violations
              // on the original taskId; DO NOT mark step failed.
              log.warn({
                stepId: step.id,
                attempt,
                retryTaskId: layerCRetry.taskId,
                layerAViolations: layerCRetry.layerAViolations?.violations.map((v) => v.contractField) ?? [],
              }, "Layer C retry broke Layer A — falling back to original output, will record customAssertions violations on original taskId");
              // Reset current* to original; abort Layer C loop and record violations against ORIGINAL.
              currentTaskId = originalTaskId;
              currentResult = originalResult;
              taskId = originalTaskId;
              finalTask = originalFinalTask;
              retryAbandoned = true;
              // Re-run the judge against ORIGINAL content if we've moved past attempt=0 via
              // successful Layer-A retries. At attempt > 0, lastJudgeResult was evaluated
              // against the prior retry's content (since currentResult got advanced after
              // each successful retry), so the audit rows below would describe failures in
              // already-discarded retry text while being filed against originalTaskId.
              // At attempt=0, currentResult === originalResult so lastJudgeResult is already correct.
              if (attempt > 0) {
                lastJudgeResult = await runCustomAssertionsCheck({
                  assertions: customAssertions,
                  stepResult: originalResult,
                });
              }
              break;
            }

            // Retry's Layer A passed — adopt retry's output as the new "current" baseline for next judge call
            currentTaskId = layerCRetry.taskId;
            currentResult = layerCRetry.finalTask?.result ?? "";
            taskId = currentTaskId;
            finalTask = layerCRetry.finalTask;
          }
        }

        // After loop: if Layer C still not passed, record customAssertions violations BUT keep step completed
        if (!layerCPassed && finalStepStatus === "completed" && lastJudgeResult) {
          const failedItems = lastJudgeResult.results.filter((r) => !r.passed);
          for (const failed of failedItems) {
            recordAuditViolation({
              id: uuidv4(),
              stepTaskId: currentTaskId,  // After retryAbandoned, this == originalTaskId
              executionId: context.executionId,
              roleId: roleId ?? "",
              contractField: "customAssertions",
              layer: "C",
              severity: "warning",  // warning, not error — design D-004 "violation 不死锁，仍交付"
              message: `Assertion failed: ${failed.assertion} — ${failed.reason}`,
              metadata: {
                issues: [failed.reason],
                confidence: undefined,
              } as AuditViolation["metadata"],
              createdAt: Date.now(),
            });
          }
          // Success-path log: NOT all-passed, but step completes nonetheless (D-004)
          log.warn({
            stepId: step.id,
            failedCount: failedItems.length,
            totalAssertions: customAssertions.length,
            layerCAttempts,
            retryAbandoned,
            finalTaskId: currentTaskId,
          }, "Layer C: assertions failed after max retries; recorded violations as warnings and accepting step output (D-004)");
        } else if (layerCPassed) {
          // Success-path log (kb lesson 2026-05-16 prevention #1: log success not just failure)
          log.info({
            stepId: step.id,
            assertionsCount: customAssertions.length,
            layerCAttempts,
          }, "Layer C: all assertions passed");
        }
      }
    }

    // Fix 1b: persist ledger writes NOW — after Layer A/B/C settled finalStepStatus. A
    // contract-failed step (finalStepStatus="failed") writes nothing; pass/retried-pass writes
    // as before. Eliminates the orphaned-belief inconsistency (recorded-but-step-failed).
    deferLedgerPersist();

    const contractFailed = (contractStatus === "fail-A" || contractStatus === "retried-fail" || contractStatus === "fail-B");
    const missingOutputError = stepOutputCheckFailed && step.outputAs
      ? this.formatMissingOutputError(step)
      : undefined;
    const contractErrorMsg = missingOutputError ?? (contractFailed
      ? this.formatContractError(layerAResult, layerBResult, contractStatus as "fail-A" | "fail-B" | "retried-fail", retriedResult, retryReason)
      : undefined);

    // Persist contractRetried alongside the final status object (not in a separate write that gets overwritten).
    // retryStatusReason precedence: nudge > raceRescued > validator > transient.
    // When BOTH validatorLoopRan AND raceRescued are true (validator retry fired, the retried
    // task's wrapper force-closed, but the artifact landed in DB before timeout), "race-rescue"
    // wins because it is the more specific operational signal — it tells the audit consumer
    // that the wrapper status disagreed with the DB row. "validator" alone says only that retry
    // happened; "race-rescue" says retry happened AND the wrapper died on the retried task too.
    const retriedFlag = (contractStatus === "retried-pass" || contractStatus === "retried-fail");
    const retryStatusReason = retryReason
      ?? (nudgeFired ? "nudge" as const : undefined)
      ?? (raceRescued ? "race-rescue" as const : undefined)
      ?? (validatorLoopRan ? "validator" as const : undefined)
      ?? (dispatchAttempt > 1 ? "transient" as const : undefined);
    const warnings = this.extractExplicitWarnings(finalTask?.result);

    // Race-rescued steps are reported as completed even though `finalTask` is the force-closed
    // wrapper task with a populated `error` field. Suppressing the wrapper's error here prevents
    // downstream consumers (delivery, audit, UI) from reading a completed status alongside a
    // non-empty error string and judging the step as failed. The race-rescue marker lives in
    // `retryStatusReason = "race-rescue"` and the warning-severity audit_violation row instead.
    const effectiveError = raceRescued && !contractErrorMsg
      ? undefined
      : (contractErrorMsg ?? finalTask?.error);

    const result: StepResult = {
      stepId: step.id,
      taskId,
      status: finalStepStatus,
      roleId,
      roleName: role?.name,
      result: finalTask?.result,
      error: effectiveError,
    };
    context.stepResults.set(step.id, result);
    context.stepStatuses[step.id] = {
      // Preserve Phase 4 validator-loop metadata (validatorAttempt, originalTaskId) from
      // the validator retry loop. Contract verification overwrites all other fields below.
      ...context.stepStatuses[step.id],
      taskId,
      status: result.status,
      roleId,
      result: finalTask?.result,
      error: effectiveError,
      contractRetried: retriedFlag || undefined,
      attempt: retriedFlag ? 2 : dispatchAttempt,
      maxAttempts: retriedFlag ? 2 : this.maxRetries,
      retryReason: retryStatusReason,
      originalTaskId: retriedFlag ? contractOriginalTaskId : undefined,
      retryTaskId: retriedFlag ? taskId : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
    this.persistStepStatuses(context.executionId, context);
  }

  /**
   * D-007: Assemble and deliver TemplateExecution-level result summary.
   * Sends aggregated Markdown to deliverTo targets and a shorter status
   * summary to reportTo targets.
   */
  public async deliverTemplateExecutionResult(
    context: TemplateExecutionContext,
    status: TemplateExecutionResult["status"],
  ): Promise<void> {
    const isFailureReport = status === "failed" || status === "partial" || status === "cancelled";
    // Failure / partial executions can still have many successfully-published artifacts
    // from earlier steps. Drop the old assumption "failure means no attachments" — let
    // the user receive every artifact that actually made it to DB. The fallback branch
    // below may also surface primary-artifact attachments; we union + dedupe by id then.
    let fileArtifacts = getDeliverableFileArtifacts(context.executionId);
    let usedFallbackDelivery = false;
    // Composed payload from the template's declarative delivery manifest (success deliveries only).
    // Null when the template declares no manifest → legacy body + all-file attachments (unchanged).
    const composed = !isFailureReport ? composeDeliveryFromManifest(context.executionId) : null;

    // Assemble full summary for deliverTo — may throw if primary-artifact key is missing
    let summary: string | null = null;
    let deliveryAssemblyError: Error | null = null;

    if (context.deliverTo && context.deliverTo.length > 0) {
      if (isFailureReport) {
        const fallback = tryAssembleFallbackDelivery(
          { executionId: context.executionId, template: context.template, stepResults: context.stepResults },
          status,
          (s) => this.assembleTemplateExecutionFailureReport(context, s),
        );
        if (fallback) {
          summary = fallback.summary;
          // Defensive union: under current implementation fallback.fileArtifacts is always a
          // subset of getDeliverableFileArtifacts(...), so this is a no-op merge. Kept so that
          // a future change to primaryArtifactFileAttachments (cross-execution refs, virtual
          // artifacts) cannot silently drop attachments. De-dupe by artifact.id avoids the
          // primary appearing twice in the common case.
          const merged = [...fileArtifacts];
          for (const a of fallback.fileArtifacts) {
            if (!merged.some((m) => m.id === a.id)) merged.push(a);
          }
          fileArtifacts = merged;
          usedFallbackDelivery = true;
        } else {
          summary = this.assembleTemplateExecutionFailureReport(context, status);
        }
      } else {
        try {
          summary = composed ? composed.content : assembleSummary({ executionId: context.executionId, template: context.template, stepResults: context.stepResults });
        } catch (err) {
          deliveryAssemblyError = err instanceof Error ? err : new Error(String(err));
          log.error({ executionId: context.executionId, templateId: context.templateId, error: deliveryAssemblyError.message }, "Delivery summary assembly failed");
        }
      }

      // Resolve channel targets up-front; non-channel targets are NOT delivered here (matches prior guard).
      const resolvedChannelTargets: Array<{
        target: Extract<NotifyTarget, { type: "channel" }>;
        channel: NonNullable<ReturnType<typeof getChannel>>;
        chatId: string;
      }> = [];
      for (const target of context.deliverTo) {
        if (target.type !== "channel") continue;
        const resolved = this.resolveChannelTarget(target);
        if (!resolved) continue;
        resolvedChannelTargets.push({ target, channel: resolved.channel, chatId: resolved.chatId });
      }

      if (deliveryAssemblyError) {
        // DP-009 (existing): write failed delivery_log row per target, do NOT send the channel message.
        for (const t of resolvedChannelTargets) {
          createDeliveryLog({
            id: `dlog-${context.executionId}-${t.target.channelId}-${Date.now()}`,
            ruleId: undefined,
            taskId: context.executionId,
            status: "failed",
            target: { type: "channel", channelId: t.target.channelId, chatId: t.chatId },
            content: `[Delivery failed] ${deliveryAssemblyError.message}`,
            attempts: 1,
            error: deliveryAssemblyError.message,
            createdAt: Date.now(),
            expiresAt: Date.now() + TTL_MS,
            source: "direct",
            messageType: context.deliveryMessageType ?? "result_delivery",
          });
        }
      } else {
        const messageType = isFailureReport && !usedFallbackDelivery
          ? "report"
          : (context.deliveryMessageType ?? "result_delivery");
        await getOutboundGateway().redeliverExecutionTo({
          executionId: context.executionId,
          targets: resolvedChannelTargets.map((t) => ({ channelId: t.target.channelId, chatId: t.chatId })),
          content: summary!,
          messageType,
          // Manifest path: ship composer-built attachments (raw artifacts go to the email packer).
          // Legacy path: hand the gateway the file artifacts to build attachments itself.
          ...(composed
            ? { attachments: composed.attachments, fileArtifacts: composed.artifacts }
            : { fileArtifacts }),
          actorToolName: "TemplateExecutor.deliver",
        });
      }
    }

    // Assemble short status for reportTo
    if (context.reportTo && context.reportTo.length > 0) {
      const baseReport = this.assembleTemplateExecutionReport(context, status);
      const report = deliveryAssemblyError
        ? `${baseReport}\n\n⚠️ Delivery failed: ${deliveryAssemblyError.message}`
        : baseReport;

      for (const target of context.reportTo) {
        if (target.type === "channel") {
          const resolvedTarget = this.resolveChannelTarget(target);
          if (!resolvedTarget) continue;
          const { channel, chatId } = resolvedTarget;
          await this.sendViaGateway({
            taskId: context.executionId,
            channelId: target.channelId,
            chatId,
            platform: channel?.platform,
            content: report,
            messageType: "report",
          }, { executionId: context.executionId, channelId: target.channelId, phase: "report" });
        } else if (target.type === "session") {
          const delivered = await deliverAssistantMessageToSession({
            sessionId: target.sessionId,
            content: report,
            taskId: context.executionId,
            kind: "status_report",
          });
          if (!delivered) {
            log.warn({ executionId: context.executionId, sessionId: target.sessionId }, "TemplateExecution session report delivery failed");
          }
        }
      }
    } else if (deliveryAssemblyError) {
      // Edge case: cron-triggered template with NO reportTo. Failure is observable only via delivery_log.
      log.error({ executionId: context.executionId, error: deliveryAssemblyError.message }, "Delivery failed but no reportTo configured — failure visible only in delivery_log");
      serverBus.emit({
        type: "cron_no_target_warning",
        executionId: context.executionId,
        templateId: context.templateId,
        reason: "delivery_assembly_failed_no_reportTo",
        timestamp: Date.now(),
      });
    }
  }

  private resolveChannelTarget(target: Extract<NotifyTarget, { type: "channel" }>) {
    const channel = getChannel(target.channelId);
    if (!channel) return undefined;
    const sessions = [...listSessions("active"), ...listSessions("archived")];
    const chatId = target.chatId ?? getDefaultChatIdForChannel(channel, sessions);
    if (!chatId) {
      log.warn({ channelId: target.channelId }, "TemplateExecution channel target has no resolvable chatId");
      return undefined;
    }
    return { channel, chatId };
  }

  private async sendViaGateway(options: OutboundSendOptions, logContext: Record<string, unknown>) {
    try {
      const result = await getOutboundGateway().send(options);
      if (!result.success) {
        log.warn({ ...logContext, logEntryId: result.logEntryId, error: result.error }, "TemplateExecution outbound send failed");
      }
      return result;
    } catch (err) {
      log.error({ ...logContext, error: err }, "TemplateExecution outbound send threw");
      throw err;
    }
  }

  private assembleTemplateExecutionReport(
    context: TemplateExecutionContext,
    status: TemplateExecutionResult["status"],
  ): string {
    const completed = [...context.stepResults.values()].filter((r) => r.status === "completed").length;
    const failed = context.failedStepIds.size;
    const skipped = [...context.stepResults.values()].filter((r) => r.status === "skipped").length;
    const total = context.stepResults.size;
    const statusLabel = status === "completed"
      ? "completed"
      : status === "partial"
        ? "completed with issues"
        : status;
    return `${context.templateName}: ${statusLabel}. Steps: ${completed}/${total} completed${failed > 0 ? `, ${failed} failed` : ""}${skipped > 0 ? `, ${skipped} skipped` : ""}.`;
  }

  private assembleTemplateExecutionFailureReport(
    context: TemplateExecutionContext,
    status: TemplateExecutionResult["status"],
  ): string {
    const failedStep = [...context.stepResults.values()].find((result) => result.status === "failed")
      ?? [...context.stepResults.values()].find((result) => result.status === "cancelled");
    const rootError = failedStep?.error ?? "TemplateExecution ended before producing the configured deliverable.";
    const report = this.assembleTemplateExecutionReport(context, status);
    const lines = [
      report,
      failedStep ? `Failed step: ${failedStep.stepId}` : undefined,
      `Root error: ${rootError}`,
    ].filter((line): line is string => Boolean(line));

    const warnings = [...context.stepResults.values()]
      .flatMap((result) => this.extractExplicitWarnings(result.result))
      .slice(0, 10);
    if (warnings.length > 0) {
      lines.push("", "Warnings:", ...warnings.map((warning) => `- ${warning}`));
    }
    return lines.join("\n");
  }

  private applyGoalReviewResults(context: TemplateExecutionContext): void {
    for (const meta of context.goalSteps) {
      const reviewResult = context.stepResults.get(meta.reviewStepId);
      const parsed = parseGoalReviewResult(reviewResult?.result);
      if (!parsed) {
        log.warn({ executionId: context.executionId, goalId: meta.goal.id, reviewStepId: meta.reviewStepId }, "Goal review result missing or malformed; Goal unchanged");
        continue;
      }

      const updates: Partial<Goal> = { updatedAt: Date.now() };
      if (parsed.currentValue !== undefined) {
        updates.currentValue = parsed.currentValue;
      }

      if (parsed.goalAchieved === true || parsed.status === "completed") {
        updates.status = "completed";
        updates.currentValue = Math.max(parsed.currentValue ?? meta.goal.currentValue, meta.goal.targetValue);
      } else if (parsed.status === "failed") {
        updates.status = "failed";
      } else if (parsed.goalAchieved === false || parsed.status === "active") {
        updates.status = "active";
      }

      updateGoal(meta.goal.id, updates);
      log.info(
        {
          executionId: context.executionId,
          goalId: meta.goal.id,
          status: updates.status,
          currentValue: updates.currentValue,
          reason: parsed.reason,
        },
        "Goal review applied",
      );
    }
  }

  /**
   * Resolve {{stepId.result}} variables in prompt.
   */
  private resolveVariables(
    prompt: string,
    stepResults: Map<string, StepResult>,
  ): string {
    return prompt.replace(/\{\{([^}]+)\.result\}\}/g, (_match, varName) => {
      const result = stepResults.get(varName);
      return result?.result ?? `[no result from ${varName}]`;
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isTemplateExecutionCancelled(executionId: string): boolean {
    return getTemplateExecution(executionId)?.status === "cancelled";
  }

  private async finalizeFailedTemplateExecution(
    template: TaskTemplate,
    context: TemplateExecutionContext,
    stepResult: StepResult,
  ): Promise<TemplateExecutionResult> {
    const finalStatus = "failed";
    // Phase 2 DP-001: persist step results for post-hoc redelivery
    setExecutionStepResults(context.executionId, context.stepResults);
    updateTemplateExecution(context.executionId, {
      status: finalStatus,
      stepStatuses: context.stepStatuses,
      completedAt: Date.now(),
      error: stepResult.error,
    });
    serverBus.emit({
      type: "template_execution_status_change",
      executionId: context.executionId,
      templateId: template.id,
      status: finalStatus,
    });
    log.warn({ stepId: stepResult.stepId, executionId: context.executionId }, "TemplateExecution step failed, template execution aborted");
    await this.deliverTemplateExecutionResult(context, finalStatus);
    return { executionId: context.executionId, status: finalStatus, stepResults: context.stepResults };
  }

  private async finalizeCancelledTemplateExecution(
    template: TaskTemplate,
    context: TemplateExecutionContext,
  ): Promise<TemplateExecutionResult> {
    const execution = getTemplateExecution(context.executionId);
    // Phase 2 DP-001: persist step results for post-hoc redelivery
    setExecutionStepResults(context.executionId, context.stepResults);
    updateTemplateExecution(context.executionId, {
      status: "cancelled",
      stepStatuses: execution?.stepStatuses ?? context.stepStatuses,
      completedAt: execution?.completedAt ?? Date.now(),
      error: execution?.error,
    });
    log.info({ executionId: context.executionId, templateId: template.id }, "TemplateExecution cancelled");
    await this.deliverTemplateExecutionResult(context, "cancelled");
    return {
      executionId: context.executionId,
      status: "cancelled",
      stepResults: context.stepResults,
    };
  }

  /**
   * Phase 2 retry: dispatch ONE additional task with caller-supplied feedback prepended.
   * Runs OUTSIDE the maxRetries loop — single retry cap, not folded into transient failure retry.
   * Layer B retry and Layer A length-retry both use this helper with caller-built feedback.
   */
  private async retryStepWithFeedback(args: {
    step: TaskStep;
    originalTaskId: string;
    executionId: string;
    feedbackBlock: string;  // caller constructs the entire feedback block (including XML wrapper)
    role: Role | undefined;
    roleId: string | undefined;
    context: TemplateExecutionContext;
    finalPrompt: string;
  }): Promise<RetryResult> {
    const { step, executionId, feedbackBlock, role, roleId, context, finalPrompt } = args;

    const retryPrompt = `${feedbackBlock}\n\n${finalPrompt}`;

    const dispatchResult = await withNewTrace("template" as const, () => createTaskWithAdmission({
      prompt: retryPrompt,
      roleId: roleId ?? "",
      requirements: step.requirements,
      autoSelectRole: step.autoSelectRole,
      config: {
        ...context.config,
        ...(step.config?.timeout !== undefined ? { timeout: step.config.timeout } : {}),
        ...(step.config?.maxTurns !== undefined ? { maxTurns: step.config.maxTurns } : {}),
      },
      parentId: executionId,
      templateId: context.templateId,
      stepId: step.id,
      dispatchSource: "template_step_dispatch",
    }));

    if (!dispatchResult.ok) {
      return {
        layerAPassed: false,
        taskId: "",
        finalTask: undefined,
        admissionError: dispatchResult.reason,
        layerAViolations: undefined,
      };
    }

    const retryTaskId = dispatchResult.taskId;
    context.stepStatuses[step.id] = { taskId: retryTaskId, status: "running", roleId };
    this.persistStepStatuses(executionId, context);

    // Mirror the outputContractCheckCount onto the retry task so its contractCompliance
    // can be computed by computeTaskScore. Uses the shared countCheckedContracts helper so
    // any future contract dimension is automatically counted in both sites.
    const retryContractsChecked = countCheckedContracts(step);
    if (retryContractsChecked > 0) {
      updateTaskConfig(retryTaskId, { outputContractCheckCount: retryContractsChecked });
    }

    const retryTimeoutMs = ((step.config?.timeout ?? context.config?.timeout ?? 600)) * 1000;
    const retryStatus = await waitForTaskCompletion(retryTaskId, retryTimeoutMs);

    if (retryStatus !== "completed") {
      return { layerAPassed: false, taskId: retryTaskId, finalTask: getTask(retryTaskId), layerAViolations: undefined };
    }

    const retryTask = getTask(retryTaskId);
    const layerAResult = runLayerA({ step, executionId: context.executionId, taskId: retryTaskId });

    if (!layerAResult.passed) {
      return {
        layerAPassed: false,
        taskId: retryTaskId,
        finalTask: retryTask,
        layerAViolations: layerAResult,
        admissionError: undefined,
      };
    }

    return { layerAPassed: true, taskId: retryTaskId, finalTask: retryTask, layerAViolations: undefined };
  }

  /**
   * Builds a precise per-field retry feedback block for content-fixable Layer A violations
   * (length / format / persona). Each violation maps to a concrete corrective instruction so the
   * producer can self-correct on retry — the harness "error feedback = harness" principle applied
   * to the legacy Layer A path (previously only length-only violations got feedback; format and
   * persona violations failed immediately with no retry).
   */
  private buildLayerAContentFeedback(
    violations: LayerAResult["violations"],
    step: TaskStep,
  ): string {
    const lines: string[] = [];
    const lengthRule = step.outputContract?.contractRules?.find((r) => r.kind === "lengthTarget");
    const lt = lengthRule && lengthRule.kind === "lengthTarget" ? lengthRule : undefined;
    for (const v of violations) {
      if (v.contractField === "lengthTarget" && lt) {
        const actual = v.actual ?? null;
        const isTooShort = actual !== null && actual < lt.min;
        lines.push(
          `- Length: your output was ${actual ?? "?"} ${lt.unit}, but the contract requires ${lt.min}-${lt.max} ${lt.unit}. ${isTooShort ? "Expand with more specific details, examples, or arguments; do not pad." : "Condense by removing redundancy; do not drop substantive content."}`,
        );
      } else if (v.contractField === "format") {
        lines.push(
          `- Format: ${v.message}. Output the raw Markdown body only — begin with a \`# \` heading and use \`## \` for sections. Do NOT wrap the content in a JSON envelope like {"content": "..."}, and do not substitute 【】 for Markdown headings.`,
        );
      } else if (v.contractField === "persona.speakAs") {
        lines.push(
          `- Persona: ${v.message}. Write strictly in the first person as "${step.persona?.speakAs ?? ""}". Never write 我是<another role name> or otherwise identify as a different role — you ARE "${step.persona?.speakAs ?? ""}" for this output.`,
        );
      } else {
        lines.push(`- ${v.contractField}: ${v.message}`);
      }
    }
    return `<contract_feedback>
Your previous output was rejected by the contract verifier:
${lines.join("\n")}
Rewrite your output to satisfy every point above. Keep referencing the same upstream artifacts.
</contract_feedback>`;
  }

  private formatContractError(
    layerAResult: LayerAResult | null,
    layerBResult: LayerBResult | null,
    contractStatus: "fail-A" | "fail-B" | "retried-fail",
    retriedResult: RetryResult | null,
    retryReason: TemplateExecutionStepStatus["retryReason"] | null = null,
  ): string {
    if (contractStatus === "fail-A") {
      const msgs = (layerAResult?.violations ?? []).map((v) => v.message);
      return `契约校验失败（Layer A）：${msgs.join("；")}`;
    }
    if (contractStatus === "fail-B") {
      return `契约校验失败（Layer B 信心不足，confidence=${layerBResult?.confidence ?? "unknown"}）`;
    }
    // retried-fail: discriminate length retry vs verifier retry for operator clarity
    if (retriedResult?.admissionError) {
      return `契约重试派发失败：${retriedResult.admissionError}`;
    }
    if (retriedResult?.layerAViolations) {
      const msgs = retriedResult.layerAViolations.violations.map((v) => v.message);
      const reasonLabel = retryReason === "length"
        ? "length retry"
        : retryReason === "format"
          ? "format retry"
          : retryReason === "persona"
            ? "persona retry"
            : retryReason === "verifier"
              ? "verifier retry"
              : "retry";
      return `契约校验失败（${reasonLabel}）：${msgs.join("；")}`;
    }
    return "契约重试后仍失败";
  }

  private formatMissingOutputError(step: TaskStep): string {
    const stepName = (step as TaskStep & { name?: string }).name ?? step.id;
    return `Step "${stepName}" declares outputAs="${step.outputAs}" but no artifact was published with that key.`;
  }

  private async dispatchNudge(
    context: TemplateExecutionContext,
    step: TaskStep,
    priorTaskId: string,
    roleId: string,
    timeoutMs: number,
  ): Promise<{ taskId: string; status: "completed" | "failed" | "cancelled" | "no_content" }> {
    // Framing-first (DP-003 Chosen B): nudge instructions come before upstream artifacts.
    // This matches Anthropic's prompting guide recommendation (instructions near the top).
    const nudgeFraming = buildNudgePrompt({
      priorTaskId,
      outputAs: step.outputAs!,
      maxTurns: step.config?.maxTurns ?? 50,
    });
    const upstream = assembleUpstreamArtifactsBlock({ step, executionId: context.executionId });
    const nudgePrompt = upstream.block
      ? `${nudgeFraming}\n\n## Reference: Upstream Artifacts From Original Attempt\n${upstream.block}`
      : nudgeFraming;

    const nudgeDispatch = await withNewTrace("template", async () =>
      createTaskWithAdmission({
        prompt: nudgePrompt,
        roleId,
        autoSelectRole: false,
        config: {
          ...context.config,
          timeout: 600, // 10 min — covers ls + multiple publish_artifact_file calls if step produced several files
          maxTurns: 50, // generous; coding plan budget can absorb the worst case
        },
        parentId: context.executionId,
        templateId: context.templateId,
        stepId: step.id,
        dispatchSource: "template_step_nudge",
      }),
    );

    if (!nudgeDispatch.ok) {
      return { taskId: "", status: "failed" };
    }

    const finalStatus = await waitForTaskCompletion(nudgeDispatch.taskId, timeoutMs);
    return { taskId: nudgeDispatch.taskId, status: finalStatus === "blocked" ? "failed" : finalStatus };
  }

  private extractExplicitWarnings(text?: string): string[] {
    if (!text) return [];
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("WARNING:") || line.startsWith("⚠️"))
      .slice(0, 20);
  }

  private mapLayerAContractField(field: LayerAResult["violations"][number]["contractField"]): AuditViolation["contractField"] {
    if (field === "lengthTarget") return "lengthTarget";
    if (field === "format") return "format";
    if (field === "outputAs") return "outputAs";
    return "persona.speakAs";
  }
}

export interface RetryResult {
  layerAPassed: boolean;
  taskId: string;
  finalTask: ReturnType<typeof getTask>;
  layerAViolations?: LayerAResult;
  admissionError?: string;
}
