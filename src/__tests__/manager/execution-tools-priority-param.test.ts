/**
 * Task 2-tests: publish_artifact_file / write_artifact accept priority param
 *
 * Tests FAIL before Task 2-impl because the tool input shapes don't declare
 * `priority`, so:
 *   - Cases A, B: priority is not persisted (no such column in INSERT before Task 1-impl,
 *     and no priority field in tool args before Task 2-impl)
 *   - Cases D, E: Zod rejects unknown key... wait, these will PASS (unknown key in Zod
 *     is stripped by default) — actually priority will be accepted but not persisted.
 *     The fail signal per plan: "zod schema rejection of unknown `priority` arg"
 *     Actually per Task 2-tests plan: "All 6 cases FAIL on zod schema rejection of
 *     unknown `priority` arg." This may not be exact — Zod strips unknown keys by default.
 *     The real failure is that A/B/F assert priority=10/50/20 in DB, which won't match NULL.
 *     D/E assert error containing "priority" which won't fire since it's stripped.
 *
 * After Task 2-impl: 6/6 green.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

let registeredTools: Array<{ name: string; handler: (...args: unknown[]) => unknown }> = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((config: { name?: string; tools: typeof registeredTools }) => {
    registeredTools = config.tools;
    return { type: "sdk", name: config.name };
  }),
  tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => ({
    name,
    handler,
  })),
}));

vi.mock("../../store/channels.js", () => ({
  listChannels: vi.fn(() => []),
  getChannel: vi.fn(() => null),
}));

vi.mock("../../chat/session-manager.js", () => ({
  listSessions: vi.fn(() => []),
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({
    send: vi.fn().mockResolvedValue({ success: true }),
    redeliverExecutionTo: vi.fn().mockResolvedValue(undefined),
  }),
}));

const workspaceRoot = mkdtempSync(tmpdir() + sep + "adam-priority-param-test-");

vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: vi.fn(() => join(workspaceRoot, "test-role")),
  ensureRoleWorkspace: vi.fn(() => {
    mkdirSync(join(workspaceRoot, "test-role"), { recursive: true });
    return join(workspaceRoot, "test-role");
  }),
}));

import { createRole } from "../../store/roles.js";
import { createTask } from "../../store/tasks.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { createTemplateExecution } from "../../store/template-executions.js";
import { listArtifactsByTask, listArtifactsByExecution } from "../../store/artifacts.js";
import { createExecutionTools } from "../../manager/execution-tools.js";

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  cleanup();
});

beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
  registeredTools = [];
  mkdirSync(join(workspaceRoot, "test-role"), { recursive: true });
  process.env.ADAM_TEST_DIR = workspaceRoot;
});

function findTool(name: string) {
  const t = registeredTools.find((tool) => tool.name === name);
  expect(t).toBeDefined();
  return t!;
}

function parseResult(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

function seedRole(id = "role-1", name = "test-role") {
  createRole({
    id,
    name,
    cagPrompt: "Test",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `mem-${id}`,
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  });
  return id;
}

function seedTaskOnlyTask(taskId = "task-1", roleId = "role-1") {
  createTask({
    id: taskId,
    roleId,
    status: "pending",
    prompt: "Do something",
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
    createdAt: Date.now(),
  });
}

function seedTemplateStepTask(taskId: string, executionId: string, stepId: string, roleId = "role-1") {
  createTaskTemplate({
    id: `tmpl-${executionId}`,
    name: executionId,
    trigger: { type: "manual" },
    steps: [{ id: stepId, prompt: "step", roleId }],
    enabled: true,
    createdAt: Date.now(),
  });
  createTemplateExecution(executionId, `tmpl-${executionId}`);
  createTask({
    id: taskId,
    roleId,
    parentId: executionId,
    stepId,
    templateId: `tmpl-${executionId}`,
    status: "pending",
    prompt: "step task",
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
    createdAt: Date.now(),
  });
}

// Case A: task_published path — publish_artifact_file with priority: 10
describe("Case A — publish_artifact_file task_published with priority=10", () => {
  it("artifact row has priority=10", async () => {
    const roleId = seedRole();
    seedTaskOnlyTask("task-a");

    const sourceFile = join(workspaceRoot, "test-role", "file-a.mp3");
    writeFileSync(sourceFile, "FAKE_AUDIO");

    createExecutionTools(roleId, "task-a");
    const result = parseResult(await findTool("publish_artifact_file").handler({
      key: "audio",
      sourcePath: sourceFile,
      mime: "audio/mp3",
      priority: 10,
    }));

    expect(result.success).toBe(true);

    const rows = listArtifactsByTask("task-a");
    expect(rows.length).toBe(1);
    expect(rows[0].priority).toBe(10);
  });
});

// Case B: template_step path — publish_artifact_file with priority: 50
describe("Case B — publish_artifact_file template_step with priority=50", () => {
  it("artifact row has priority=50", async () => {
    const roleId = seedRole();
    seedTemplateStepTask("task-b", "exec-b", "step-b");

    const sourceFile = join(workspaceRoot, "test-role", "report.md");
    writeFileSync(sourceFile, "# Report content");

    createExecutionTools(roleId, "task-b");
    const result = parseResult(await findTool("publish_artifact_file").handler({
      key: "step-b",
      sourcePath: sourceFile,
      mime: "text/markdown",
      priority: 50,
    }));

    expect(result.success).toBe(true);

    const rows = listArtifactsByExecution("exec-b");
    expect(rows.length).toBe(1);
    expect(rows[0].priority).toBe(50);
  });
});

// Case C: publish_artifact_file without priority → NULL
describe("Case C — publish_artifact_file without priority stores NULL", () => {
  it("artifact row has priority=undefined (NULL)", async () => {
    const roleId = seedRole();
    seedTaskOnlyTask("task-c");

    const sourceFile = join(workspaceRoot, "test-role", "file-c.bin");
    writeFileSync(sourceFile, "data");

    createExecutionTools(roleId, "task-c");
    const result = parseResult(await findTool("publish_artifact_file").handler({
      key: "any",
      sourcePath: sourceFile,
    }));

    expect(result.success).toBe(true);

    const rows = listArtifactsByTask("task-c");
    expect(rows.length).toBe(1);
    expect(rows[0].priority).toBeUndefined();
  });
});

// Case D: invalid priority: -1 → error response containing "priority"
describe("Case D — publish_artifact_file with priority=-1 (invalid)", () => {
  it("returns error containing 'priority'; no artifact created", async () => {
    const roleId = seedRole();
    seedTaskOnlyTask("task-d");

    const sourceFile = join(workspaceRoot, "test-role", "file-d.bin");
    writeFileSync(sourceFile, "data");

    createExecutionTools(roleId, "task-d");
    const result = parseResult(await findTool("publish_artifact_file").handler({
      key: "any",
      sourcePath: sourceFile,
      priority: -1,
    }));

    expect(result.error).toBeDefined();
    expect(String(result.error)).toContain("priority");

    const rows = listArtifactsByTask("task-d");
    expect(rows.length).toBe(0);
  });
});

// Case E: invalid priority: 1001 → error response containing "priority"
describe("Case E — publish_artifact_file with priority=1001 (invalid)", () => {
  it("returns error containing 'priority'; no artifact created", async () => {
    const roleId = seedRole();
    seedTaskOnlyTask("task-e");

    const sourceFile = join(workspaceRoot, "test-role", "file-e.bin");
    writeFileSync(sourceFile, "data");

    createExecutionTools(roleId, "task-e");
    const result = parseResult(await findTool("publish_artifact_file").handler({
      key: "any",
      sourcePath: sourceFile,
      priority: 1001,
    }));

    expect(result.error).toBeDefined();
    expect(String(result.error)).toContain("priority");

    const rows = listArtifactsByTask("task-e");
    expect(rows.length).toBe(0);
  });
});

// Case F: write_artifact with priority: 20 → JSON-kind artifact row has priority=20
describe("Case F — write_artifact with priority=20", () => {
  it("JSON artifact row has priority=20", async () => {
    const roleId = seedRole();
    seedTemplateStepTask("task-f", "exec-f", "step-f");

    createExecutionTools(roleId, "task-f");
    const result = parseResult(await findTool("write_artifact").handler({
      key: "step-f",
      value: { data: "test" },
      priority: 20,
    }));

    expect(result.success).toBe(true);

    const rows = listArtifactsByExecution("exec-f");
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("json");
    expect(rows[0].priority).toBe(20);
  });
});
