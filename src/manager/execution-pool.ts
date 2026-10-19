import { ExecutionManager } from "./execution-manager.js";
import type { ExecutionResult } from "./execution-manager.js";
import { listTasks, getTotalCostSince } from "../store/tasks.js";
import { serverBus } from "../server/events/server-bus.js";
import { getStartOfDayMs } from "../lib/time.js";
import { getRuntimeConfig } from "../config/runtime.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("execution-pool");

/** PID → { roleId, taskId } map for correlating OS-level sandbox violations to Roles. */
const activePids = new Map<number, { roleId: string; taskId: string }>();

export function registerTaskPid(pid: number, roleId: string, taskId: string): void {
  activePids.set(pid, { roleId, taskId });
}

export function unregisterTaskPid(pid: number): void {
  activePids.delete(pid);
}

export function lookupTaskByPid(pid: number): { roleId: string; taskId: string } | undefined {
  return activePids.get(pid);
}

interface Slot {
  index: number;
  taskId: string | null;
  abortController: AbortController | null;
}

/**
 * Executor interface — allows injecting a mock for unit testing.
 * The real ExecutionManager implements this via its execute() method.
 */
interface Executor {
  execute(task: import("../shared/types.js").Task, signal?: AbortSignal): Promise<ExecutionResult>;
}

export class ExecutionPool {
  private slots: Slot[];
  private running = false;
  private pollTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private executor: Executor;

  constructor(maxConcurrent: number, executor?: Executor) {
    this.slots = Array.from({ length: maxConcurrent }, (_, i) => ({
      index: i, taskId: null, abortController: null,
    }));
    this.executor = executor ?? new ExecutionManager();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Subscribe to task_created event for immediate pickup
    serverBus.on("task_created", (event) => {
      void this.onTaskCreated(event.taskId);
    });

    serverBus.on("task_abort_requested", (event) => {
      this.abortTask(event.taskId, event.reason);
    });

    // Also subscribe to task_status_change for returning tasks
    serverBus.on("task_status_change", (event) => {
      if (event.newStatus === "pending") {
        void this.pickupPendingTasks();
      }
    });

    // Start poll backup
    const config = getRuntimeConfig();
    const pollIntervalMs = config.execution?.pollIntervalMs ?? 30_000;
    this.pollTimeoutId = setTimeout(this.poll, pollIntervalMs);

    log.info({ maxConcurrent: this.slots.length }, "ExecutionPool started");
  }

  stop(): void {
    this.running = false;

    if (this.pollTimeoutId) {
      clearTimeout(this.pollTimeoutId);
      this.pollTimeoutId = null;
    }

    // Abort all in-flight tasks
    for (const slot of this.slots) {
      if (slot.abortController) {
        slot.abortController.abort();
        slot.taskId = null;
        slot.abortController = null;
      }
    }

    log.info("ExecutionPool stopped");
  }

  private poll = (): void => {
    if (!this.running) return;
    void this.pickupPendingTasks();

    const config = getRuntimeConfig();
    const pollIntervalMs = config.execution?.pollIntervalMs ?? 30_000;
    this.pollTimeoutId = setTimeout(this.poll, pollIntervalMs);
  };

  /**
   * Event-driven: when a new task is created, try to fill a free slot.
   */
  protected async onTaskCreated(taskId: string): Promise<void> {
    if (!this.running) return;
    await this.pickupPendingTasks();
  }

  /**
   * Find a free slot and attempt to claim and execute the next pending task.
   */
  protected async pickupPendingTasks(): Promise<void> {
    if (!this.running) return;

    const freeSlot = this.slots.find((s) => s.taskId === null);
    if (!freeSlot) {
      log.debug("No free slots available");
      return;
    }

    // Find the oldest pending task (FIFO)
    const pendingTasks = listTasks("pending");
    if (pendingTasks.length === 0) {
      return;
    }

    // Sort by createdAt (oldest first)
    const sorted = [...pendingTasks].sort((a, b) => a.createdAt - b.createdAt);
    const task = sorted[0];

    // Claim the slot
    freeSlot.taskId = task.id;
    freeSlot.abortController = new AbortController();

    const slotIndex = freeSlot.index;
    const taskId = task.id;

    log.info({ slotIndex, taskId }, "ExecutionPool: claimed slot for task");
    this.emitSlotChange();

    // Execute in detached async flow
    void this.executeTask(task, slotIndex).catch((err) => {
      log.error({ taskId, error: err }, "ExecutionPool: executeTask failed unexpectedly");
    });
  }

