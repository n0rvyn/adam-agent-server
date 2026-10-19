/**
 * TemplateExecution routes: list, detail, cancel, and step skip.
 * Crystal ref: D-005, D-011 (Issue #154)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import {
  getTemplateExecution,
  listTemplateExecutions,
  updateTemplateExecution,
} from "../../store/template-executions.js";
import { listTasksByParent, getTask } from "../../store/tasks.js";
import { getViolationsByExecution } from "../../store/audit-violations.js";
import { getDeliveryLogByTask } from "../../store/delivery-log.js";
import type { AuditViolation } from "../../shared/types.js";
import { getTaskTemplate } from "../../store/task-templates.js";
import { TaskController } from "./task-controller.js";
import { serverBus } from "../events/server-bus.js";
import { publicTaskView } from "../../security/redaction.js";

const taskController = new TaskController();

const paramsSchema = z.object({
  id: z.string().min(1),
});

const stepSkipParamsSchema = z.object({
  id: z.string().min(1),
  stepId: z.string().min(1),
});

export async function templateExecutionRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /template-executions: list recent executions
  fastify.get("/template-executions", {
    schema: {
      tags: ["Template Executions"],
      summary: "List template executions",
      description: "List recent TemplateExecutions, optionally filtered by templateId.",
      querystring: {
        type: "object",
        properties: {
          templateId: { type: "string", description: "Filter by template ID" },
          limit: { type: "number", default: 50 },
          offset: { type: "number", default: 0 },
        },
      },
    },
  }, async (request: FastifyRequest) => {
    const query = request.query as { templateId?: string; limit?: number; offset?: number };
    const executions = listTemplateExecutions(query.templateId, query.limit ?? 50, query.offset ?? 0);
    return { executions };
  });

  // GET /template-executions/:id: get execution details
  fastify.get("/template-executions/:id", {
    schema: {
      tags: ["Template Executions"],
      summary: "Get template execution",
      description: "Get details of a specific TemplateExecution including step statuses.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const parse = paramsSchema.safeParse(request.params);
    if (!parse.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parse.error) });

    const execution = getTemplateExecution(parse.data.id);
    if (!execution) return reply.status(404).send({ code: "NOT_FOUND", message: "Template execution not found" });

    // Include step tasks for richer detail
    const stepTasks = listTasksByParent(parse.data.id);

    // Attach contract verdicts per step by grouping violations by step_task_id
    const violations = getViolationsByExecution(parse.data.id);
    const violationsByStep: Record<string, AuditViolation[]> = {};
    for (const v of violations) {
      if (!violationsByStep[v.stepTaskId]) violationsByStep[v.stepTaskId] = [];
      violationsByStep[v.stepTaskId].push(v);
    }

    // Load template once for Layer C custom assertions lookup.
    // template can be null if the template was deleted after execution started — fall through gracefully.
    const template = execution.templateId ? getTaskTemplate(execution.templateId) : null;

    // Merge contract info into stepStatuses
    const enrichedStepStatuses: Record<string, typeof execution.stepStatuses[string] & {
      contract?: {
        layerAPassed: boolean;
        layerBPassed: boolean | null;
        layerCPassed: boolean | null;
        violations: AuditViolation[];
      };
    }> = {};

    for (const [stepId, stepStatus] of Object.entries(execution.stepStatuses)) {
      const taskId = stepStatus.taskId;
      // Only attach contract info for steps where contract verification actually ran.
      // outputContractCheckCount is set in the contract block at executeStep when
      // the step has outputContract or persona declared.
      const taskRow = taskId ? getTask(taskId) : undefined;
      const checkCount = (taskRow?.config?.outputContractCheckCount as number | undefined) ?? 0;
      const stepViolations = taskId ? (violationsByStep[taskId] ?? []) : [];
      if (!taskId || (checkCount === 0 && stepViolations.length === 0)) {
        enrichedStepStatuses[stepId] = stepStatus;
        continue;
      }
      const layerAViolations = stepViolations.filter((v) => v.layer === "A");
      const layerBViolations = stepViolations.filter((v) => v.layer === "B");
      const layerCViolations = stepViolations.filter((v) => v.layer === "C");
      const layerAPassed = layerAViolations.length === 0;
      // Layer B only runs when Layer A passed (per the contract block).
      // If Layer A failed → Layer B never ran (null). If Layer A passed → Layer B
      // passed iff no Layer B violations recorded.
      const layerBPassed = layerAPassed ? layerBViolations.length === 0 : null;
      // layerCPassed semantics:
      //   - null when template was deleted (cannot determine — fail safe to null)
      //   - null when step has no customAssertions declared (Layer C did not run)
      //   - true when customAssertions present and no Layer C violations
      //   - false when customAssertions present and >=1 Layer C violation
      const stepDef = template?.steps?.find((s) => s.id === stepId) ?? null;
      const hasCustomAssertions = !!(stepDef?.outputContract?.customAssertions)
        && stepDef.outputContract.customAssertions.length > 0;
      const layerCPassed: boolean | null = !stepDef
        ? null
        : (!hasCustomAssertions ? null : (layerCViolations.length === 0));
      enrichedStepStatuses[stepId] = {
        ...stepStatus,
        contract: { layerAPassed, layerBPassed, layerCPassed, violations: stepViolations },
      };
    }

    const executionView = { ...execution, stepStatuses: enrichedStepStatuses };

    return {
      execution: executionView,
      runView: buildRunView(executionView),
      stepTasks: stepTasks.map(publicTaskView),
      deliveryLog: getDeliveryLogByTask(execution.id, 50),
    };
  });

  // POST /template-executions/:id/cancel: cancel a running execution
  fastify.post("/template-executions/:id/cancel", {
    schema: {
      tags: ["Template Executions"],
      summary: "Cancel a template execution",
      description: "Cancel all running/pending step tasks in a TemplateExecution.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const parse = paramsSchema.safeParse(request.params);
    if (!parse.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parse.error) });

    const execution = getTemplateExecution(parse.data.id);
    if (!execution) return reply.status(404).send({ code: "NOT_FOUND", message: "Template execution not found" });

    if (execution.status !== "running") {
      return reply.status(400).send({ code: "INVALID_STATE", message: `Cannot cancel template execution in status: ${execution.status}` });
    }

    // Cancel all cancellable step tasks
    const stepTasks = listTasksByParent(parse.data.id);
    const cancellable = new Set(["pending", "running", "queued", "paused"]);
    let cancelled = 0;
    const updatedStatuses = { ...execution.stepStatuses };
    for (const task of stepTasks) {
      if (cancellable.has(task.status)) {
        taskController.cancelTask(task.id);
        if (task.stepId) {
          updatedStatuses[task.stepId] = {
            taskId: task.id,
            status: "cancelled",
            roleId: task.roleId,
            error: "Template execution cancelled",
          };
        }
        cancelled++;
      }
    }

    // Update TemplateExecution status
    updateTemplateExecution(parse.data.id, {
      status: "cancelled",
      stepStatuses: updatedStatuses,
      completedAt: Date.now(),
    });
    serverBus.emit({
      type: "template_execution_status_change",
      executionId: parse.data.id,
      templateId: execution.templateId,
      status: "cancelled",
    });

    return { executionId: parse.data.id, cancelled, total: stepTasks.length };
  });

  // POST /template-executions/:id/steps/:stepId/skip: skip a pending step
  fastify.post("/template-executions/:id/steps/:stepId/skip", {
    schema: {
      tags: ["Template Executions"],
      summary: "Skip a template execution step",
      description: "Mark a pending step as skipped without cancelling the whole TemplateExecution. Dependents of the skipped step will also be skipped.",
      params: {
        type: "object",
        required: ["id", "stepId"],
        properties: {
          id: { type: "string" },
          stepId: { type: "string" },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string; stepId: string } }>, reply: FastifyReply) => {
    const parse = stepSkipParamsSchema.safeParse(request.params);
    if (!parse.success) return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parse.error) });

    const execution = getTemplateExecution(parse.data.id);
    if (!execution) return reply.status(404).send({ code: "NOT_FOUND", message: "Template execution not found" });

    const stepStatus = execution.stepStatuses[parse.data.stepId];
    if (!stepStatus) return reply.status(404).send({ code: "NOT_FOUND", message: "Step not found in template execution" });

    // Cancel the step's task if it's running/pending
    if (stepStatus.taskId) {
      const task = getTask(stepStatus.taskId);
      if (task && ["pending", "running", "queued", "paused"].includes(task.status)) {
        taskController.cancelTask(stepStatus.taskId);
      }
    }

    // Update step status to skipped
    const updatedStatuses = { ...execution.stepStatuses };
    updatedStatuses[parse.data.stepId] = {
      ...stepStatus,
      status: "skipped",
      error: "Manually skipped",
    };
    updateTemplateExecution(parse.data.id, { stepStatuses: updatedStatuses });

    return { executionId: parse.data.id, stepId: parse.data.stepId, status: "skipped" };
  });
}

function buildRunView(execution: {
  id: string;
  templateId: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
  stepStatuses: Record<string, {
    taskId?: string;
    status: string;
    result?: string;
    error?: string;
    contractRetried?: boolean;
    attempt?: number;
    maxAttempts?: number;
    retryReason?: string;
    originalTaskId?: string;
    retryTaskId?: string;
    warnings?: string[];
  }>;
}) {
  const steps = Object.entries(execution.stepStatuses).map(([stepId, status]) => ({ stepId, ...status }));
  const failedStep = steps.find((step) => step.status === "failed");
  const warnings = steps.flatMap((step) => {
    const explicit = step.warnings ?? extractExplicitWarnings(step.result);
    return explicit.map((message) => ({ stepId: step.stepId, message }));
  });
  const retries = steps
    .filter((step) => step.contractRetried || step.retryReason || step.attempt !== undefined)
    .map((step) => ({
      stepId: step.stepId,
      taskId: step.taskId,
      attempt: step.attempt,
      maxAttempts: step.maxAttempts,
      retryReason: step.retryReason,
      originalTaskId: step.originalTaskId,
      retryTaskId: step.retryTaskId,
      error: step.error,
    }));

  return {
    id: execution.id,
    templateId: execution.templateId,
    status: execution.status,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    failedStepId: failedStep?.stepId,
    rootError: execution.error ?? failedStep?.error,
    retries,
    warnings,
  };
}

function extractExplicitWarnings(text?: string): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("WARNING:") || line.startsWith("⚠️"))
    .slice(0, 20);
}
