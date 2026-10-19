import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

const workspaceRoot = mkdtempSync(tmpdir() + sep + "adam-validator-test-");

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

const mockGatewaySend = vi.fn().mockResolvedValue({ success: true, logEntryId: "mock-log", messageId: "msg-001" });
vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({
    redeliverExecutionTo: vi.fn().mockResolvedValue(undefined),
    send: mockGatewaySend,
  }),
}));

vi.mock("../../lib/embedding.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(384)),
}));

import { createRole } from "../../store/roles.js";
import { createTask } from "../../store/tasks.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { createTemplateExecution } from "../../store/template-executions.js";
import { listArtifactsByExecution } from "../../store/artifacts.js";
import { getArtifactsDir } from "../../lib/artifact-storage.js";
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

function findTool(name: string) {
  const t = registeredTools.find((tool: { name: string }) => tool.name === name);
  expect(t).toBeDefined();
  return t!;
}

function parseResult(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

/**
 * Copy a fixture from the fixtures/ directory into the role's workspace so that
 * validatePathInWorkspace (which checks sourcePath against ctx.roleWorkspacePath)
 * passes. Returns the destination path.
 */
function copyFixtureIntoWorkspace(workspace: string, fixtureName: string): string {
  const dest = join(workspace, fixtureName);
  const src = join(process.cwd(), "src/__tests__/fixtures/validators", fixtureName);
  expect(existsSync(src), `fixture not found: ${src}`).toBe(true);
  writeFileSync(dest, readFileSync(src));
  return dest;
}

function seedExecution(opts: {
  roleId: string;
  roleName: string;
  executionId?: string;
  taskId?: string;
  stepId?: string;
  templateId?: string;
  steps?: Array<{ id: string; prompt: string; assertions?: string[] }>;
}) {
  const executionId = opts.executionId ?? "exec-val";
  const stepId = opts.stepId ?? "step-val-a";
  const templateId = opts.templateId ?? "tmpl-val";

  createTaskTemplate({
    id: templateId,
    name: `validator-test-${templateId}`,
    trigger: { type: "manual" },
    steps: opts.steps ?? [{ id: stepId, prompt: "x" }],
    rolePreference: "role-test-seed",
    enabled: true,
    createdAt: Date.now(),
  });
  createTemplateExecution(executionId, templateId);
  createTask({
    id: opts.taskId ?? "task-val",
    parentId: executionId,
    templateId,
    stepId,
    roleId: opts.roleId,
    status: "pending",
    prompt: "Validator test task",
    config: {
      timeout: 600,
      approvalRequired: [],
      approvalTimeout: 300,
    },
    createdAt: Date.now(),
  });

  // seedExecution does NOT create the workspace subdir — callers must do so before writing files
  const workspace = join(workspaceRoot, opts.roleName);
  return { executionId, stepId, templateId, workspace };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("publish_artifact_file — Phase 3 validator integration", () => {
  describe("Test 1: publish with passing assertions — success path", () => {
    it("passes validation and creates the artifact when assertions hold", async () => {
      const roleId = "r-val-pass";
      createRole({
        id: roleId,
        name: "r-val-pass",
        cagPrompt: "Test",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: `mem-${roleId}`,
        status: "active",
        preferences: {},
        createdAt: Date.now(),
      });

      // Step id must be consistent across template step.id AND task.stepId AND the taskId passed
      // to createExecutionTools so ctx.stepId resolves to the correct template step.
      const stepId = "s1";
      const { executionId, workspace } = seedExecution({
        roleId,
        roleName: "r-val-pass",
        stepId,
        taskId: "task-val-pass",
        steps: [{ id: stepId, prompt: "p", assertions: ["audio.duration_s > 0"] }],
      });
      mkdirSync(workspace, { recursive: true });
      createExecutionTools(roleId, "task-val-pass");

      // silence_5s.mp3 is ~5s; assertion "> 0" passes.
      const sourceFile = copyFixtureIntoWorkspace(workspace, "silence_5s.mp3");

      const publishResult = parseResult(
        await findTool("publish_artifact_file").handler({
          key: "audio-pass",
          sourcePath: sourceFile,
          mime: "audio/mpeg",
        }),
      );

      expect(publishResult.success).toBe(true);
      expect(typeof (publishResult as { artifactId: string }).artifactId).toBe("string");

      // Verify artifact row persisted
      const artifacts = listArtifactsByExecution(executionId);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].key).toBe("audio-pass");
      expect(artifacts[0].kind).toBe("file");

      // Verify blob was copied to platform storage
      const blobPath = join(
        getArtifactsDir(executionId),
        `${(publishResult as { artifactId: string }).artifactId}.bin`,
      );
      expect(existsSync(blobPath)).toBe(true);
    });
  });

  describe("Test 2: publish with failing assertion — rejection path", () => {
    it("rejects the publish when assertion fails; blob is unlinked; error is returned", async () => {
      const roleId = "r-val-fail";
      createRole({
        id: roleId,
        name: "r-val-fail",
        cagPrompt: "Test",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: `mem-${roleId}`,
        status: "active",
        preferences: {},
        createdAt: Date.now(),
      });

      // Step id must be consistent across template step.id AND task.stepId AND the taskId passed
      // to createExecutionTools so ctx.stepId resolves to the correct template step.
      const stepId = "s1";
      const { executionId, workspace } = seedExecution({
        roleId,
        roleName: "r-val-fail",
        stepId,
        taskId: "task-val-fail",
        steps: [{ id: stepId, prompt: "p", assertions: ["audio.zc_rate_per_s < 5000"] }],
      });
      mkdirSync(workspace, { recursive: true });
      createExecutionTools(roleId, "task-val-fail");

      const sourceFile = copyFixtureIntoWorkspace(workspace, "white_noise_5s.mp3");

      const publishResult = parseResult(
        await findTool("publish_artifact_file").handler({
          key: "audio-fail",
          sourcePath: sourceFile,
          mime: "audio/mpeg",
        }),
      );

      // Structured error returned
      expect((publishResult as { error: string }).error).toContain("ASSERTION_FAILED:");
      expect((publishResult as { error: string }).error).toContain("audio.zc_rate_per_s=");
      expect((publishResult as { error: string }).error).toContain("expected < 5000");

      // No artifact row created
      const artifacts = listArtifactsByExecution(executionId);
      expect(artifacts).toHaveLength(0);

      // Blob directory is empty (rejected blob was unlinked by existing catch block)
      const blobs = readdirSync(getArtifactsDir(executionId));
      expect(blobs.length).toBe(0);
    });
  });

  describe("Test 3: publish on step without assertions — unchanged behavior", () => {
    it("succeeds normally when the step has no assertions field", async () => {
      const roleId = "r-val-noassert";
      createRole({
        id: roleId,
        name: "r-val-noassert",
        cagPrompt: "Test",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: `mem-${roleId}`,
        status: "active",
        preferences: {},
        createdAt: Date.now(),
      });

      const stepId = "s1";
      const { executionId, workspace } = seedExecution({
        roleId,
        roleName: "r-val-noassert",
        stepId,
        taskId: "task-val-noassert",
        steps: [{ id: stepId, prompt: "p" }], // no assertions
      });
      mkdirSync(workspace, { recursive: true });
      createExecutionTools(roleId, "task-val-noassert");

      const sourceFile = join(workspace, "report.txt");
      writeFileSync(sourceFile, "validator test report — step has no assertions field");

      const publishResult = parseResult(
        await findTool("publish_artifact_file").handler({
          key: "report-noassert",
          sourcePath: sourceFile,
          mime: "text/plain",
        }),
      );

      expect(publishResult.success).toBe(true);
      const artifactId = (publishResult as { artifactId: string }).artifactId;
      expect(typeof artifactId).toBe("string");

      // Verify artifact persisted via side-effect (no vi.mock on validators module)
      const artifacts = listArtifactsByExecution(executionId);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].key).toBe("report-noassert");

      // Verify blob exists on disk
      const blobPath = join(getArtifactsDir(executionId), `${artifactId}.bin`);
      expect(existsSync(blobPath)).toBe(true);

      // Verify returned shape is intact
      expect((publishResult as { success: boolean }).success).toBe(true);
      expect((publishResult as { sizeBytes: number }).sizeBytes).toBeGreaterThan(0);
    });
  });
});