  protected async executeTask(task: { id: string; status: string; prompt: string; config: import("../shared/types.js").TaskConfig; roleId?: string }, slotIndex: number): Promise<void> {
    const slot = this.slots[slotIndex];
    if (!slot) return;

    let taskStatus: "completed" | "failed" | "blocked" | "cancelled" = "completed";
    try {
      serverBus.emit({ type: "execution_task_start", taskId: task.id, slotIndex });

      const result = await this.executor.execute(
        task as import("../shared/types.js").Task,
        slot.abortController?.signal,
      );

      taskStatus = result.status;
      log.info({ taskId: task.id, status: result.status, slotIndex }, "ExecutionPool: task finished");
    } finally {
      // Free the slot
      slot.taskId = null;
      slot.abortController = null;
      serverBus.emit({ type: "execution_task_end", taskId: task.id, slotIndex, status: taskStatus });
      this.emitSlotChange();

      // Post-completion: memory extraction + learning + monitoring (non-blocking)
      // T7: Skip audit/score for blocked tasks — correctly reporting missing prereqs
      // should not penalize Role EMA or trigger retirement
      if (taskStatus !== "blocked") {
        void this.runPostCompletion(task.id, task.roleId).catch((err) => {
          log.error({ taskId: task.id, error: err }, "Post-completion processing failed (non-fatal)");
        });
      }

      // Try to pick up next task
      if (this.running) {
        void this.pickupPendingTasks();
      }
    }
  }

  protected emitSlotChange(): void {
    const active = this.slots.filter((s) => s.taskId !== null).length;
    const pendingTasks = listTasks("pending");
    serverBus.emit({
      type: "execution_slot_change",
      active,
      max: this.slots.length,
      queued: pendingTasks.length,
    });

    // Emit stats_update with today's cost for Dashboard
    const todayStart = getStartOfDayMs();
    serverBus.emit({
      type: "stats_update",
      activeTasks: active,
      queuedTasks: pendingTasks.length,
      totalCostToday: getTotalCostSince(todayStart),
    });
  }

  /**
   * Non-blocking post-completion processing: structured memory extraction,
   * learning (deviation rules), and monitor scoring.
   * All errors are caught and logged — never blocks task execution.
   */
  private async runPostCompletion(taskId: string, roleId?: string): Promise<void> {
    if (!roleId) return;

    // Pipeline B: Structured memory extraction + reflection trigger
    try {
      const { processTaskCompletion } = await import("../agent/memory-extractor.js");
      const stored = await processTaskCompletion(taskId, roleId);
      if (stored > 0) {
        log.debug({ taskId, roleId, memoriesStored: stored }, "Post-completion: memories extracted");
      }
    } catch (err) {
      log.error({ taskId, roleId, error: err }, "Post-completion: memory extraction failed");
    }

    // Pipeline C1: Learning — deviation report + rule extraction (only for tasks with plans)
    try {
      const { processTaskReview } = await import("../agent/learner.js");
      await processTaskReview(taskId);
    } catch (err) {
      log.error({ taskId, roleId, error: err }, "Post-completion: task review failed");
    }

    // Pipeline C2: AuditManager — scoring + EMA + retirement/probation check
    try {
      const { evaluateTaskCompletion } = await import("../audit/audit-manager.js");
      evaluateTaskCompletion(taskId, roleId);
    } catch (err) {
      log.error({ taskId, roleId, error: err }, "Post-completion: audit evaluation failed");
    }
  }

  // Health check
  getStatus(): { active: number; max: number; queued: number } {
    const active = this.slots.filter((s) => s.taskId !== null).length;
    const pendingTasks = listTasks("pending");
    return {
      active,
      max: this.slots.length,
      queued: pendingTasks.length,
    };
  }

  isHealthy(): boolean { return this.running; }

  /**
   * Force-release a slot occupied by a specific taskId.
   * Used by watchdog to free slots for tasks that are stuck.
   * Also aborts the in-flight SDK process if possible.
   */
  releaseSlot(taskId: string): void {
    this.abortTask(taskId, "watchdog_stale_running");
  }

  private abortTask(taskId: string, reason: "cancelled" | "inactivity_timeout" | "watchdog_stale_running"): void {
    const slot = this.slots.find((s) => s.taskId === taskId);
    if (!slot) return;

    log.warn({ taskId, slotIndex: slot.index, reason }, "ExecutionPool: aborting task slot");
    if (slot.abortController) {
      slot.abortController.abort();
    }
    slot.taskId = null;
    slot.abortController = null;
    this.emitSlotChange();

    // Try to pick up pending tasks now that a slot is free
    if (this.running) {
      void this.pickupPendingTasks();
    }
  }
}
