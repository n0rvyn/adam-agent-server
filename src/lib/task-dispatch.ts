/**
 * Centralized task creation with admission control.
 *
 * All task creation entry points (dispatch_task MCP tool, POST /tasks, template
 * executor, bree-engine, decompose_goal) route through admitTask() to validate
 * that the target role satisfies the task requirements before creating the task
 * record with a frozen executionProfile snapshot.
 *
 * D-002, D-003, D-005, D-006
 */

import { v4 as uuidv4 } from "uuid";
import { admitTask, type AdmitTaskInput } from "./task-admission.js";
import type {
  Task,
  TaskConfig,
  TaskRequirements,
  NotifyTarget,
  EffectivePermissions,
  AdmissionResult,
} from "../shared/types.js";
import { createTask } from "../store/tasks.js";
import { getRuntimeConfig } from "../config/runtime.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { StrategyEngine } from "../strategy/engine.js";
import { recordRoutingDecision } from "../store/manager-decisions.js";
import { writeMutationReceipt } from "../audit/mutation-receipt-writer.js";

export interface CreateTaskInput {
  prompt: string;
  roleId?: string;
  requirements?: TaskRequirements;
  autoSelectRole?: boolean;
  deliverTo?: NotifyTarget[];
  reportTo?: NotifyTarget[];
  toolOverrides?: {
    allowedTools?: string[];
    disallowedTools?: string[];
  };
  config?: Partial<TaskConfig>;
  sourceSessionId?: string;
  /** Parent task or TemplateExecution ID. Set by template-executor for step tasks. */
  parentId?: string;
  /** Template ID for tasks launched via task_templates. */
  templateId?: string;
  /** Template step ID. Set by template-executor to correlate step → task. */
  stepId?: string;
  /** Explicit trace ID. If omitted, taken from AsyncLocalStorage via createTask's fallback. */
  traceId?: string;
  /**
   * Name of the dispatching tool or code path — used as actor.toolName in the
   * task-creation effect receipt. Examples: 'dispatch_task', 'chat_manager_retry',
   * 'template_step_dispatch', 'rest_api', 'contract_verifier', 'decompose_goal_subtask'.
   */
  dispatchSource?: string;
  /**
   * Step functional category — propagated from TaskStep.kind.
   * Stored in task.config.stepKind for belief scope labeling.
   */
  stepKind?: string;
}

export interface CreateTaskSuccess {
  ok: true;
  taskId: string;
  roleId: string;
  requirements: TaskRequirements;
  fitScore: number;
  strategyId?: string;
  warnings: Array<{ code: string; tools: string[]; expectedPromptCount: number }>;
}

export interface CreateTaskFailure {
  ok: false;
  code: string;
  reason: string;
  requirements?: TaskRequirements;
  missing?: {
    tools?: string[];
    paths?: Array<{ path: string; access: string }>;
    osCapabilities?: Array<{ id: string }>;
    plugins?: string[];
    network?: boolean;
  };
  candidates?: Array<{
    roleId: string;
    name: string;
    fitScore: number;
    missing?: CreateTaskFailure["missing"];
  }>;
}

/**
 * Determine task type from prompt keywords for Thompson Sampling strategy selection.
 */
function inferTaskType(prompt: string): string {
  const lower = prompt.toLowerCase();
  const keywords: Record<string, string[]> = {
    coding: ["code", "implement", "fix", "debug", "refactor", "build"],
    analysis: ["analyze", "data", "report", "statistics", "investigate"],
    content: ["write", "translate", "summarize", "content", "draft"],
    review: ["review", "check", "audit", "evaluate", "assess"],
    admin: ["config", "permission", "deploy", "manage"],
  };
  for (const [type, kws] of Object.entries(keywords)) {
    if (kws.some((kw) => lower.includes(kw))) {
      return type;
    }
  }
  return "general";
}

/**
 * Create a task with admission control.
 *
 * Validates role compatibility via admitTask(), freezes the executionProfile,
 * applies tool overrides, selects strategy, and persists the task record.
 *
 * Returns CreateTaskSuccess on admission success, CreateTaskFailure on rejection.
 */
