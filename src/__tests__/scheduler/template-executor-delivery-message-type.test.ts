import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
const testRuntimeRoot = mkdtempSync(tmpdir() + sep + "adam-template-execution-dmt-");

// Must hoist mockGwSend and mockRedeliver so the hoisted vi.mock can reference them
const { artifactRows, mockGwSend, mockRedeliver } = vi.hoisted(() => ({
  artifactRows: [] as Array<{
    id: string;
    executionId: string;
    stepId: string;
    key: string;
    kind: "json" | "file";
    blobPath?: string;
    mime?: string;
    sizeBytes: number;
    createdAt: number;
  }>,
  mockGwSend: vi.fn().mockResolvedValue({ success: true, logEntryId: "log-dmt" }),
  mockRedeliver: vi.fn().mockResolvedValue({
    deliveries: [{ target: { channelId: "ch-test", chatId: "chat-test" }, deliveryLogId: "log-dmt", status: "delivered", attachmentCount: 0 }],
  }),
}));

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
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

vi.mock("../../lib/task-dispatch.js", () => ({
  createTaskWithAdmission: vi.fn().mockResolvedValue({
    ok: true,
    taskId: "task-test-dmt",
    roleId: "role-test",
    candidates: [],
  }),
}));

vi.mock("../../store/tasks.js", () => ({
  createTask: vi.fn().mockReturnValue({ id: "task-test-dmt" }),
  getTask: vi.fn().mockReturnValue({ id: "task-test-dmt", status: "completed", result: "done" }),
  updateTask: vi.fn(),
}));

// Mock outbound gateway to capture send calls
vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: vi.fn().mockReturnValue({
    send: mockGwSend,
    redeliverExecutionTo: mockRedeliver,
  }),
}));

vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn(() => artifactRows),
}));

