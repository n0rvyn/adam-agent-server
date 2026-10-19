import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import type { TaskStep, TaskTemplate } from "../../shared/types.js";

const { cleanup } = setupTestDb();
const workspaceRoot = mkdtempSync(tmpdir() + sep + "adam-key-override-");

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

vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: vi.fn((roleName: string) => {
    const path = join(workspaceRoot, roleName);
    mkdirSync(path, { recursive: true });
    return path;
  }),
  ensureRoleWorkspace: vi.fn((role: { name: string }) => {
    const path = join(workspaceRoot, role.name);
    mkdirSync(path, { recursive: true });
    return path;
  }),
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ success: true, logEntryId: "mock-log" }),
  }),
}));

vi.mock("../../lib/embedding.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(384)),
}));

import { createRole } from "../../store/roles.js";
import { createTask } from "../../store/tasks.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { createTemplateExecution } from "../../store/template-executions.js";
import { getArtifact } from "../../store/artifacts.js";
import { createExecutionTools } from "../../manager/execution-tools.js";

afterAll(() => {
  delete process.env.ADAM_TEST_DIR;
  rmSync(workspaceRoot, { recursive: true, force: true });
  cleanup();
});

function findTool(name: string) {
  const t = registeredTools.find((tool) => tool.name === name);
  expect(t).toBeDefined();
  return t!;
}

