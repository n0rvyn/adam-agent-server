/**
 * Task 3-tests: cancel_execution tool — failing test
 *
 * Pins the behavior of a `cancel_execution(executionId)` adam-tool that does not exist yet.
 * Expected result BEFORE Task 3-impl: FAIL (handler not found in toolHandlers map).
 * Expected result AFTER Task 3-impl: PASS.
 *
 * Regression shields:
 * - Only running/pending step tasks are cancelled; a completed step must stay completed.
 * - The `task_abort_requested` event must be emitted for the running step.
 * - An effect_receipt is written under the current trace.
 * - The result object contains { success: true, executionId, cancelledTaskIds }.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
afterAll(() => cleanup());

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock SDK — preserve name/handler so we can look up cancel_execution
const { mockTool, mockCreateSdkMcpServer } = vi.hoisted(() => {
  const mockTool = vi.fn().mockImplementation(
    (name: string, _desc: string, _schema: unknown, handler: unknown) => ({ name, handler }),
  );
  const mockCreateSdkMcpServer = vi.fn().mockImplementation((cfg: { tools: unknown }) => ({
    tools: cfg.tools,
  }));
  return { mockTool, mockCreateSdkMcpServer };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({ defaults: {} }),
  updateMutableConfig: vi.fn(),
}));

const { mockServerBusEmit } = vi.hoisted(() => ({
  mockServerBusEmit: vi.fn(),
}));
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: mockServerBusEmit },
}));

vi.mock("../../lib/task-dispatch.js", () => ({
  createTaskWithAdmission: vi.fn(),
}));
vi.mock("../../manager/skill-registry.js", () => ({
  SkillRegistry: { query: vi.fn().mockReturnValue([]), match: vi.fn().mockReturnValue([]) },
}));
vi.mock("../../store/role-workspace.js", async () => {
  const actual = await vi.importActual<typeof import("../../store/role-workspace.js")>("../../store/role-workspace.js");
  return { ...actual, getRoleWorkspacePath: vi.fn(() => "/tmp/test-role-ws") };
});
vi.mock("../../lib/artifact-storage.js", () => ({
  publishBlob: vi.fn().mockReturnValue({ blobPath: "/tmp/blob", sizeBytes: 1 }),
  unlinkSourceFileStrict: vi.fn(),
  unlinkBlob: vi.fn(),
  fetchBlob: vi.fn(),
  validatePathInWorkspace: vi.fn(),
}));
vi.mock("../../store/audit-diagnostics.js", () => ({
  recordAuditDiagnostic: vi.fn().mockResolvedValue(undefined),
}));

import { createAdamTools } from "../../manager/adam-tools.js";
import { listReceiptsByTrace } from "../../store/effect-receipts.js";
import { withTrace } from "../../lib/trace-context.js";
import { v4 as uuidv4 } from "uuid";

function buildToolHandlers(): Map<string, (args: unknown) => Promise<unknown>> {
  mockTool.mockClear();
  createAdamTools({} as Parameters<typeof createAdamTools>[0]);
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  for (const call of mockTool.mock.calls) {
    const [name, , , handler] = call as [string, string, unknown, (args: unknown) => Promise<unknown>];
    handlers.set(name, handler);
  }
  return handlers;
}

function seedExecution(
  executionId: string,
  runningTaskId: string,
  completedTaskId: string,
): void {
  const db = getTestDb();

  // Seed a template row required by the FK
  const templateId = uuidv4();
  db.prepare(
    `INSERT INTO task_templates (id, name, trigger_type, steps, created_at)
     VALUES (?, ?, 'manual', '[]', ?)`,
  ).run(templateId, "Test Template", Date.now());

  // Seed the two task rows
  db.prepare(
    `INSERT INTO tasks (id, status, prompt, config, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(runningTaskId, "running", "run step", "{}", Date.now());

  db.prepare(
    `INSERT INTO tasks (id, status, prompt, config, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(completedTaskId, "completed", "done step", "{}", Date.now());

  // Seed the template_execution with two step statuses
  const stepStatuses = JSON.stringify({
    "step-run": { taskId: runningTaskId, status: "running" },
    "step-done": { taskId: completedTaskId, status: "completed" },
  });
  db.prepare(
    `INSERT INTO template_executions (id, template_id, status, step_statuses, started_at)
     VALUES (?, ?, 'running', ?, ?)`,
  ).run(executionId, templateId, stepStatuses, Date.now());
}

describe("cancel_execution tool", () => {
  beforeEach(() => {
    clearTestDb();
    mockServerBusEmit.mockClear();
  });

  it("cancels running step tasks and writes an effect receipt (fails before impl: tool absent)", async () => {
    const executionId = uuidv4();
    const runningTaskId = uuidv4();
    const completedTaskId = uuidv4();

    seedExecution(executionId, runningTaskId, completedTaskId);

    const handlers = buildToolHandlers();

    // FAIL condition: tool does not exist yet → handler is undefined
    const cancelHandler = handlers.get("cancel_execution");
    if (!cancelHandler) {
      throw new Error(
        "cancel_execution handler not found — implement the tool in Task 3-impl",
      );
    }

    const turnTraceId = uuidv4();
    const result = await withTrace(turnTraceId, "chat", () =>
      cancelHandler({ executionId }),
    ) as { content: Array<{ text: string }> };

    const parsed = JSON.parse(result.content[0].text) as {
      success: boolean;
      executionId: string;
      cancelledTaskIds: string[];
    };

    // Result must report success + the running step's taskId
    expect(parsed.success).toBe(true);
    expect(parsed.executionId).toBe(executionId);
    expect(parsed.cancelledTaskIds).toContain(runningTaskId);
    // Completed step must NOT appear in cancelledTaskIds
    expect(parsed.cancelledTaskIds).not.toContain(completedTaskId);

    // The running task row must now be "cancelled"
    const db = getTestDb();
    const runningRow = db.prepare("SELECT status FROM tasks WHERE id = ?").get(runningTaskId) as { status: string };
    expect(runningRow.status).toBe("cancelled");

    // The completed task row must remain "completed"
    const completedRow = db.prepare("SELECT status FROM tasks WHERE id = ?").get(completedTaskId) as { status: string };
    expect(completedRow.status).toBe("completed");

    // An effect receipt must exist under the turn trace
    const receipts = listReceiptsByTrace(turnTraceId);
    expect(receipts.length).toBeGreaterThanOrEqual(1);
    const cancelReceipt = receipts.find((r) => r.verb === "cancel" && r.entityType === "template_execution");
    expect(cancelReceipt).toBeDefined();

    // task_abort_requested must be emitted for the running step
    const abortEmit = mockServerBusEmit.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "task_abort_requested" &&
             (c[0] as { taskId: string }).taskId === runningTaskId,
    );
    expect(abortEmit).toBeDefined();
  });

  it("completed steps stay completed after cancel_execution (regression guard)", async () => {
    const executionId = uuidv4();
    const runningTaskId = uuidv4();
    const completedTaskId = uuidv4();

    seedExecution(executionId, runningTaskId, completedTaskId);

    const handlers = buildToolHandlers();
    const cancelHandler = handlers.get("cancel_execution");
    if (!cancelHandler) {
      throw new Error(
        "cancel_execution handler not found — implement the tool in Task 3-impl",
      );
    }

    await withTrace(uuidv4(), "chat", () => cancelHandler({ executionId }));

    const db = getTestDb();
    const completedRow = db.prepare("SELECT status FROM tasks WHERE id = ?").get(completedTaskId) as { status: string };
    expect(completedRow.status).toBe("completed");

    // Only one task was cancelled
    const cancelledRows = db.prepare("SELECT id FROM tasks WHERE status = 'cancelled'").all() as { id: string }[];
    expect(cancelledRows.map((r) => r.id)).toContain(runningTaskId);
    expect(cancelledRows.map((r) => r.id)).not.toContain(completedTaskId);
  });

  it("stale step snapshot: step says running but task is already terminal — must NOT overwrite (live-status guard)", async () => {
    const executionId = uuidv4();
    const staleTaskId = uuidv4();
    const db = getTestDb();

    // Seed a template + a task that is ALREADY completed, but whose step snapshot still says "running"
    const templateId = uuidv4();
    db.prepare(
      `INSERT INTO task_templates (id, name, trigger_type, steps, created_at) VALUES (?, ?, 'manual', '[]', ?)`,
    ).run(templateId, "Stale Template", Date.now());
    const realCompletedAt = Date.now() - 60_000;
    db.prepare(
      `INSERT INTO tasks (id, status, prompt, config, created_at, completed_at) VALUES (?, 'completed', 'done', '{}', ?, ?)`,
    ).run(staleTaskId, Date.now() - 120_000, realCompletedAt);
    db.prepare(
      `INSERT INTO template_executions (id, template_id, status, step_statuses, started_at) VALUES (?, ?, 'running', ?, ?)`,
    ).run(executionId, templateId, JSON.stringify({ "step-stale": { taskId: staleTaskId, status: "running" } }), Date.now());

    const handlers = buildToolHandlers();
    const cancelHandler = handlers.get("cancel_execution")!;
    const result = await withTrace(uuidv4(), "chat", () => cancelHandler({ executionId })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text) as { cancelledTaskIds: string[] };

    // The already-terminal task must stay completed with its original completedAt, and not be reported cancelled
    const row = db.prepare("SELECT status, completed_at FROM tasks WHERE id = ?").get(staleTaskId) as { status: string; completed_at: number };
    expect(row.status).toBe("completed");
    expect(row.completed_at).toBe(realCompletedAt);
    expect(parsed.cancelledTaskIds).not.toContain(staleTaskId);
  });
});
