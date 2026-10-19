import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Capture tools registered via createSdkMcpServer
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
  listChannels: vi.fn(() => [
    { id: "ch-1", name: "WeChat on iPad", platform: "wechat", enabled: true, status: "connected", config: { userId: "user-123" } },
    { id: "ch-2", name: "Telegram Bot", platform: "telegram", enabled: true, status: "connected", config: { userId: "tg-456" } },
  ]),
  getChannel: vi.fn((id: string) => {
    const channels: Record<string, { platform: string }> = {
      "ch-1": { platform: "wechat" },
      "ch-2": { platform: "telegram" },
    };
    return channels[id] ?? null;
  }),
}));

vi.mock("../../chat/session-manager.js", () => ({
  listSessions: vi.fn(() => []),
}));

const workspaceRoot = mkdtempSync(tmpdir() + sep + "adam-exec-tools-");

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

const mockSendMessage = vi.fn().mockResolvedValue("msg-001");
vi.mock("../../server/routes/channels.js", () => ({
  getChannelManager: vi.fn(() => ({
    sendMessage: mockSendMessage,
  })),
}));

// Mock OutboundGateway — execution-tools' send_to_channel now delegates to gateway.send()
const mockGatewaySend = vi.fn().mockResolvedValue({ success: true, logEntryId: "mock-log", messageId: "msg-001" });
vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined),
    send: mockGatewaySend,
  }),
}));

// Mock embedding generation for save_memory
const mockGenerateEmbedding = vi.fn().mockResolvedValue(new Float32Array(384));
vi.mock("../../lib/embedding.js", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
}));

import { createRole, getRole } from "../../store/roles.js";
import { createMemory, getMemory, deleteMemory } from "../../store/memories.js";
import { createTask, getTask } from "../../store/tasks.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { createTemplateExecution } from "../../store/template-executions.js";
import { getArtifact, listArtifactsByExecution } from "../../store/artifacts.js";
import { listAccessLogByExecution } from "../../store/artifact-access-log.js";
import { createExecutionTools } from "../../manager/execution-tools.js";

afterAll(() => {
  delete process.env.ADAM_TEST_DIR;
  rmSync(workspaceRoot, { recursive: true, force: true });
  cleanup();
});
beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
  mockGatewaySend.mockClear();
  registeredTools = [];
  rmSync(workspaceRoot, { recursive: true, force: true });
  mkdirSync(workspaceRoot, { recursive: true });
  process.env.ADAM_TEST_DIR = workspaceRoot;
});

function createTestRole(id: string, allowedChannels?: string[]) {
  createRole({
    id,
    name: `test-role-${id}`,
    cagPrompt: "Test",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `mem-${id}`,
    status: "active",
    preferences: {},
    createdAt: Date.now(),
    allowedChannels,
  });
}

async function callSendToChannel(channelName: string, message: string) {
  const sendTool = registeredTools.find((t) => t.name === "send_to_channel");
  expect(sendTool).toBeDefined();
  return sendTool!.handler({ channelName, message });
}

function findTool(name: string) {
  const t = registeredTools.find((tool) => tool.name === name);
  expect(t).toBeDefined();
  return t!;
}

