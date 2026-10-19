/**
 * Tests for cron template reportTo fallback (Task 12).
 *
 * Cases:
 * (a) Manual-triggered template with no reportTo → no fallback, no warning
 * (b) Cron-triggered template with explicit reportTo → no fallback, no warning
 * (c) Cron-triggered template with empty reportTo + system default set → uses system default, no warning
 * (d) Cron-triggered template with empty reportTo + no system default → CRITICAL log + cron_no_target_warning event
 * (e) Delivery assembly fail with no reportTo → CRITICAL log + cron_no_target_warning event
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// --- Hoisted mutable mock state ---
const { emittedEvents, configDbValues, logCalls } = vi.hoisted(() => {
  const emittedEvents: Array<{ type: string; [key: string]: unknown }> = [];
  const configDbValues: Record<string, unknown> = {};
  const logCalls: Array<{ level: string; msg: string; extra: Record<string, unknown> }> = [];
  return { emittedEvents, configDbValues, logCalls };
});

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../store/config.js", () => ({
  getConfigValue: vi.fn((key: string) => configDbValues[key]),
}));

vi.mock("../../store/role-workspace.js", () => ({
  ensureRoleWorkspace: vi.fn(() => "/tmp/adam-test-roles/test"),
  getRoleWorkspacePath: vi.fn(() => "/tmp/adam-test-roles/test"),
  writeRoleCLAUDEmd: vi.fn(),
  syncRoleSettings: vi.fn(),
}));

vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn(() => []),
  getArtifact: vi.fn(() => null),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: vi.fn((event: { type: string; [key: string]: unknown }) => {
      emittedEvents.push(event);
    }),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock("../../lib/logger.js", () => ({
  getLogger: vi.fn(() => ({
    error: vi.fn((extra: Record<string, unknown>, msg: string) => {
      logCalls.push({ level: "error", msg, extra });
    }),
    warn: vi.fn((extra: Record<string, unknown>, msg: string) => {
      logCalls.push({ level: "warn", msg, extra });
    }),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    })),
  })),
}));

vi.mock("../../config/index.js", () => ({
  getDefaults: () => ({
    timeout: 600,
    maxTurns: 100,
    maxBudgetUsd: 5.0,
    effort: "high" as const,
    model: "claude-sonnet-4-6",
    settingSources: ["project"],
    allowedTools: [],
    disallowedTools: [],
    approvalRequired: [],
    approvalTimeout: 300,
    env: {},
  }),
}));

import { TemplateExecutor } from "../../scheduler/template-executor.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { createRole } from "../../store/roles.js";
import { updateTask } from "../../store/tasks.js";
import { serverBus } from "../../server/events/server-bus.js";
import type { TaskTemplate, NotifyTarget } from "../../shared/types.js";

vi.mock("../../scheduler/template-summary-assembler.js", () => ({
  assembleSummary: vi.fn(() => {
    throw new Error("simulated assembly failure");
  }),
  tryAssembleFallbackDelivery: vi.fn(() => null),
}));

const SYSTEM_DEFAULT_REPORT_TO: NotifyTarget[] = [
  { type: "channel", channelId: "sys-default-channel" },
];

function seedRole(): void {
  createRole({
    id: "role-test",
    name: "test",
    cagPrompt: "test",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "ms-test",
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  });
}

function makeCronTemplate(reportTo?: NotifyTarget[]): TaskTemplate {
  const tmpl: TaskTemplate = {
    id: `tmpl-cron-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: "cron-test",
    trigger: { type: "cron", cron: "0 7 * * *" },
    steps: [{ id: "step-1", prompt: "cron test", roleId: "role-test" }],
    enabled: true,
    createdAt: Date.now(),
    ...(reportTo !== undefined ? { reportTo } : {}),
  };
  createTaskTemplate(tmpl);
  return tmpl;
}

function makeManualTemplate(reportTo?: NotifyTarget[]): TaskTemplate {
  const tmpl: TaskTemplate = {
    id: `tmpl-manual-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: "manual-test",
    trigger: { type: "manual" },
    steps: [{ id: "step-1", prompt: "manual test", roleId: "role-test" }],
    enabled: true,
    createdAt: Date.now(),
    ...(reportTo !== undefined ? { reportTo } : {}),
  };
  createTaskTemplate(tmpl);
  return tmpl;
}

function autoCompletePendingTasks(): () => void {
  const interval = setInterval(() => {
    const db = getTestDb();
    const rows = db.prepare("SELECT id FROM tasks WHERE status = 'pending'").all() as { id: string }[];
    for (const row of rows) {
      updateTask(row.id, { status: "completed", result: "done", completedAt: Date.now() });
      serverBus.emit({ type: "task_status_change", taskId: row.id, oldStatus: "pending", newStatus: "completed" });
    }
    if (rows.length === 0) {
      clearInterval(interval);
    }
  }, 10);
  return () => clearInterval(interval);
}

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
  emittedEvents.length = 0;
  logCalls.length = 0;
  Object.keys(configDbValues).forEach((k) => delete configDbValues[k]);
  seedRole();
});

describe("reportTo fallback", () => {

  it("Case A: manual-triggered template with no reportTo → no fallback, no warning", async () => {
    const template = makeManualTemplate();
    const executionId = "exec-manual-no-reportto";
    const stop = autoCompletePendingTasks();
    try {
      const executor = new TemplateExecutor({ maxRetries: 0, baseDelayMs: 10 });
      await executor.execute(template, executionId);
    } finally {
      stop();
    }
    const criticalLogs = logCalls.filter((l) => l.level === "error" && l.msg.includes("CRITICAL"));
    expect(criticalLogs).toHaveLength(0);
    const warnings = emittedEvents.filter((e) => e.type === "cron_no_target_warning");
    expect(warnings).toHaveLength(0);
  });

  it("Case B: cron-triggered template with explicit reportTo → no fallback, no warning", async () => {
    const explicit: NotifyTarget[] = [{ type: "channel", channelId: "my-channel" }];
    const template = makeCronTemplate(explicit);
    const executionId = "exec-cron-with-reportto";
    const stop = autoCompletePendingTasks();
    try {
      const executor = new TemplateExecutor({ maxRetries: 0, baseDelayMs: 10 });
      await executor.execute(template, executionId);
    } finally {
      stop();
    }
    const criticalLogs = logCalls.filter((l) => l.level === "error" && l.msg.includes("CRITICAL"));
    expect(criticalLogs).toHaveLength(0);
    const warnings = emittedEvents.filter((e) => e.type === "cron_no_target_warning");
    expect(warnings).toHaveLength(0);
  });

  it("Case C: cron-triggered template with empty reportTo + system default set → uses system default, no warning", async () => {
    const template = makeCronTemplate([]);
    configDbValues["delivery.cronDefaultReportTo"] = SYSTEM_DEFAULT_REPORT_TO;
    const executionId = "exec-cron-fallback-default";
    const stop = autoCompletePendingTasks();
    try {
      const executor = new TemplateExecutor({ maxRetries: 0, baseDelayMs: 10 });
      await executor.execute(template, executionId);
    } finally {
      stop();
    }
    const criticalLogs = logCalls.filter((l) => l.level === "error" && l.msg.includes("CRITICAL"));
    expect(criticalLogs).toHaveLength(0);
    const warnings = emittedEvents.filter((e) => e.type === "cron_no_target_warning");
    expect(warnings).toHaveLength(0);
  });

  it("Case D: cron-triggered template with empty reportTo + no system default → CRITICAL log + cron_no_target_warning event", async () => {
    const template = makeCronTemplate([]);
    const executionId = "exec-cron-no-fallback";
    const stop = autoCompletePendingTasks();
    try {
      const executor = new TemplateExecutor({ maxRetries: 0, baseDelayMs: 10 });
      await executor.execute(template, executionId);
    } finally {
      stop();
    }
    const criticalLogs = logCalls.filter((l) => l.level === "error" && l.msg.includes("CRITICAL"));
    expect(criticalLogs).toHaveLength(1);
    expect((criticalLogs[0].extra as Record<string, unknown>).executionId).toBe(executionId);
    const warnings = emittedEvents.filter((e) => e.type === "cron_no_target_warning");
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as Record<string, unknown>).executionId).toBe(executionId);
    expect((warnings[0] as Record<string, unknown>).templateId).toBe(template.id);
    expect((warnings[0] as Record<string, unknown>).reason).toBe("cron_template_no_reportTo_and_no_system_default");
  });

  it("Case D variant: cron-triggered template with undefined reportTo + no system default → fires same as empty array", async () => {
    const template = makeCronTemplate(undefined as unknown as NotifyTarget[]);
    const executionId = "exec-cron-undefined-reportto";
    const stop = autoCompletePendingTasks();
    try {
      const executor = new TemplateExecutor({ maxRetries: 0, baseDelayMs: 10 });
      await executor.execute(template, executionId);
    } finally {
      stop();
    }
    const criticalLogs = logCalls.filter((l) => l.level === "error" && l.msg.includes("CRITICAL"));
    expect(criticalLogs).toHaveLength(1);
    const warnings = emittedEvents.filter((e) => e.type === "cron_no_target_warning");
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as Record<string, unknown>).reason).toBe("cron_template_no_reportTo_and_no_system_default");
  });

  it("Case E: delivery assembly fail with no reportTo → CRITICAL log + cron_no_target_warning with delivery_assembly reason", async () => {
    // Template needs deliverTo non-empty to enter the deliverTo block in deliverTemplateExecutionResult.
    // reportTo is empty (no fallback configured) so the "else if deliveryAssemblyError" error path fires.
    const template = makeCronTemplate([]);
    template.steps = [];
    template.deliverTo = [{ type: "channel", channelId: "deliver-channel" }];
    const executionId = "exec-delivery-assembly-fail";
    const stop = autoCompletePendingTasks();
    try {
      const executor = new TemplateExecutor({ maxRetries: 0, baseDelayMs: 10 });
      // assembleSummary is mocked at module level to throw; this triggers the error path
      try {
        await executor.execute(template, executionId);
      } catch {
        // Expected — execution may fail
      }
    } finally {
      stop();
    }
    // The delivery assembly failure path emits cron_no_target_warning with reason "delivery_assembly_failed_no_reportTo"
    const warnings = emittedEvents.filter((e) => e.type === "cron_no_target_warning");
    const assemblyWarnings = warnings.filter(
      (w) => (w as Record<string, unknown>).reason === "delivery_assembly_failed_no_reportTo",
    );
    expect(assemblyWarnings).toHaveLength(1);
    expect((assemblyWarnings[0] as Record<string, unknown>).executionId).toBe(executionId);
    // Also check CRITICAL log for delivery assembly path
    const criticalLogs = logCalls.filter((l) => l.level === "error" && l.msg.includes("CRITICAL"));
    expect(criticalLogs.length).toBeGreaterThanOrEqual(1);
  });
});