export async function createTaskWithAdmission(
  input: CreateTaskInput,
): Promise<CreateTaskSuccess | CreateTaskFailure> {
  const { prompt, roleId, requirements, autoSelectRole, deliverTo, reportTo, toolOverrides, config, sourceSessionId, parentId, templateId, stepId, traceId, dispatchSource, stepKind } = input;

  let runtimeConfig: ReturnType<typeof getRuntimeConfig>;
  try {
    runtimeConfig = getRuntimeConfig();
  } catch {
    // Runtime config not initialized (test context) — use static defaults
    runtimeConfig = DEFAULT_CONFIG as ReturnType<typeof getRuntimeConfig>;
  }
  const taskId = uuidv4();

  // Determine task type for Thompson Sampling
  const taskType = inferTaskType(prompt);

  // === Admission check ===
  const admissionInput: AdmitTaskInput = {
    taskId,
    requirements,
    roleId,
    autoSelectRole,
  };

  const admission = await admitTask(admissionInput);

  if (!admission.ok) {
    // D-004: structured failure with ranked candidates
    return {
      ok: false,
      code: admission.code,
      reason: admission.reason,
      requirements,
      missing: admission.missing,
      candidates: admission.candidates,
    };
  }

  // === Admission succeeded — build frozen executionProfile ===
  const { executionProfile } = admission;
  const selectedRoleId = admission.roleId;

  // Thompson Sampling strategy selection
  let strategyId: string | undefined;
  let augmentedPrompt = prompt;
  const strategy = StrategyEngine.selectStrategy(selectedRoleId, taskType);
  if (strategy?.promptTemplate) {
    augmentedPrompt = `${strategy.promptTemplate}\n\n## Task\n${prompt}`;
    strategyId = strategy.id;
  }

  // Build effective permissions from frozen profile + defaults
  const defaults = runtimeConfig.defaults;
  const profilePerms: EffectivePermissions = {
    allowedTools: executionProfile.allowedTools ?? [],
    disallowedTools: executionProfile.disallowedTools ?? [],
    approvalRequired: executionProfile.approvalRequired ?? [],
    maxBudgetUsd: executionProfile.maxBudgetUsd ?? defaults.maxBudgetUsd,
    plugins: [], // resolved at execution time
  };

  // Intersect with platform defaults
  const effective: EffectivePermissions = {
    allowedTools: intersectOrDefault(profilePerms.allowedTools, defaults.allowedTools),
    disallowedTools: unionArray(profilePerms.disallowedTools, defaults.disallowedTools),
    approvalRequired: unionArray(profilePerms.approvalRequired, defaults.approvalRequired),
    maxBudgetUsd: profilePerms.maxBudgetUsd > 0
      ? Math.min(profilePerms.maxBudgetUsd, defaults.maxBudgetUsd)
      : defaults.maxBudgetUsd,
    plugins: unionArray(profilePerms.plugins, defaults.plugins ?? []),
  };

  // Apply tool overrides from dispatch args
  let allowedTools = effective.allowedTools;
  if (toolOverrides?.allowedTools) {
    allowedTools = toolOverrides.allowedTools;
  }

  const fullConfig: TaskConfig = {
    timeout: config?.timeout ?? defaults.timeout,
    approvalRequired: effective.approvalRequired,
    approvalTimeout: config?.approvalTimeout ?? defaults.approvalTimeout,
    allowedTools,
    disallowedTools: toolOverrides?.disallowedTools ?? effective.disallowedTools,
    maxTurns: config?.maxTurns ?? defaults.maxTurns,
    maxBudgetUsd: effective.maxBudgetUsd,
    mcpServers: config?.mcpServers,
    model: config?.model ?? executionProfile.model ?? defaults.model,
    effort: config?.effort ?? defaults.effort,
    effortTier: config?.effortTier,
    settingSources: config?.settingSources ?? defaults.settingSources,
    workspacePath: config?.workspacePath,
    env: config?.env ?? defaults.env,
    claudeCodePath: defaults.claudeCodePath,
    plugins: config?.plugins ?? effective.plugins,
    // Freeze executionProfile (D-006)
    requirements,
    executionProfile,
    stepKind: stepKind ?? config?.stepKind,
  };

  const task: Task = {
    id: taskId,
    status: "pending",
    prompt: augmentedPrompt,
    originalPrompt: prompt,
    roleId: selectedRoleId,
    parentId,
    templateId,
    stepId,
    deliverTo,
    reportTo,
    config: fullConfig,
    sourceSessionId,
    createdAt: Date.now(),
    traceId: input.traceId,
  };

  createTask(task);

  // Phase 4: write entity_mutation receipt for task creation. One central call covers
  // all 9 createTaskWithAdmission production sites (chat-manager.retryTask, 4 adam-tools
  // dispatch_* tools, REST POST /tasks, 2 template-executor step-dispatch sites, contract-verifier).
  writeMutationReceipt({
    toolName: dispatchSource ?? "createTaskWithAdmission",
    entityType: "task",
    verb: "create",
    entityId: taskId,
    fieldChanges: [
      {
        path: "_entity",
        op: "set",
        before: null,
        after: {
          id: taskId,
          prompt: prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt,
          roleId: selectedRoleId,
          status: "pending",
          templateId,
          stepId,
          parentId,
          deliverTo,
          reportTo,
        },
      },
    ],
    taskId,
    sessionId: sourceSessionId,
    roleId: selectedRoleId,
    traceIdOverride: traceId,
  });

  // D-005: audit routing decision — write AFTER createTask so FK constraint satisfied
  if (admission.auditCandidates) {
    recordRoutingDecision({
      taskId,
      chosenRoleId: selectedRoleId,
      requirements: requirements ?? {},
      fitScore: admission.fitScore,
      tieBreakReason: admission.tieBreakReason,
      candidates: admission.auditCandidates,
    });
  }

  // Emit task_created so ExecutionPool picks it up
  const { serverBus } = await import("../server/events/server-bus.js");
  serverBus.emit({ type: "task_created", taskId });

  return {
    ok: true,
    taskId,
    roleId: selectedRoleId,
    requirements: requirements ?? {},
    fitScore: admission.fitScore,
    strategyId,
    warnings: admission.warnings,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function intersectOrDefault(roleList?: string[], defaultList?: string[]): string[] {
  if (!roleList?.length) return defaultList ?? [];
  if (!defaultList?.length) return roleList;
  return roleList.filter((t) => defaultList.includes(t));
}

function unionArray<T>(a: T[] = [], b: T[] = []): T[] {
  const seen = new Set<T>(a);
  for (const item of b) {
    seen.add(item);
  }
  return [...seen];
}