function parseResult(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

function seedTemplateExecutionStepTask(args: {
  roleId: string;
  roleName: string;
  taskId?: string;
  executionId?: string;
  stepId?: string;
}) {
  const taskId = args.taskId ?? "task-step-1";
  const executionId = args.executionId ?? "exec-1";
  const stepId = args.stepId ?? "step-a";
  const workspace = join(workspaceRoot, args.roleName);
  mkdirSync(workspace, { recursive: true });

  createTaskTemplate({
    id: `tmpl-${executionId}`,
    name: executionId,
    trigger: { type: "manual" },
    steps: [{ id: stepId, prompt: "x", roleId: args.roleId }],
    rolePreference: "role-test-seed",
      enabled: true,
    createdAt: Date.now(),
  });
  createTemplateExecution(executionId, `tmpl-${executionId}`);
  createTask({
    id: taskId,
    parentId: executionId,
    templateId: `tmpl-${executionId}`,
    stepId,
    roleId: args.roleId,
    status: "pending",
    prompt: "TemplateExecution step",
    config: {
      timeout: 600,
      approvalRequired: [],
      approvalTimeout: 300,
    },
    createdAt: Date.now(),
  });

  return { taskId, executionId, stepId, workspace };
}

describe("execution-tools", () => {
  describe("send_to_channel permission (D-004)", () => {
    it("allows send when allowedChannels is undefined (unrestricted)", async () => {
      createTestRole("r-unrestricted");
      createExecutionTools("r-unrestricted");

      const result = await callSendToChannel("WeChat on iPad", "Hello");
      const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
      expect(parsed.success).toBe(true);
      expect(mockGatewaySend).toHaveBeenCalledWith(expect.objectContaining({
        channelId: "ch-1", chatId: "user-123", content: "Hello", messageType: "reply",
      }));
    });

    it("blocks send when allowedChannels is empty array", async () => {
      createTestRole("r-blocked", []);
      createExecutionTools("r-blocked");

      const result = await callSendToChannel("WeChat on iPad", "Hello");
      const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
      expect(parsed.error).toContain("not allowed to send to any channels");
      expect(mockGatewaySend).not.toHaveBeenCalled();
    });

    it("allows send when channel is in whitelist", async () => {
      createTestRole("r-whitelist", ["WeChat on iPad"]);
      createExecutionTools("r-whitelist");

      const result = await callSendToChannel("WeChat on iPad", "Hello");
      const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
      expect(parsed.success).toBe(true);
      expect(mockGatewaySend).toHaveBeenCalledWith(expect.objectContaining({
        channelId: "ch-1", chatId: "user-123", content: "Hello", messageType: "reply",
      }));
    });

    it("blocks send when channel is not in whitelist", async () => {
      createTestRole("r-restricted", ["WeChat on iPad"]);
      createExecutionTools("r-restricted");

      const result = await callSendToChannel("Telegram Bot", "Hello");
      const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
      expect(parsed.error).toContain("not in the allowed channels list");
      expect(mockGatewaySend).not.toHaveBeenCalled();
    });
  });

  describe("TemplateExecution step tool set", () => {
    it("omits channel tools but keeps report_blocked and artifact tools", () => {
      createTestRole("role-template-tools");
      const { taskId } = seedTemplateExecutionStepTask({
        roleId: "role-template-tools",
        roleName: "template-tools-role",
        taskId: "task-template-tools",
        executionId: "exec-template-tools",
      });
      createExecutionTools("role-template-tools", taskId);

      const names = registeredTools.map((tool) => tool.name);
      expect(names).not.toContain("send_to_channel");
      expect(names).not.toContain("list_channels");
      expect(names).toContain("report_blocked");
      expect(names).toContain("publish_artifact_file");
      expect(names).toContain("write_artifact");
    });

    it("keeps report_blocked working for TemplateExecution step tasks", async () => {
      createTestRole("role-template-blocked");
      const { taskId } = seedTemplateExecutionStepTask({
        roleId: "role-template-blocked",
        roleName: "template-blocked-role",
        taskId: "task-template-blocked",
        executionId: "exec-template-blocked",
      });
      createExecutionTools("role-template-blocked", taskId);

      const result = parseResult(await findTool("report_blocked").handler({ reason: "missing_input" }));

      expect(result.success).toBe(true);
      expect(getTask(taskId)?.status).toBe("blocked");
      expect(getTask(taskId)?.blockReason?.reason).toBe("missing_input");
    });
  });

  describe("shared memory tools (scoped to roleId)", () => {
    const roleId = "r-mem-test";

    beforeEach(() => {
      createTestRole(roleId);
      createExecutionTools(roleId);
    });

    it("registers search_memories, save_memory, delete_memory tools", () => {
      const names = registeredTools.map((t) => t.name);
      expect(names).toContain("search_memories");
      expect(names).toContain("save_memory");
      expect(names).toContain("delete_memory");
    });

    it("save_memory creates a new memory with embedding", async () => {
      const saveTool = findTool("save_memory");
      const result = parseResult(await saveTool.handler({ content: "orpheus://search/music", keywords: ["orpheus", "music"], importance: 4 }));

      expect(result.action).toBe("created");
      expect(result.success).toBe(true);
      expect(typeof result.id).toBe("string");
      expect(mockGenerateEmbedding).toHaveBeenCalledWith("orpheus://search/music");

      // Verify memory was persisted in DB
      const mem = getMemory(result.id as string);
      expect(mem).toBeDefined();
      expect(mem!.content).toBe("orpheus://search/music");
      expect(mem!.roleId).toBe(roleId);
      expect(mem!.sourceType).toBe("manual");
      expect(mem!.importance).toBe(4);
    });

    it("save_memory updates existing memory by id", async () => {
      // Create a memory first
      createMemory({
        id: "mem-update-test",
        roleId,
        type: "event",
        content: "old content",
        keywords: [],
        importance: 2,
        sourceType: "manual",
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        retrievedCount: 0,
        tier: "episodic",
      });

      const saveTool = findTool("save_memory");
      const result = parseResult(await saveTool.handler({ id: "mem-update-test", content: "new content", importance: 5 }));

      expect(result.action).toBe("updated");
      expect(result.success).toBe(true);

      const mem = getMemory("mem-update-test");
      expect(mem!.content).toBe("new content");
      expect(mem!.importance).toBe(5);
    });

    it("save_memory returns error for non-existent id", async () => {
      const saveTool = findTool("save_memory");
      const result = parseResult(await saveTool.handler({ id: "non-existent", content: "test" }));

      expect(result.error).toContain("not found");
    });

    it("delete_memory removes a memory", async () => {
      createMemory({
        id: "mem-delete-test",
        roleId,
        type: "thought",
        content: "to be deleted",
        keywords: [],
        importance: 1,
        sourceType: "manual",
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        retrievedCount: 0,
        tier: "episodic",
      });

      const deleteTool = findTool("delete_memory");
      const result = parseResult(await deleteTool.handler({ id: "mem-delete-test" }));

      expect(result.deleted).toBe(true);
      expect(getMemory("mem-delete-test")).toBeUndefined();
    });

    it("delete_memory enforces RBAC — blocks deleting other role's memory", async () => {
      createMemory({
        id: "mem-other-role",
        roleId: "other-role-id",
        type: "thought",
        content: "belongs to other role",
        keywords: [],
        importance: 1,
        sourceType: "manual",
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        retrievedCount: 0,
        tier: "episodic",
      });

      const deleteTool = findTool("delete_memory");
      const result = parseResult(await deleteTool.handler({ id: "mem-other-role" }));

      expect(result.error).toContain("does not belong to this role");
      // Memory should still exist
      expect(getMemory("mem-other-role")).toBeDefined();
    });
  });

  describe("TemplateExecution artifact tools", () => {
    beforeEach(() => {
      createRole({
        id: "role-artifacts",
        name: "artifact-role",
        cagPrompt: "Artifact worker",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "mem-artifacts",
        status: "active",
        preferences: {},
        createdAt: Date.now(),
      });
      seedTemplateExecutionStepTask({ roleId: "role-artifacts", roleName: "artifact-role" });
      createExecutionTools("role-artifacts", "task-step-1");
    });

    it("writes and reads json artifacts for the same template execution", async () => {
      const writeTool = findTool("write_artifact");
      const readTool = findTool("read_artifact");

      const writeResult = parseResult(await writeTool.handler({
        key: "summary",
        value: { ok: true, count: 2 },
      }));
      expect(writeResult.success).toBe(true);

      createTask({
        id: "task-step-2",
        parentId: "exec-1",
        stepId: "step-b",
        roleId: "role-artifacts",
        status: "pending",
        prompt: "downstream step",
        config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
        createdAt: Date.now(),
      });
      createExecutionTools("role-artifacts", "task-step-2");

      const downstreamRead = parseResult(await findTool("read_artifact").handler({
        stepId: "step-a",
        key: "summary",
      }));
      expect(downstreamRead.value).toEqual({ ok: true, count: 2 });
      expect(getArtifact("exec-1", "step-a", "summary")).toMatchObject({
        kind: "json",
        value: { ok: true, count: 2 },
      });
      expect(listAccessLogByExecution("exec-1").some((entry) => entry.tool === "read_artifact" && entry.outcome === "success")).toBe(true);

      createExecutionTools("role-artifacts", "task-step-1");
      expect(readTool).toBeDefined();
    });

    it("publishes, lists, and fetches file artifacts inside the role workspace", async () => {
      const sourceFile = join(workspaceRoot, "artifact-role", "report.txt");
      writeFileSync(sourceFile, "template execution report");

      const publishResult = parseResult(await findTool("publish_artifact_file").handler({
        key: "report",
        sourcePath: sourceFile,
        mime: "text/plain",
        cleanup: true,
      }));
      expect(publishResult.success).toBe(true);
      expect(existsSync(sourceFile)).toBe(false);

      const listed = parseResult(await findTool("list_artifacts").handler({}));
      expect(listed.artifacts).toEqual([
        expect.objectContaining({
          key: "report",
          kind: "file",
          mime: "text/plain",
        }),
      ]);

      createTask({
        id: "task-step-3",
        parentId: "exec-1",
        stepId: "step-c",
        roleId: "role-artifacts",
        status: "pending",
        prompt: "consumer step",
        config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
        createdAt: Date.now(),
      });
      createExecutionTools("role-artifacts", "task-step-3");

      const destDir = join(workspaceRoot, "artifact-role", "downloads");
      mkdirSync(destDir, { recursive: true });
      const destPath = join(destDir, "report-copy.txt");
      const fetched = parseResult(await findTool("fetch_artifact_file").handler({
        stepId: "step-a",
        key: "report",
        destPath,
      }));

      expect(fetched.success).toBe(true);
      expect(readFileSync(destPath, "utf8")).toBe("template execution report");
      expect(listArtifactsByExecution("exec-1").map((artifact) => artifact.key)).toContain("report");
    });

    it("denies artifact file access outside the role workspace", async () => {
      const sourceFile = join(workspaceRoot, "artifact-role", "safe.txt");
      writeFileSync(sourceFile, "ok");

      const publishResult = parseResult(await findTool("publish_artifact_file").handler({
        key: "safe",
        sourcePath: sourceFile,
      }));
      expect(publishResult.success).toBe(true);

      createTask({
        id: "task-step-4",
        parentId: "exec-1",
        stepId: "step-d",
        roleId: "role-artifacts",
        status: "pending",
        prompt: "bad consumer",
        config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
        createdAt: Date.now(),
      });
      createExecutionTools("role-artifacts", "task-step-4");

      const denied = parseResult(await findTool("fetch_artifact_file").handler({
        stepId: "step-a",
        key: "safe",
        destPath: "/tmp/outside-workspace.txt",
      }));

      expect(denied.error).toContain("destination escapes workspace");
      expect(listAccessLogByExecution("exec-1").some((entry) => entry.tool === "fetch_artifact_file" && entry.outcome === "denied")).toBe(true);
    });

    it("overwrites an existing regular dest; denies a symlink dest", async () => {
      const sourceFile = join(workspaceRoot, "artifact-role", "safe.txt");
      writeFileSync(sourceFile, "ok");
      const publishResult = parseResult(await findTool("publish_artifact_file").handler({
        key: "safe",
        sourcePath: sourceFile,
      }));
      expect(publishResult.success).toBe(true);

      createTask({
        id: "task-step-5",
        parentId: "exec-1",
        stepId: "step-e",
        roleId: "role-artifacts",
        status: "pending",
        prompt: "existing target consumer",
        config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
        createdAt: Date.now(),
      });
      createExecutionTools("role-artifacts", "task-step-5");

      const destDir = join(workspaceRoot, "artifact-role", "downloads");
      mkdirSync(destDir, { recursive: true });

      const existingPath = join(destDir, "existing.txt");
      writeFileSync(existingPath, "old");
      const existingResult = parseResult(await findTool("fetch_artifact_file").handler({
        stepId: "step-a",
        key: "safe",
        destPath: existingPath,
      }));
      // Overwriting a stale same-named leftover is now allowed (blocking it caused steps to read old files).
      expect(existingResult.success).toBe(true);

      const outside = join(workspaceRoot, "outside.txt");
      writeFileSync(outside, "outside");
      const linkPath = join(destDir, "link.txt");
      symlinkSync(outside, linkPath);
      const linkResult = parseResult(await findTool("fetch_artifact_file").handler({
        stepId: "step-a",
        key: "safe",
        destPath: linkPath,
      }));
      expect(linkResult.error).toContain("symlink");
    });

    it("fails and rolls back publish when cleanup=true cannot remove the source file", async () => {
      const lockedDir = join(workspaceRoot, "artifact-role", "locked");
      mkdirSync(lockedDir, { recursive: true });
      const sourceFile = join(lockedDir, "locked.txt");
      writeFileSync(sourceFile, "locked");
      chmodSync(lockedDir, 0o555);

      const result = parseResult(await findTool("publish_artifact_file").handler({
        key: "locked",
        sourcePath: sourceFile,
        cleanup: true,
      }));

      chmodSync(lockedDir, 0o755);

      expect(result.error).toBeDefined();
      expect(existsSync(sourceFile)).toBe(true);
      expect(getArtifact("exec-1", "step-a", "locked")).toBeUndefined();
      expect(listArtifactsByExecution("exec-1").map((artifact) => artifact.key)).not.toContain("locked");
    });

    // Plan Task 5 — missing assertions per implementation-reviewer audit

    it("rejects write_artifact with invalid key format and logs a denied entry", async () => {
      const writeTool = findTool("write_artifact");
      const result = parseResult(await writeTool.handler({ key: "bad key!", value: { x: 1 } }));
      expect(result.error).toContain("Invalid artifact key");
      expect(getArtifact("exec-1", "step-a", "bad key!")).toBeUndefined();
      const log = listAccessLogByExecution("exec-1");
      expect(log.some((e) => e.tool === "write_artifact" && e.outcome === "denied")).toBe(true);
    });

    it("accepts write_artifact with Chinese (Unicode letter) key — regex parity with lib/tool-schemas", async () => {
      const writeTool = findTool("write_artifact");
      const result = parseResult(await writeTool.handler({ key: "播客草稿", value: { text: "今日早播客内容…" } }));
      expect(result.error).toBeUndefined();
      const persisted = getArtifact("exec-1", "step-a", "播客草稿");
      expect(persisted).toBeDefined();
    });

    it("rejects write_artifact when serialized JSON exceeds 256KB", async () => {
      const writeTool = findTool("write_artifact");
      const bigString = "x".repeat(300 * 1024);
      const result = parseResult(await writeTool.handler({ key: "too-big", value: { s: bigString } }));
      expect(result.error).toContain("exceeds");
      expect(getArtifact("exec-1", "step-a", "too-big")).toBeUndefined();
      const log = listAccessLogByExecution("exec-1");
      expect(log.some((e) => e.tool === "write_artifact" && e.outcome === "denied" && e.artifactKey === "too-big")).toBe(true);
    });

    it("rejects publish_artifact_file when sourcePath is an in-workspace symlink escaping the workspace", async () => {
      const outside = join(workspaceRoot, "outside-secret.txt");
      writeFileSync(outside, "secret");
      const linkPath = join(workspaceRoot, "artifact-role", "evil-link.txt");
      symlinkSync(outside, linkPath);

      const result = parseResult(await findTool("publish_artifact_file").handler({
        key: "evil",
        sourcePath: linkPath,
      }));
      expect(result.error).toContain("escapes workspace");
      expect(getArtifact("exec-1", "step-a", "evil")).toBeUndefined();
      const log = listAccessLogByExecution("exec-1");
      expect(log.some((e) => e.tool === "publish_artifact_file" && e.outcome === "denied" && e.artifactKey === "evil")).toBe(true);
    });

    it("artifact tools return template execution-context error when the task is not a TemplateExecution step", async () => {
      createTask({
        id: "task-no-step",
        roleId: "role-artifacts",
        status: "pending",
        prompt: "not a TemplateExecution step",
        config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
        createdAt: Date.now(),
      });
      createExecutionTools("role-artifacts", "task-no-step");

      const writeResult = parseResult(await findTool("write_artifact").handler({ key: "k", value: { a: 1 } }));
      expect(writeResult.error).toContain("not a TemplateExecution step");

      const readResult = parseResult(await findTool("read_artifact").handler({ stepId: "step-a", key: "k" }));
      expect(readResult.error).toContain("not a TemplateExecution step");
    });

    it("enforces cross-execution isolation (read_artifact from execution Y cannot see execution X)", async () => {
      // Seed execution X with an artifact via step-a (current context)
      const writeResult = parseResult(await findTool("write_artifact").handler({
        key: "shared",
        value: { secret: true },
      }));
      expect(writeResult.success).toBe(true);

      // Now create a task in a DIFFERENT execution
      createTaskTemplate({
        id: "tmpl-exec-y",
        name: "exec-y",
        trigger: { type: "manual" },
        steps: [{ id: "step-y", prompt: "y", roleId: "role-artifacts" }],
        rolePreference: "role-test-seed",
      enabled: true,
        createdAt: Date.now(),
      });
      createTemplateExecution("exec-y", "tmpl-exec-y");
      createTask({
        id: "task-exec-y",
        parentId: "exec-y",
        stepId: "step-y",
        roleId: "role-artifacts",
        status: "pending",
        prompt: "different execution",
        config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
        createdAt: Date.now(),
      });
      createExecutionTools("role-artifacts", "task-exec-y");

      // Attempt to read the artifact from execution X → must NOT find it
      const readResult = parseResult(await findTool("read_artifact").handler({
        stepId: "step-a",
        key: "shared",
      }));
      expect(readResult.error).toContain("no artifact at");
      expect(readResult.value).toBeUndefined();

      // list_artifacts scoped to current execution only
      const listed = parseResult(await findTool("list_artifacts").handler({}));
      expect(listed.artifacts).toEqual([]);
    });
  });

  describe("report_blocked", () => {
    const roleId = "r-blocked-test";
    let onBlockedCalls: number;

    beforeEach(() => {
      createTestRole(roleId);
      onBlockedCalls = 0;
      createExecutionTools(roleId, "task-block-1", () => { onBlockedCalls++; });
      createTask({
        id: "task-block-1",
        roleId,
        status: "running",
        prompt: "test",
        config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
        createdAt: Date.now(),
      });
    });

    it("writes tasks.status = 'blocked' and populates block_reason_json", async () => {
      const tool = findTool("report_blocked");
      const result = parseResult(await tool.handler({
        reason: "missing_credential",
        missingPrereqs: ["MINIMAX_API_KEY"],
        resumeHint: "set MINIMAX_API_KEY in role env",
      }));

      expect(result.success).toBe(true);
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("missing_credential");

      // Verify DB state
      const updated = getTask("task-block-1");
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason).toEqual({
        reason: "missing_credential",
        missingPrereqs: ["MINIMAX_API_KEY"],
        resumeHint: "set MINIMAX_API_KEY in role env",
      });
    });

    it("writes tasks.status = 'blocked' when only reason is provided", async () => {
      const tool = findTool("report_blocked");
      await tool.handler({ reason: "missing_input" });

      const updated = getTask("task-block-1");
      expect(updated?.status).toBe("blocked");
      expect(updated?.blockReason?.reason).toBe("missing_input");
      expect(updated?.blockReason?.missingPrereqs).toBeUndefined();
      expect(updated?.blockReason?.resumeHint).toBeUndefined();
    });

    it("calls onBlocked hook when provided", async () => {
      const tool = findTool("report_blocked");
      await tool.handler({ reason: "missing_target" });

      expect(onBlockedCalls).toBe(1);
    });

    it("returns error when no task context (taskId not available)", async () => {
      // createExecutionTools without taskId — report_blocked should error
      createExecutionTools(roleId, undefined, () => { onBlockedCalls++; });
      const tool = findTool("report_blocked");
      const result = parseResult(await tool.handler({ reason: "missing_credential" }));
      expect(result.error).toContain("report_blocked requires a task context");
    });

    it("returns error when task not found", async () => {
      createExecutionTools(roleId, "nonexistent-task-id", () => { onBlockedCalls++; });
      const tool = findTool("report_blocked");
      const result = parseResult(await tool.handler({ reason: "missing_credential" }));
      expect(result.error).toContain("task not found");
    });
  });
});
