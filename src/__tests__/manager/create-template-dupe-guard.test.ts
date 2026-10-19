/**
 * Task 5: Duplicate-template hygiene — create-time guard
 *
 * Verifies that create_template returns a warning (not a hard block) when an enabled
 * template with the same name already exists, and that both rows are present after the call.
 * Also verifies that a unique name produces no warning field.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
afterAll(() => cleanup());

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

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

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
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

const MINIMAL_STEP = {
  id: "step-1",
  prompt: "Do a thing",
  autoSelectRole: true,
  requirements: { tools: ["Read"] },
};

describe("create_template duplicate-name guard", () => {
  beforeEach(() => {
    clearTestDb();
  });

  it("returns a warning when an enabled template with the same name already exists, and both rows persist", async () => {
    const handlers = buildToolHandlers();
    const createHandler = handlers.get("create_template");
    if (!createHandler) throw new Error("create_template handler not found");

    const name = `Dupe Template ${uuidv4()}`;

    // First create — no dupe yet
    const first = await createHandler({
      name,
      steps: [MINIMAL_STEP],
      triggerType: "manual",
    }) as { content: Array<{ text: string }> };
    const firstParsed = JSON.parse(first.content[0].text) as { templateId: string; warning?: string };
    expect(firstParsed.warning).toBeUndefined();
    const firstId = firstParsed.templateId;

    // Second create with same name — should warn but succeed
    const second = await createHandler({
      name,
      steps: [MINIMAL_STEP],
      triggerType: "manual",
    }) as { content: Array<{ text: string }> };
    const secondParsed = JSON.parse(second.content[0].text) as { templateId: string; warning?: string };
    expect(secondParsed.warning).toBeDefined();
    expect(secondParsed.warning).toContain(name);
    expect(secondParsed.warning).toContain(firstId);
    const secondId = secondParsed.templateId;

    // Both rows must exist
    const db = getTestDb();
    const rows = db.prepare("SELECT id FROM task_templates WHERE name = ?").all(name) as { id: string }[];
    expect(rows.map((r) => r.id)).toContain(firstId);
    expect(rows.map((r) => r.id)).toContain(secondId);
    expect(rows.length).toBe(2);
  });

  it("returns no warning field for a unique template name", async () => {
    const handlers = buildToolHandlers();
    const createHandler = handlers.get("create_template");
    if (!createHandler) throw new Error("create_template handler not found");

    const result = await createHandler({
      name: `Unique Template ${uuidv4()}`,
      steps: [MINIMAL_STEP],
      triggerType: "manual",
    }) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text) as { templateId: string; warning?: string };
    expect(parsed.warning).toBeUndefined();
    expect(parsed.templateId).toBeDefined();
  });
});
