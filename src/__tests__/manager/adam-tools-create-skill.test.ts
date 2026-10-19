import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Hoisted mock factories for modules with mutable state
const {
  mockGetRole,
  mockEnsureRoleWorkspace,
  mockGetRoleWorkspacePath,
} = vi.hoisted(() => {
  const mockGetRole = vi.fn();
  const mockEnsureRoleWorkspace = vi.fn();
  const mockGetRoleWorkspacePath = vi.fn();
  return { mockGetRole, mockEnsureRoleWorkspace, mockGetRoleWorkspacePath };
});

vi.mock("../../store/roles.js", () => ({
  getRole: mockGetRole,
}));

vi.mock("../../store/role-workspace.js", () => ({
  ensureRoleWorkspace: mockEnsureRoleWorkspace,
  getRoleWorkspacePath: mockGetRoleWorkspacePath,
}));

// Test harness: capture SDK tool() registrations
const mockCreateSdkMcpServer = vi.fn();
const mockTool = vi.fn((name, description, schema, handler) => ({ name, description, schema, handler }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

afterAll(() => cleanup());

describe("adam-tools create_skill preset-role guard (Task 8)", () => {
  let toolsArray: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }>;
  let tmpRoleDir: string;

  beforeEach(async () => {
    clearTestDb();
    vi.clearAllMocks();
    mockCreateSdkMcpServer.mockClear();
    mockTool.mockClear();
    mockGetRole.mockClear();
    mockEnsureRoleWorkspace.mockClear();
    mockGetRoleWorkspacePath.mockClear();

    // Create a real tmp directory for the role workspace
    tmpRoleDir = resolve(tmpdir(), `adam-test-role-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(resolve(tmpRoleDir, ".claude", "skills"), { recursive: true });

    const { createAdamTools } = await import("../../manager/adam-tools.js");
    createAdamTools();
    toolsArray = mockCreateSdkMcpServer.mock.calls[0][0].tools;
  });

  afterEach(async () => {
    // Clean up tmp dir
    try {
      await rm(tmpRoleDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  async function callCreateSkill(args: Record<string, unknown>) {
    const tool = toolsArray.find(t => t.name === "create_skill");
    expect(tool).toBeDefined();
    return tool!.handler(args) as Promise<{ content: Array<{ text: string }> }>;
  }

  describe("preset-role overwrite guard", () => {
    it("preset Role + no existing skill → success", async () => {
      const roleId = "preset-no-skill-id";
      mockGetRole.mockReturnValueOnce({
        id: roleId,
        name: "Engineer", // preset name
        cagPrompt: "",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "ms",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
      });
      mockEnsureRoleWorkspace.mockReturnValueOnce(tmpRoleDir);
      mockGetRoleWorkspacePath.mockReturnValueOnce(tmpRoleDir);

      const result = await callCreateSkill({
        roleId,
        skillName: "brand-new-skill",
        description: "A brand new skill",
        instructions: "Do the thing.",
      });

      const payload = JSON.parse(result.content[0].text);
      // Success (no existing skill to protect)
      expect(payload.ok).toBe(true);
      expect(payload.path).toBeDefined();
    });

    it("preset Role + existing skill + no overwrite → error with requiresOverwrite: true", async () => {
      const roleId = "preset-with-skill-id";
      // Pre-create an existing SKILL.md
      const skillDir = resolve(tmpRoleDir, ".claude", "skills", "existing-preset-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(resolve(skillDir, "SKILL.md"), "existing content", "utf8");

      mockGetRole.mockReturnValueOnce({
        id: roleId,
        name: "Engineer", // preset name
        cagPrompt: "",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "ms",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
      });
      mockEnsureRoleWorkspace.mockReturnValueOnce(tmpRoleDir);
      mockGetRoleWorkspacePath.mockReturnValueOnce(tmpRoleDir);

      const result = await callCreateSkill({
        roleId,
        skillName: "existing-preset-skill",
        description: "Try to overwrite",
        instructions: "Do the thing.",
      });

      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toContain("preset");
      expect(payload.error).toContain("overwrite=true");
      expect(payload.requiresOverwrite).toBe(true);
      expect(payload.existingPath).toBeDefined();
    });

    it("preset Role + existing skill + overwrite: true → success", async () => {
      const roleId = "preset-overwrite-id";
      // Pre-create an existing SKILL.md
      const skillDir = resolve(tmpRoleDir, ".claude", "skills", "overwrite-me");
      await mkdir(skillDir, { recursive: true });
      await writeFile(resolve(skillDir, "SKILL.md"), "old content", "utf8");

      mockGetRole.mockReturnValueOnce({
        id: roleId,
        name: "Engineer", // preset name
        cagPrompt: "",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "ms",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
      });
      mockEnsureRoleWorkspace.mockReturnValueOnce(tmpRoleDir);
      mockGetRoleWorkspacePath.mockReturnValueOnce(tmpRoleDir);

      const result = await callCreateSkill({
        roleId,
        skillName: "overwrite-me",
        description: "Overwriting skill",
        instructions: "New instructions.",
        overwrite: true,
      });

      const payload = JSON.parse(result.content[0].text);
      expect(payload.ok).toBe(true);
      expect(payload.path).toBeDefined();
    });

    it("non-preset Role + existing skill + no overwrite → success (silent overwrite)", async () => {
      const roleId = "custom-role-id";
      // Pre-create an existing SKILL.md under a non-preset role
      const skillDir = resolve(tmpRoleDir, ".claude", "skills", "my-custom-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(resolve(skillDir, "SKILL.md"), "old custom content", "utf8");

      mockGetRole.mockReturnValueOnce({
        id: roleId,
        name: "My Custom Role", // not a preset
        cagPrompt: "",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "ms",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
      });
      mockEnsureRoleWorkspace.mockReturnValueOnce(tmpRoleDir);
      mockGetRoleWorkspacePath.mockReturnValueOnce(tmpRoleDir);

      const result = await callCreateSkill({
        roleId,
        skillName: "my-custom-skill",
        description: "Custom skill",
        instructions: "Custom instructions.",
      });

      const payload = JSON.parse(result.content[0].text);
      expect(payload.ok).toBe(true);
      expect(payload.error).toBeUndefined();
    });

    it("user-named role shadowing preset (source=user) + existing skill → success", async () => {
      const roleId = "user-engineer-id";
      // User has a custom role named "Engineer" but with source="user"
      const skillDir = resolve(tmpRoleDir, ".claude", "skills", "shadowing-engineer");
      await mkdir(skillDir, { recursive: true });
      await writeFile(resolve(skillDir, "SKILL.md"), "user's engineer content", "utf8");

      mockGetRole.mockReturnValueOnce({
        id: roleId,
        name: "Engineer", // matches preset name
        source: "user", // but explicit user source → isPresetRole returns false
        cagPrompt: "",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: "ms",
        status: "active" as const,
        preferences: {},
        createdAt: Date.now(),
      });
      mockEnsureRoleWorkspace.mockReturnValueOnce(tmpRoleDir);
      mockGetRoleWorkspacePath.mockReturnValueOnce(tmpRoleDir);

      const result = await callCreateSkill({
        roleId,
        skillName: "shadowing-engineer",
        description: "User's engineer skill",
        instructions: "User instructions.",
      });

      const payload = JSON.parse(result.content[0].text);
      expect(payload.ok).toBe(true);
      expect(payload.error).toBeUndefined();
    });
  });
});
