/**
 * Task 11 step 4 / Task 13 — verify publish_artifact_file captures basename(sourcePath)
 * as originalFilename in the DB artifact row.
 *
 * Pattern mirrors src/__tests__/manager/execution-tools.test.ts "publishes" test.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const workspaceRoot = mkdtempSync(tmpdir() + sep + "adam-pub-orig-test-");

vi.mock("../../store/role-workspace.js", () => ({
  getRoleWorkspacePath: vi.fn(() => join(workspaceRoot, "test-role")),
  ensureRoleWorkspace: vi.fn(() => {
    mkdirSync(join(workspaceRoot, "test-role"), { recursive: true });
    return join(workspaceRoot, "test-role");
  }),
}));

vi.mock("../../server/routes/channels.js", () => ({
  getChannelManager: vi.fn(() => ({
    sendMessage: vi.fn(),
  })),
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({ redeliverExecutionTo: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ success: true, logEntryId: "mock-log" }),
  }),
}));

import { createRole } from "../../store/roles.js";
import { createTask, getTask } from "../../store/tasks.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { createTemplateExecution } from "../../store/template-executions.js";
import { getArtifact } from "../../store/artifacts.js";
import { createExecutionTools, inferMimeFromPath } from "../../manager/execution-tools.js";

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

function seedTemplateExecution() {
  const roleId = "role-pub-orig";
  createRole({
    id: roleId,
    name: "test-role",
    cagPrompt: "Test",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "mem-pub-orig",
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  });

  createTaskTemplate({
    id: "tmpl-pub-orig",
    name: "pub-orig-exec",
    trigger: { type: "manual" },
    steps: [{ id: "step-a", prompt: "x", roleId }],
    rolePreference: "test-role",
    enabled: true,
    createdAt: Date.now(),
  });
  createTemplateExecution("exec-pub-orig", "tmpl-pub-orig");
  createTask({
    id: "task-pub-orig",
    parentId: "exec-pub-orig",
    templateId: "tmpl-pub-orig",
    stepId: "step-a",
    roleId,
    status: "pending",
    prompt: "Publish artifact step",
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
    createdAt: Date.now(),
  });
  createExecutionTools(roleId, "task-pub-orig");
}

function findTool(name: string) {
  const t = registeredTools.find((tool) => tool.name === name);
  expect(t).toBeDefined();
  return t!;
}

function parseResult(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

describe("publish_artifact_file — originalFilename capture", () => {
  it("sets artifact.originalFilename = basename(sourcePath)", async () => {
    seedTemplateExecution();

    const sourceFile = join(workspaceRoot, "test-role", "podcast.md");
    writeFileSync(sourceFile, "# My Podcast Script\n\nContent here.");

    const publishTool = findTool("publish_artifact_file");
    const result = parseResult(await publishTool.handler({
      key: "podcast-script",
      sourcePath: sourceFile,
      mime: "text/markdown",
      cleanup: true,
    }));

    expect(result.success).toBe(true);

    const artifact = getArtifact("exec-pub-orig", "step-a", "podcast-script");
    expect(artifact).toBeDefined();
    expect(artifact!.originalFilename).toBe("podcast.md");
    expect(artifact!.mime).toBe("text/markdown");
    expect(artifact!.key).toBe("podcast-script");
  });

  it("basename is extracted even when sourcePath contains directory separators", async () => {
    seedTemplateExecution();

    // Simulate a file deep inside the role workspace
    const subDir = join(workspaceRoot, "test-role", "artifacts", "audio");
    mkdirSync(subDir, { recursive: true });
    const sourceFile = join(subDir, "episode-42.mp3");
    writeFileSync(sourceFile, "fake audio data");

    const publishTool = findTool("publish_artifact_file");
    const result = parseResult(await publishTool.handler({
      key: "audio-output",
      sourcePath: sourceFile,
      mime: "audio/mpeg",
      cleanup: true,
    }));

    expect(result.success).toBe(true);

    const artifact = getArtifact("exec-pub-orig", "step-a", "audio-output");
    expect(artifact).toBeDefined();
    expect(artifact!.originalFilename).toBe("episode-42.mp3");
  });

  it("originalFilename is stored even when key has no extension", async () => {
    seedTemplateExecution();

    const sourceFile = join(workspaceRoot, "test-role", "report-2025");
    writeFileSync(sourceFile, "Annual report 2025");

    const publishTool = findTool("publish_artifact_file");
    const result = parseResult(await publishTool.handler({
      key: "annual-report",
      sourcePath: sourceFile,
      mime: "application/pdf",
      cleanup: true,
    }));

    expect(result.success).toBe(true);

    const artifact = getArtifact("exec-pub-orig", "step-a", "annual-report");
    expect(artifact).toBeDefined();
    // The key has no extension; the originalFilename carries the real filename
    expect(artifact!.originalFilename).toBe("report-2025");
  });
});

// publish_artifact_file infers mime from the file extension when the caller omits it, so a binary
// publish (audio/image) that ships with no mime still carries a correct one — fixing the jay-audio
// NULL-mime case where the contract verifier judged mp3 bytes as text and spuriously Layer-B-failed.
describe("inferMimeFromPath", () => {
  it("audio extensions → audio mimes (the jay-audio fix: .mp3 → audio/mpeg)", () => {
    expect(inferMimeFromPath("/tmp/work/broadcast-audio.mp3")).toBe("audio/mpeg");
    expect(inferMimeFromPath("a.wav")).toBe("audio/wav");
    expect(inferMimeFromPath("a.m4a")).toBe("audio/mp4");
  });

  it("image extensions → image mimes (picasso path)", () => {
    expect(inferMimeFromPath("art_01.png")).toBe("image/png");
    expect(inferMimeFromPath("photo.JPG")).toBe("image/jpeg"); // case-insensitive
  });

  it("unknown / no extension → undefined (caller mime stays absent, no false typing)", () => {
    expect(inferMimeFromPath("/tmp/file.xyz")).toBeUndefined();
    expect(inferMimeFromPath("noext")).toBeUndefined();
  });
});
