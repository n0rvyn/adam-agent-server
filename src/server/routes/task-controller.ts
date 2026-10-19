import { updateTask, getTask } from "../../store/tasks.js";
import { updateTaskPlanStatus, getTaskPlan } from "../../store/task-plans.js";
import { createApprovalRule } from "../../store/approval-rules.js";
import { getLogger } from "../../lib/logger.js";
import { serverBus } from "../../server/events/server-bus.js";
import * as crypto from "node:crypto";

/**
 * Task Controller - provides task cancellation and approval resolution.
 * ChatManager + ExecutionPool architecture. No IPC.
 * All state changes go through DB + serverBus.
 */
const log = getLogger("api");
const abortableStatuses = new Set(["pending", "queued", "running", "paused"]);

export class TaskController {
  cancelTask(taskId: string): void {
    const task = getTask(taskId);
    if (!task) return;

    // Update task status to cancelled in DB
    updateTask(taskId, {
      status: "cancelled",
      completedAt: Date.now(),
    });

    // Emit status change event for Manager to pick up
    serverBus.emit({
      type: "task_status_change",
      taskId,
      oldStatus: task.status,
      newStatus: "cancelled",
    });
    if (abortableStatuses.has(task.status)) {
      serverBus.emit({ type: "task_abort_requested", taskId, reason: "cancelled" });
    }

    log.debug({ taskId, oldStatus: task.status }, "Task cancelled");
  }

  resolveApproval(approvalId: string, action: "allow" | "deny", reason?: string): boolean {
    // In Pure C, tool approval is handled by canUseTool callback in-process.
    // The REST endpoint becomes a no-op — the pending approval is tracked in-memory.
    // Return true to satisfy the API contract.
    log.debug({ approvalId, action, reason }, "Approval resolved (no-op in Pure C)");
    return true;
  }

  resolvePlanApproval(
    planId: string,
    decision: "allow" | "deny",
    approvalType?: "once" | "permanent",
    reason?: string,
  ): boolean {
    const plan = getTaskPlan(planId);
    if (!plan) {
      log.warn({ planId }, "Plan not found or already resolved");
      return false;
    }

    const task = getTask(plan.taskId);
    if (!task) {
      log.warn({ planId }, "Task not found for plan");
      return false;
    }

    // Update plan status in DB
    updateTaskPlanStatus(planId, decision === "allow" ? "approved" : "denied", approvalType);

    // If permanent approval, create rule
    if (decision === "allow" && approvalType === "permanent") {
      createApprovalRule({
        id: crypto.randomUUID(),
        roleId: plan.roleId,
        taskPattern: task.prompt.slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        maxRiskLevel: plan.plan.overallRisk,
        createdAt: Date.now(),
        createdByTaskId: task.id,
      });
    }

    // Emit decision event for WebSocket broadcast
    serverBus.emit({
      type: "plan_approval_decision",
      taskId: task.id,
      planId,
      decision,
      approvalType,
      reason,
    });

    log.debug({ planId, decision, approvalType }, "Plan approval resolved");
    return true;
  }
}
