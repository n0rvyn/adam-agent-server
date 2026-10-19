/**
 * Tests for publish_artifact_file task-context (source_kind='task_published') path.
 * Task 2-tests — these FAIL before Task 2-impl, pass after.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
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
  }),
}));

const workspaceRoot = mkdtempSync(tmpdir() + sep + "adam-task-pub-test-");

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
import { listArtifactsByTask, listArtifactsByExecution, getArtifact } from "../../store/artifacts.js";
import { getDeliverableFileArtifacts } from "../../lib/artifact-attachments.js";
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
    // No parentId, no templateId, no stepId — pure dispatch_task context
  });
}

// Case A — happy path single file publish
describe("publish_artifact_file task-context — happy path (case A)", () => {
  it("publishes file as source_kind='task_published' with correct fields", async () => {
    const roleId = seedRole();
    seedTaskOnlyTask();

    const sourceFile = join(workspaceRoot, "test-role", "tmpfile.bin");
    const content = "hello task artifact";
    writeFileSync(sourceFile, content);

    createExecutionTools(roleId, "task-1");
    const tool = findTool("publish_artifact_file");
    const result = parseResult(await tool.handler({
      key: "any-key",
      sourcePath: sourceFile,
      mime: "application/octet-stream",
    }));

    expect(result.success).toBe(true);
    expect(typeof result.artifactId).toBe("string");
    expect(typeof result.sizeBytes).toBe("number");

    const rows = listArtifactsByTask("task-1");
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.sourceKind).toBe("task_published");
    expect(row.taskId).toBe("task-1");
    expect(row.executionId).toBeUndefined();
    expect(row.stepId).toBeUndefined();
    expect(row.key).toBeUndefined();
    expect(row.originalFilename).toBe("tmpfile.bin");
    expect(row.roleId).toBe(roleId);
    expect(row.sizeBytes).toBe(content.length);
    expect(row.blobPath).toBeDefined();
    expect(row.blobPath!.startsWith(join(process.env.ADAM_TEST_DIR!, "artifacts", "task"))).toBe(true);
    expect(row.blobPath!.endsWith(".bin")).toBe(true);
    expect(existsSync(row.blobPath!)).toBe(true);
  });
});

// Case B — key parameter is ignored
describe("publish_artifact_file task-context — key ignored (case B)", () => {
  it("key in args is discarded; artifact row has key=undefined", async () => {
    const roleId = seedRole();
    seedTaskOnlyTask();

    const sourceFile = join(workspaceRoot, "test-role", "file-b.bin");
    writeFileSync(sourceFile, "content");

    createExecutionTools(roleId, "task-1");
    const tool = findTool("publish_artifact_file");
    const result = parseResult(await tool.handler({
      key: "should-be-ignored",
      sourcePath: sourceFile,
    }));

    expect(result.success).toBe(true);
    const rows = listArtifactsByTask("task-1");
    expect(rows.length).toBe(1);
    expect(rows[0].key).toBeUndefined();
  });
});

// Case C — outputAs not enforced in task context
describe("publish_artifact_file task-context — no outputAs enforcement (case C)", () => {
  it("succeeds without template context; no step-has-no-outputAs error", async () => {
    const roleId = seedRole();
    seedTaskOnlyTask();

    const sourceFile = join(workspaceRoot, "test-role", "file-c.bin");
    writeFileSync(sourceFile, "data");

    createExecutionTools(roleId, "task-1");
    const tool = findTool("publish_artifact_file");
    const result = parseResult(await tool.handler({
      key: "any",
      sourcePath: sourceFile,
    }));

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

// Case D — sourcePath outside workspace
describe("publish_artifact_file task-context — sourcePath escapes workspace (case D)", () => {
  it("returns error containing 'escapes workspace'; no artifact row created", async () => {
    const roleId = seedRole();
    seedTaskOnlyTask();

    // File exists but is outside the workspace root
    const outsideFile = join(tmpdir(), "outside-adam-task-test.bin");
    writeFileSync(outsideFile, "outside");

    createExecutionTools(roleId, "task-1");
    const tool = findTool("publish_artifact_file");
    const result = parseResult(await tool.handler({
      key: "k",
      sourcePath: outsideFile,
    }));

    expect(result.error).toBeDefined();
    expect(String(result.error)).toMatch(/escapes workspace/i);
    expect(listArtifactsByTask("task-1").length).toBe(0);
  });
});

// Case E — sourcePath does not exist
describe("publish_artifact_file task-context — sourcePath not found (case E)", () => {
  it("returns error containing ENOENT or 'no such file'", async () => {
    const roleId = seedRole();
    seedTaskOnlyTask();

    const missingPath = join(workspaceRoot, "test-role", "nonexistent.bin");
    // Do NOT create the file

    createExecutionTools(roleId, "task-1");
    const tool = findTool("publish_artifact_file");
    const result = parseResult(await tool.handler({
      key: "k",
      sourcePath: missingPath,
    }));

    expect(result.error).toBeDefined();
    expect(listArtifactsByTask("task-1").length).toBe(0);
  });
});

// Case F — no taskId
describe("publish_artifact_file task-context — no taskId (case F)", () => {
  it("returns 'artifact tools require a task context'", async () => {
    const roleId = seedRole();
    createExecutionTools(roleId, undefined);
    const tool = findTool("publish_artifact_file");
    const result = parseResult(await tool.handler({ key: "k", sourcePath: "/tmp/x" }));

    expect(result.error).toMatch(/artifact tools require a task context/);
  });
});

// Case G — taskId points to nonexistent task
describe("publish_artifact_file task-context — task not found (case G)", () => {
  it("returns 'task not found: ...'", async () => {
    const roleId = seedRole();
    createExecutionTools(roleId, "nonexistent-task-id");
    const tool = findTool("publish_artifact_file");
    const result = parseResult(await tool.handler({ key: "k", sourcePath: "/tmp/x" }));

    expect(result.error).toMatch(/task not found/);
  });
});

// Case H — task exists but roleId is missing
describe("publish_artifact_file task-context — task with no roleId (case H)", () => {
  it("returns error containing 'no role context'", async () => {
    // Task created with no roleId, and createExecutionTools also has no roleId
    createTask({
      id: "task-no-role",
      roleId: undefined,
      status: "pending",
      prompt: "no role",
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
      createdAt: Date.now(),
    });

    createExecutionTools(undefined as unknown as string, "task-no-role");
    const tool = findTool("publish_artifact_file");
    const result = parseResult(await tool.handler({ key: "k", sourcePath: "/tmp/x" }));

    expect(result.error).toBeDefined();
    expect(String(result.error)).toMatch(/no role context/i);
  });
});

// Case I (regression) — template execution step → must still produce template_step row
describe("publish_artifact_file task-context — template step regression (case I)", () => {
  it("template step still produces source_kind='template_step' with executionId + stepId + key", async () => {
    const roleId = seedRole();

    createTaskTemplate({
      id: "tmpl-regression",
      name: "regression-template",
      trigger: { type: "manual" },
      steps: [{ id: "step-r", prompt: "x", roleId }],
      rolePreference: "test-role",
      enabled: true,
      createdAt: Date.now(),
    });
    createTemplateExecution("exec-regression", "tmpl-regression");
    createTask({
      id: "task-regression",
      parentId: "exec-regression",
      templateId: "tmpl-regression",
      stepId: "step-r",
      roleId,
      status: "pending",
      prompt: "template step",
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
      createdAt: Date.now(),
    });

    const sourceFile = join(workspaceRoot, "test-role", "regression.bin");
    writeFileSync(sourceFile, "regression data");

    createExecutionTools(roleId, "task-regression");
    const tool = findTool("publish_artifact_file");
    const result = parseResult(await tool.handler({
      key: "step-r",
      sourcePath: sourceFile,
      mime: "application/octet-stream",
    }));

    expect(result.success).toBe(true);

    const artifact = getArtifact("exec-regression", "step-r", "step-r");
    expect(artifact).toBeDefined();
    expect(artifact!.sourceKind).toBe("template_step");
    expect(artifact!.executionId).toBe("exec-regression");
    expect(artifact!.stepId).toBe("step-r");
    expect(artifact!.key).toBe("step-r");
  });
});

// Case J (regression) — getDeliverableFileArtifacts must not mix in task_published rows
describe("publish_artifact_file task-context — getDeliverableFileArtifacts isolation (case J)", () => {
  it("task_published row is NOT returned by getDeliverableFileArtifacts for a given executionId", async () => {
    const roleId = seedRole();

    // Set up template execution with a template_step artifact
    createTaskTemplate({
      id: "tmpl-j",
      name: "template-j",
      trigger: { type: "manual" },
      steps: [{ id: "step-j", prompt: "x", roleId }],
      rolePreference: "test-role",
      enabled: true,
      createdAt: Date.now(),
    });
    createTemplateExecution("exec-j", "tmpl-j");
    createTask({
      id: "task-j-step",
      parentId: "exec-j",
      templateId: "tmpl-j",
      stepId: "step-j",
      roleId,
      status: "pending",
      prompt: "step",
      config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
      createdAt: Date.now(),
    });

    // Also set up a plain task that will produce task_published
    seedTaskOnlyTask("task-j-plain");

    const stepFile = join(workspaceRoot, "test-role", "step-j.bin");
    writeFileSync(stepFile, "step data");

    const plainFile = join(workspaceRoot, "test-role", "plain-j.bin");
    writeFileSync(plainFile, "plain task data");

    // Publish template step artifact
    createExecutionTools(roleId, "task-j-step");
    const tool = findTool("publish_artifact_file");
    const stepResult = parseResult(await tool.handler({
      key: "step-j",
      sourcePath: stepFile,
      mime: "application/octet-stream",
    }));
    expect(stepResult.success).toBe(true);

    // Re-register tools for plain task
    registeredTools = [];
    createExecutionTools(roleId, "task-j-plain");
    const tool2 = findTool("publish_artifact_file");
    const plainResult = parseResult(await tool2.handler({
      key: "ignored",
      sourcePath: plainFile,
      mime: "application/octet-stream",
    }));
    expect(plainResult.success).toBe(true);

    // getDeliverableFileArtifacts by executionId must NOT include the task_published row
    const deliverables = getDeliverableFileArtifacts("exec-j");
    expect(deliverables.length).toBe(1);
    expect(deliverables[0].sourceKind).toBe("template_step");
    expect(deliverables[0].executionId).toBe("exec-j");
  });
});
