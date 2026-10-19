import { EventEmitter } from "node:events";
import type { ChatSession, ChatMessage, ExecutionPlan, DeliveryTarget, DeliveryStatus } from "../../shared/types.js";

export type GlobalEvent =
  | { type: "task_status_change"; taskId: string; oldStatus: string; newStatus: string }
  | { type: "approval_request"; taskId: string; approvalId: string; toolName: string; toolInput: Record<string, unknown>; matchedPattern: string }
  | { type: "stats_update"; activeTasks: number; queuedTasks: number; totalCostToday: number }
  | { type: "task_complete_event"; taskId: string; result?: string; error?: string }
  | { type: "task_created"; taskId: string }
  | { type: "task_abort_requested"; taskId: string; reason: "cancelled" | "inactivity_timeout" | "watchdog_stale_running" }
  | { type: "execution_slot_change"; active: number; max: number; queued: number }
  | { type: "execution_task_start"; taskId: string; slotIndex: number }
  | { type: "execution_task_end"; taskId: string; slotIndex: number; status: "completed" | "failed" | "blocked" | "cancelled" }
  | { type: "goal_status_change"; goalId: string; oldStatus: string; newStatus: string }
  | { type: "strategy_selected"; goalId: string; strategyId: string }
  | { type: "log_event"; timestamp: number; level: string; component: string; msg: string; metadata?: unknown }
  | { type: "config_changed"; changes: { path: string; value: unknown }[] }
  | { type: "session_created"; session: ChatSession }
  | { type: "session_archived"; sessionId: string }
  | { type: "session_restored"; session: ChatSession }
  | { type: "session_deleted"; sessionId: string }
  | { type: "chat_message"; sessionId: string; message: ChatMessage }
  | { type: "plan_approval_request"; taskId: string; planId: string; roleId?: string; plan: ExecutionPlan }
  // "plan_approval_request": historical naming from PAERL Plan-first design. Actual semantic in Pure C
  // architecture: tool operation privilege escalation request. Name preserved for downstream compatibility.
  | { type: "plan_approval_decision"; taskId: string; planId: string; decision: "allow" | "deny"; approvalType?: "once" | "permanent"; reason?: string }
  // "plan_approval_decision": historical naming. Actual semantic: privilege escalation decision.
  | { type: "delivery_status_change"; taskId?: string; logEntryId: string; target: DeliveryTarget; status: DeliveryStatus; error?: string; messageType?: string }
  | { type: "sandbox_violation"; roleId: string; taskId?: string; path: string; operation: string; timestamp: number }
  | { type: "template_execution_status_change"; executionId: string; templateId: string; status: "running" | "completed" | "failed" | "partial" | "cancelled" }
  | { type: "event_fired"; eventDefId: string; eventId: string; payload: Record<string, unknown> }
  | {
      type: "cron_no_target_warning";
      executionId: string;
      templateId: string;
      reason: "cron_template_no_reportTo_and_no_system_default" | "delivery_assembly_failed_no_reportTo";
      timestamp: number;
    }
  ;

type EventType = GlobalEvent["type"];

class ServerEventBus {
  private emitter = new EventEmitter();

  on(event: "task_status_change", handler: (data: Extract<GlobalEvent, { type: "task_status_change" }>) => void): void;
  on(event: "approval_request", handler: (data: Extract<GlobalEvent, { type: "approval_request" }>) => void): void;
  on(event: "stats_update", handler: (data: Extract<GlobalEvent, { type: "stats_update" }>) => void): void;
  on(event: "task_complete_event", handler: (data: Extract<GlobalEvent, { type: "task_complete_event" }>) => void): void;
  on(event: "task_created", handler: (data: Extract<GlobalEvent, { type: "task_created" }>) => void): void;
  on(event: "task_abort_requested", handler: (data: Extract<GlobalEvent, { type: "task_abort_requested" }>) => void): void;
  on(event: "execution_slot_change", handler: (data: Extract<GlobalEvent, { type: "execution_slot_change" }>) => void): void;
  on(event: "execution_task_start", handler: (data: Extract<GlobalEvent, { type: "execution_task_start" }>) => void): void;
  on(event: "execution_task_end", handler: (data: Extract<GlobalEvent, { type: "execution_task_end" }>) => void): void;
  on(event: "goal_status_change", handler: (data: Extract<GlobalEvent, { type: "goal_status_change" }>) => void): void;
  on(event: "strategy_selected", handler: (data: Extract<GlobalEvent, { type: "strategy_selected" }>) => void): void;
  on(event: "log_event", handler: (data: Extract<GlobalEvent, { type: "log_event" }>) => void): void;
  on(event: "config_changed", handler: (data: Extract<GlobalEvent, { type: "config_changed" }>) => void): void;
  on(event: "session_created", handler: (data: Extract<GlobalEvent, { type: "session_created" }>) => void): void;
  on(event: "session_archived", handler: (data: Extract<GlobalEvent, { type: "session_archived" }>) => void): void;
  on(event: "session_restored", handler: (data: Extract<GlobalEvent, { type: "session_restored" }>) => void): void;
  on(event: "session_deleted", handler: (data: Extract<GlobalEvent, { type: "session_deleted" }>) => void): void;
  on(event: "chat_message", handler: (data: Extract<GlobalEvent, { type: "chat_message" }>) => void): void;
  // "plan_approval_request": historical naming. Actual semantic: tool operation privilege escalation.
  on(event: "plan_approval_request", handler: (data: Extract<GlobalEvent, { type: "plan_approval_request" }>) => void): void;
  on(event: "plan_approval_decision", handler: (data: Extract<GlobalEvent, { type: "plan_approval_decision" }>) => void): void;
  on(event: "delivery_status_change", handler: (data: Extract<GlobalEvent, { type: "delivery_status_change" }>) => void): void;
  on(event: "sandbox_violation", handler: (data: Extract<GlobalEvent, { type: "sandbox_violation" }>) => void): void;
  on(event: "template_execution_status_change", handler: (data: Extract<GlobalEvent, { type: "template_execution_status_change" }>) => void): void;
  on(event: "event_fired", handler: (data: Extract<GlobalEvent, { type: "event_fired" }>) => void): void;
  on(event: "cron_no_target_warning", handler: (data: Extract<GlobalEvent, { type: "cron_no_target_warning" }>) => void): void;
  on(event: EventType, handler: (data: any) => void): void {
    this.emitter.on(event, handler);
  }

  off(event: EventType, handler: (...args: any[]) => void): void {
    this.emitter.removeListener(event, handler);
  }

  emit(event: GlobalEvent): void {
    this.emitter.emit(event.type, event);
  }
}

export const serverBus = new ServerEventBus();