function parseResult(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

/**
 * Seed a template-execution step task where the step optionally has outputAs.
 * Pass stepOutputAs to simulate a migrated step.
 */
function seedStep(args: {
  roleId: string;
  taskId: string;
  executionId: string;
  stepId: string;
  stepOutputAs?: string;
}): void {
  const { roleId, taskId, executionId, stepId, stepOutputAs } = args;
  const templateId = `tmpl-${executionId}`;

  const step: TaskStep = {
    id: stepId,
    prompt: "test step",
    roleId,
    ...(stepOutputAs ? { outputAs: stepOutputAs } : {}),
  };
  const template: TaskTemplate = {
    id: templateId,
    name: `Template ${executionId}`,
    trigger: { type: "manual" },
    steps: [step],
    rolePreference: roleId,
    enabled: true,
    createdAt: Date.now(),
  };
  createTaskTemplate(template);
  createTemplateExecution(executionId, templateId);

  createTask({
    id: taskId,
    parentId: executionId,
    templateId,
    stepId,
    roleId,
    status: "pending",
    prompt: "step task",
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
    createdAt: Date.now(),
  });
}

describe("publish_artifact_file key enforcement", () => {
  beforeEach(() => {
    clearTestDb();
    registeredTools = [];
    rmSync(workspaceRoot, { recursive: true, force: true });
    mkdirSync(workspaceRoot, { recursive: true });
  });

  // (a) step has outputAs="X", LLM calls with key="X" → artifact.key === "X", no `note` field
  it("uses LLM key unchanged when it matches step.outputAs", async () => {
    const roleId = "r-match";
    const taskId = "task-match";
    const executionId = "exec-match";
    const stepId = "step-match";
    const rolePath = join(workspaceRoot, "role-match");
    mkdirSync(rolePath, { recursive: true });
    const sourceFile = join(rolePath, "script.md");
    writeFileSync(sourceFile, "# Script Content");

    createRole({ id: roleId, name: "role-match", cagPrompt: "t", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "m", status: "active", preferences: {}, createdAt: Date.now() });
    seedStep({ roleId, taskId, executionId, stepId, stepOutputAs: "podcast-script" });
    createExecutionTools(roleId, taskId);

    const result = parseResult(await findTool("publish_artifact_file").handler({
      key: "podcast-script",
      sourcePath: sourceFile,
      mime: "text/markdown",
    }));

    expect(result.success).toBe(true);
    expect(result.note).toBeUndefined();
    const artifact = getArtifact(executionId, stepId, "podcast-script");
    expect(artifact).not.toBeNull();
    expect(artifact!.key).toBe("podcast-script");
  });

  // (b) step has outputAs="X", LLM calls with key="Y" → artifact.key === "X", result.note contains "Y" and "X"
  it("overrides LLM key with step.outputAs and returns a structured note", async () => {
    const roleId = "r-override";
    const taskId = "task-override";
    const executionId = "exec-override";
    const stepId = "step-override";
    const rolePath = join(workspaceRoot, "role-override");
    mkdirSync(rolePath, { recursive: true });
    const sourceFile = join(rolePath, "wrong-name.md");
    writeFileSync(sourceFile, "# Script Content");

    createRole({ id: roleId, name: "role-override", cagPrompt: "t", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "m", status: "active", preferences: {}, createdAt: Date.now() });
    seedStep({ roleId, taskId, executionId, stepId, stepOutputAs: "podcast-script" });
    createExecutionTools(roleId, taskId);

    const result = parseResult(await findTool("publish_artifact_file").handler({
      key: "LLM-chosen-wrong-key",
      sourcePath: sourceFile,
      mime: "text/markdown",
    }));

    expect(result.success).toBe(true);
    expect(result.note).toBeDefined();
    expect((result.note as string)).toContain("LLM-chosen-wrong-key");
    expect((result.note as string)).toContain("podcast-script");

    // Artifact is stored under the server-chosen key, not the LLM key
    const artifact = getArtifact(executionId, stepId, "podcast-script");
    expect(artifact).not.toBeNull();
    expect(artifact!.key).toBe("podcast-script");

    // The LLM-chosen key has no artifact
    expect(getArtifact(executionId, stepId, "LLM-chosen-wrong-key")).toBeUndefined();
  });

  // (c) step has no outputAs, LLM calls with key="Y" → artifact.key === "Y", no note
  it("uses LLM key unchanged when step has no outputAs (legacy back-compat)", async () => {
    const roleId = "r-legacy";
    const taskId = "task-legacy";
    const executionId = "exec-legacy";
    const stepId = "step-legacy";
    const rolePath = join(workspaceRoot, "role-legacy");
    mkdirSync(rolePath, { recursive: true });
    const sourceFile = join(rolePath, "file.txt");
    writeFileSync(sourceFile, "content");

    createRole({ id: roleId, name: "role-legacy", cagPrompt: "t", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "m", status: "active", preferences: {}, createdAt: Date.now() });
    seedStep({ roleId, taskId, executionId, stepId }); // no stepOutputAs
    createExecutionTools(roleId, taskId);

    const result = parseResult(await findTool("publish_artifact_file").handler({
      key: "LLM-chosen-key",
      sourcePath: sourceFile,
      mime: "text/plain",
    }));

    expect(result.success).toBe(true);
    expect(result.note).toBeUndefined();
    expect(getArtifact(executionId, stepId, "LLM-chosen-key")).not.toBeNull();
  });

  // (d) step has no outputAs, LLM calls with invalid key → existing validateKey error path
  it("rejects publish_artifact_file with invalid key even when step has no outputAs", async () => {
    const roleId = "r-invalid";
    const taskId = "task-invalid";
    const executionId = "exec-invalid";
    const stepId = "step-invalid";
    const rolePath = join(workspaceRoot, "role-invalid");
    mkdirSync(rolePath, { recursive: true });
    // Source file must exist for path validation to reach the key validation
    writeFileSync(join(rolePath, "missing.txt"), "placeholder");

    createRole({ id: roleId, name: "role-invalid", cagPrompt: "t", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "m", status: "active", preferences: {}, createdAt: Date.now() });
    seedStep({ roleId, taskId, executionId, stepId });
    createExecutionTools(roleId, taskId);

    const result = parseResult(await findTool("publish_artifact_file").handler({
      key: "invalid key with spaces!",
      sourcePath: join(rolePath, "missing.txt"),
    }));

    expect(result.error).toBeDefined();
    expect((result.error as string)).toContain("Invalid artifact key");
  });

  // (e) non-migrated template (step has no outputAs) → uses LLM key (legacy back-compat).
  // Since templates require >=1 step, we test the non-migrated scenario via a step with no outputAs;
  // templateIsMigrated=false so LLM key is used unchanged.
  it("uses LLM key when step has no outputAs in a non-migrated template (legacy back-compat)", async () => {
    const roleId = "r-malformed";
    const taskId = "task-malformed";
    const executionId = "exec-malformed";
    const stepId = "step-malformed";
    const rolePath = join(workspaceRoot, "role-malformed");
    mkdirSync(rolePath, { recursive: true });
    const sourceFile = join(rolePath, "file.txt");
    writeFileSync(sourceFile, "content");

    createRole({ id: roleId, name: "role-malformed", cagPrompt: "t", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "m", status: "active", preferences: {}, createdAt: Date.now() });
    seedStep({ roleId, taskId, executionId, stepId }); // no stepOutputAs → templateIsMigrated=false
    createExecutionTools(roleId, taskId);

    const result = parseResult(await findTool("publish_artifact_file").handler({
      key: "legacy-key",
      sourcePath: sourceFile,
      mime: "text/plain",
    }));

    expect(result.success).toBe(true);
    expect(result.note).toBeUndefined();
    // No override — artifact stored under LLM key
    expect(getArtifact(executionId, stepId, "legacy-key")).not.toBeNull();
  });
});

describe("write_artifact key enforcement", () => {
  beforeEach(() => {
    clearTestDb();
    registeredTools = [];
    rmSync(workspaceRoot, { recursive: true, force: true });
    mkdirSync(workspaceRoot, { recursive: true });
  });

  // (a) step has outputAs="X", LLM calls with key="X" → artifact.key === "X", no `note` field
  it("uses LLM key unchanged when it matches step.outputAs", async () => {
    const roleId = "r-wr-match";
    const taskId = "task-wr-match";
    const executionId = "exec-wr-match";
    const stepId = "step-wr-match";

    createRole({ id: roleId, name: "role-wr-match", cagPrompt: "t", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "m", status: "active", preferences: {}, createdAt: Date.now() });
    seedStep({ roleId, taskId, executionId, stepId, stepOutputAs: "summary-data" });
    createExecutionTools(roleId, taskId);

    const result = parseResult(await findTool("write_artifact").handler({
      key: "summary-data",
      value: { count: 42 },
    }));

    expect(result.success).toBe(true);
    expect(result.note).toBeUndefined();
    expect(getArtifact(executionId, stepId, "summary-data")).not.toBeNull();
  });

  // (b) step has outputAs="X", LLM calls with key="Y" → artifact.key === "X", result.note contains both keys
  it("overrides LLM key with step.outputAs and returns a structured note", async () => {
    const roleId = "r-wr-override";
    const taskId = "task-wr-override";
    const executionId = "exec-wr-override";
    const stepId = "step-wr-override";

    createRole({ id: roleId, name: "role-wr-override", cagPrompt: "t", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "m", status: "active", preferences: {}, createdAt: Date.now() });
    seedStep({ roleId, taskId, executionId, stepId, stepOutputAs: "summary-data" });
    createExecutionTools(roleId, taskId);

    const result = parseResult(await findTool("write_artifact").handler({
      key: "wrong-key-from-llm",
      value: { count: 42 },
    }));

    expect(result.success).toBe(true);
    expect(result.note).toBeDefined();
    expect((result.note as string)).toContain("wrong-key-from-llm");
    expect((result.note as string)).toContain("summary-data");
    expect(getArtifact(executionId, stepId, "summary-data")).not.toBeNull();
    expect(getArtifact(executionId, stepId, "wrong-key-from-llm")).toBeUndefined();
  });

  // (c) step has no outputAs, LLM calls with key="Y" → artifact.key === "Y", no note
  it("uses LLM key unchanged when step has no outputAs (legacy back-compat)", async () => {
    const roleId = "r-wr-legacy";
    const taskId = "task-wr-legacy";
    const executionId = "exec-wr-legacy";
    const stepId = "step-wr-legacy";

    createRole({ id: roleId, name: "role-wr-legacy", cagPrompt: "t", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "m", status: "active", preferences: {}, createdAt: Date.now() });
    seedStep({ roleId, taskId, executionId, stepId }); // no stepOutputAs
    createExecutionTools(roleId, taskId);

    const result = parseResult(await findTool("write_artifact").handler({
      key: "my-arbitrary-key",
      value: { foo: "bar" },
    }));

    expect(result.success).toBe(true);
    expect(result.note).toBeUndefined();
    expect(getArtifact(executionId, stepId, "my-arbitrary-key")).not.toBeNull();
  });

  // (d) step has no outputAs, LLM calls with empty key → existing validateKey error path
  it("rejects write_artifact with empty key even when step has no outputAs", async () => {
    const roleId = "r-wr-empty";
    const taskId = "task-wr-empty";
    const executionId = "exec-wr-empty";
    const stepId = "step-wr-empty";

    createRole({ id: roleId, name: "role-wr-empty", cagPrompt: "t", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "m", status: "active", preferences: {}, createdAt: Date.now() });
    seedStep({ roleId, taskId, executionId, stepId });
    createExecutionTools(roleId, taskId);

    const result = parseResult(await findTool("write_artifact").handler({
      key: "",
      value: { foo: "bar" },
    }));

    expect(result.error).toBeDefined();
    expect((result.error as string)).toContain("Invalid artifact key");
  });

  // (e) non-migrated template (step has no outputAs) → uses LLM key (legacy back-compat).
  // Since templates require >=1 step, we test the non-migrated scenario by creating a template
  // where the step has no outputAs; templateIsMigrated=false so LLM key is used unchanged.
  it("uses LLM key when step has no outputAs in a non-migrated template (legacy back-compat)", async () => {
    const roleId = "r-wr-malformed";
    const taskId = "task-wr-malformed";
    const executionId = "exec-wr-malformed";
    const stepId = "step-wr-malformed";

    createRole({ id: roleId, name: "role-wr-malformed", cagPrompt: "t", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "m", status: "active", preferences: {}, createdAt: Date.now() });
    seedStep({ roleId, taskId, executionId, stepId }); // no stepOutputAs → templateIsMigrated=false
    createExecutionTools(roleId, taskId);

    const result = parseResult(await findTool("write_artifact").handler({
      key: "legacy-key",
      value: { ok: true },
    }));

    expect(result.success).toBe(true);
    expect(result.note).toBeUndefined();
    expect(getArtifact(executionId, stepId, "legacy-key")).not.toBeNull();
  });
});