vi.mock("../../lib/artifact-storage.js", () => ({
  ensureArtifactsDir: vi.fn(),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

// Mock channels so TemplateExecutor can resolve the channel target while Gateway remains mocked.
vi.mock("../../store/channels.js", () => ({
  getChannel: vi.fn((channelId: string) => ({
    id: channelId,
    name: "Test Channel",
    platform: "wechat",
    enabled: true,
    status: "connected",
    config: {},
    createdAt: Date.now(),
    messageCount: 0,
  })),
}));

// Real roles module (uses mocked getDb)
import { createRole } from "../../store/roles.js";
import { TemplateExecutor } from "../../scheduler/template-executor.js";
import type { Role, TaskTemplate } from "../../shared/types.js";

afterAll(() => {
  rmSync(testRuntimeRoot, { recursive: true, force: true });
  cleanup();
});

/**
 * Insert a task template directly into the test DB (bypasses module mock issues).
 * Uses the test DB schema: trigger_type/trigger_cron columns (not JSON trigger),
 * matching the actual test-db schema at helpers/test-db.ts.
 * Returns the template object (not the DB row).
 */
function insertTemplate(
  db: ReturnType<typeof getTestDb>,
  name: string,
  config?: Record<string, unknown>,
): TaskTemplate {
  const id = `tmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Test DB schema: trigger_type TEXT, trigger_cron TEXT (separate columns, not JSON)
  db.prepare(`
    INSERT INTO task_templates
      (id, name, description, trigger_type, trigger_cron, steps, config, enabled, created_at, is_preset, preset_id, deliver_to, report_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, NULL, NULL)
  `).run(
    id,
    name,
    "test",
    "manual",
    null,     // trigger_cron — null for manual
    "[]",     // steps
    config ? JSON.stringify(config) : null,
    Date.now(),
    null,
  );
  return {
    id,
    name,
    description: "test",
    trigger: { type: "manual" },
    steps: [],
    enabled: true,
    createdAt: Date.now(),
    config,
    // Required for deliverTemplateExecutionResult to fire (needs deliverTo.length > 0)
    deliverTo: [{ type: "channel", channelId: "test-channel", chatId: "chat-test" }],
  };
}

describe("TemplateExecutionContext.deliveryMessageType", () => {
  let executor: TemplateExecutor;

  beforeEach(() => {
    executor = new TemplateExecutor({ maxRetries: 1, baseDelayMs: 10 });
    // Seed a role for step admission — uses mocked getDb
    const role: Role = {
      id: "role-test",
      name: "Test Role",
      cagPrompt: "test",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "ms-test",
      status: "active",
      preferences: {},
      createdAt: Date.now(),
    };
    createRole(role);
    clearTestDb();
    process.env.ADAM_TEST_DIR = testRuntimeRoot;
    artifactRows.length = 0;
    mockGwSend.mockClear();
    mockGwSend.mockResolvedValue({ success: true, logEntryId: "log-dmt" });
    mockRedeliver.mockClear();
    mockRedeliver.mockResolvedValue({
      deliveries: [{ target: { channelId: "ch-test", chatId: "chat-test" }, deliveryLogId: "log-dmt", status: "delivered", attachmentCount: 0 }],
    });
  });

  it("template with delivery_message_type=mistake_digest sets context.deliveryMessageType and sends with that type", async () => {
    const db = getTestDb();
    const template = insertTemplate(db, "Test Digest", { delivery_message_type: "mistake_digest" });

    const execId = `exec-dmt-1-${Date.now()}`;
    await executor.execute(template, execId);

    const deliverCall = mockRedeliver.mock.calls.find(
      (call) => (call[0] as { messageType?: string })?.messageType === "mistake_digest",
    );
    expect(deliverCall).toBeDefined();
    expect((deliverCall![0] as { messageType: string }).messageType).toBe("mistake_digest");
  });

  // Phase 4 (D-002): default is now "result_delivery", sent as a single aggregated call
  it("template without delivery_message_type falls back to result_delivery as single call", async () => {
    const db = getTestDb();
    const template = insertTemplate(db, "Test No Type", {});

    const execId = `exec-dmt-2-${Date.now()}`;
    await executor.execute(template, execId);

    const deliverCall = mockRedeliver.mock.calls.find(
      (call) => (call[0] as { messageType?: string })?.messageType === "result_delivery",
    );
    expect(deliverCall).toBeDefined();
    expect((deliverCall![0] as { messageType: string }).messageType).toBe("result_delivery");
  });

  // Phase 4: empty string also falls back to "result_delivery"
  it("template with delivery_message_type='' (empty string) falls back to result_delivery", async () => {
    const db = getTestDb();
    const template = insertTemplate(db, "Test Empty Type", { delivery_message_type: "" });

    const execId = `exec-dmt-3-${Date.now()}`;
    await executor.execute(template, execId);

    const deliverCall = mockRedeliver.mock.calls.find(
      (call) => (call[0] as { messageType?: string })?.messageType === "result_delivery",
    );
    expect(deliverCall).toBeDefined();
    expect((deliverCall![0] as { messageType: string }).messageType).toBe("result_delivery");
  });

  // Phase 4: non-string also falls back to "result_delivery"
  it("template with non-string delivery_message_type falls back to result_delivery (type safety)", async () => {
    const db = getTestDb();
    const template = insertTemplate(db, "Test Non-String Type", { delivery_message_type: 42 } as Record<string, unknown>);

    const execId = `exec-dmt-4-${Date.now()}`;
    await executor.execute(template, execId);

    const deliverCall = mockRedeliver.mock.calls.find(
      (call) => (call[0] as { messageType?: string })?.messageType === "result_delivery",
    );
    expect(deliverCall).toBeDefined();
    expect((deliverCall![0] as { messageType: string }).messageType).toBe("result_delivery");
  });

  // Phase 4 (D-002): custom delivery_message_type sent as single aggregated call
  it("custom delivery_message_type → single send with that type and bundled attachments", async () => {
    artifactRows.push(
      {
        id: "first-file",
        executionId: "exec-dmt-artifacts",
        stepId: "publish",
        key: "report.md",
        kind: "file",
        blobPath: "/tmp/report.md",
        mime: "text/markdown",
        sizeBytes: 10,
        createdAt: 1,
      },
      {
        id: "second-file",
        executionId: "exec-dmt-artifacts",
        stepId: "publish",
        key: "audio",
        kind: "file",
        blobPath: "/tmp/audio.mp3",
        mime: "audio/mpeg",
        sizeBytes: 20,
        createdAt: 2,
      },
    );
    const db = getTestDb();
    const template = insertTemplate(db, "Test Custom Artifact Types", { delivery_message_type: "mistake_digest" });

    await executor.execute(template, "exec-dmt-artifacts");

    // Phase 4: one aggregated call via redeliverExecutionTo
    expect(mockRedeliver).toHaveBeenCalledTimes(1);
    const deliverCall = mockRedeliver.mock.calls[0][0] as { messageType: string; fileArtifacts?: unknown[] };
    expect(deliverCall.messageType).toBe("mistake_digest");
    expect(deliverCall.fileArtifacts).toHaveLength(2);
  });

  // Phase 4: default result_delivery as single aggregated call
  it("default result_delivery → single aggregated call with all attachments bundled", async () => {
    artifactRows.push(
      {
        id: "default-first",
        executionId: "exec-dmt-default-artifacts",
        stepId: "publish",
        key: "report.md",
        kind: "file",
        blobPath: "/tmp/report.md",
        mime: "text/markdown",
        sizeBytes: 10,
        createdAt: 1,
      },
      {
        id: "default-second",
        executionId: "exec-dmt-default-artifacts",
        stepId: "publish",
        key: "audio",
        kind: "file",
        blobPath: "/tmp/audio.mp3",
        mime: "audio/mpeg",
        sizeBytes: 20,
        createdAt: 2,
      },
    );
    const db = getTestDb();
    const template = insertTemplate(db, "Test Default Artifact Types", {});

    await executor.execute(template, "exec-dmt-default-artifacts");

    // Phase 4: one aggregated call via redeliverExecutionTo
    expect(mockRedeliver).toHaveBeenCalledTimes(1);
    const deliverCall = mockRedeliver.mock.calls[0][0] as { messageType: string; fileArtifacts?: unknown[] };
    expect(deliverCall.messageType).toBe("result_delivery");
    expect(deliverCall.fileArtifacts).toHaveLength(2);
  });
});
