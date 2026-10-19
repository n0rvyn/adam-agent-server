import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { setupTestDb, getTestDb, clearTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

const { mockCreateSdkMcpServer, mockTool } = vi.hoisted(() => {
  const mockCreateSdkMcpServer = vi.fn().mockImplementation((config: unknown) => config);
  const mockTool = vi.fn().mockImplementation((name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema: schema,
    handler,
  }));
  return { mockCreateSdkMcpServer, mockTool };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

const { createAdamTools } = await import("../../manager/adam-tools.js");
const { createTaskTemplate, getTaskTemplate } = await import("../../store/task-templates.js");
const { initializeDefaultRoles } = await import("../../store/role-presets.js");

function makeTemplate(id: string) {
  return {
    id,
    name: `tmpl-${id}`,
    trigger: { type: "manual" as const },
    steps: [{ id: "s1", prompt: "p" }],
    rolePreference: "role-test-seed",
    enabled: true,
    createdAt: Date.now(),
  };
}

describe("adam-tools delete_template + get_template_dependents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSdkMcpServer.mockClear();
    mockTool.mockClear();
    clearTestDb();
    initializeDefaultRoles();
  });

  afterAll(() => cleanup());

  function getTool(name: string) {
    createAdamTools();
    const config = mockCreateSdkMcpServer.mock.calls[0][0];
    return config.tools.find((t: { name: string }) => t.name === name);
  }

  describe("get_template_dependents", () => {
    it("returns correct counts with hasDependents=true when template has executions + tasks", async () => {
      const db = getTestDb();
      createTaskTemplate(makeTemplate("tmpl-deps-1"));
      db.prepare(
        "INSERT INTO template_executions (id, template_id, status, step_statuses, started_at) VALUES (?, ?, 'completed', '{}', ?)",
      ).run("we-1", "tmpl-deps-1", Date.now());
      db.prepare(
        "INSERT INTO tasks (id, status, prompt, config, template_id, created_at) VALUES (?, 'completed', 'p', '{}', ?, ?)",
      ).run("task-1", "tmpl-deps-1", Date.now());

      const tool = getTool("get_template_dependents");
      expect(tool).toBeDefined();
      const result = await tool.handler({ templateId: "tmpl-deps-1" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.executionCount).toBe(1);
      expect(parsed.templateExecutions).toBe(1);
      expect(parsed.taskCount).toBe(1);
      expect(parsed.hasDependents).toBe(true);
      expect(parsed.templateName).toBe("tmpl-tmpl-deps-1");
    });

    it("returns zero counts with hasDependents=false when template has no dependents", async () => {
      createTaskTemplate(makeTemplate("tmpl-deps-empty"));
      const tool = getTool("get_template_dependents");
      const result = await tool.handler({ templateId: "tmpl-deps-empty" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.executionCount).toBe(0);
      expect(parsed.taskCount).toBe(0);
      expect(parsed.hasDependents).toBe(false);
    });

    it("returns error for unknown template id", async () => {
      const tool = getTool("get_template_dependents");
      const result = await tool.handler({ templateId: "no-such-template" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.error).toContain("Template not found");
    });
  });

  describe("delete_template", () => {
    it("template_only mode: deletes template + executions, keeps tasks as orphans", async () => {
      const db = getTestDb();
      createTaskTemplate(makeTemplate("tmpl-del-only"));
      db.prepare(
        "INSERT INTO template_executions (id, template_id, status, step_statuses, started_at) VALUES (?, ?, 'completed', '{}', ?)",
      ).run("we-only", "tmpl-del-only", Date.now());
      db.prepare(
        "INSERT INTO tasks (id, status, prompt, config, template_id, created_at) VALUES (?, 'completed', 'p', '{}', ?, ?)",
      ).run("task-only", "tmpl-del-only", Date.now());

      const tool = getTool("delete_template");
      const result = await tool.handler({ templateId: "tmpl-del-only", mode: "template_only" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.mode).toBe("template_only");
      expect(parsed.deleted.tasks).toBe(0);
      expect(parsed.deleted.templateExecutions).toBe(1);
      expect(getTaskTemplate("tmpl-del-only")).toBeUndefined();
      expect(db.prepare("SELECT id FROM tasks WHERE id = ?").get("task-only")).toBeDefined();
    });

    it("with_tasks mode: full cascade including chat_messages SET NULL and manager_decisions DELETE", async () => {
      const db = getTestDb();
      createTaskTemplate(makeTemplate("tmpl-del-full"));
      db.prepare(
        "INSERT INTO tasks (id, status, prompt, config, template_id, created_at) VALUES (?, 'completed', 'p', '{}', ?, ?)",
      ).run("task-full", "tmpl-del-full", Date.now());
      db.prepare(
        "INSERT INTO role_scores (id, role_id, task_id, score_json, ema_score, created_at) VALUES (?, ?, ?, '{}', 0.5, ?)",
      ).run("rs-full", "role-x", "task-full", Date.now());
      db.prepare(
        "INSERT INTO manager_decisions (id, task_id, decision_type, created_at) VALUES (?, ?, 'dispatch', ?)",
      ).run("md-full", "task-full", Date.now());
      const now = Date.now();
      db.prepare(
        "INSERT INTO chat_sessions (id, status, source_type, title, created_at, last_active_at) VALUES (?, 'active', 'web', 't', ?, ?)",
      ).run("cs-full", now, now);
      db.prepare(
        "INSERT INTO chat_messages (id, session_id, role, content, source_type, task_id, created_at) VALUES (?, ?, 'assistant', 'hi', 'web', ?, ?)",
      ).run("cm-full", "cs-full", "task-full", Date.now());

      const tool = getTool("delete_template");
      const result = await tool.handler({ templateId: "tmpl-del-full", mode: "with_tasks" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.mode).toBe("with_tasks");
      expect(parsed.deleted.tasks).toBe(1);

      expect(getTaskTemplate("tmpl-del-full")).toBeUndefined();
      expect(db.prepare("SELECT id FROM tasks WHERE id = ?").get("task-full")).toBeUndefined();
      expect(db.prepare("SELECT id FROM role_scores WHERE id = ?").get("rs-full")).toBeUndefined();
      expect(db.prepare("SELECT id FROM manager_decisions WHERE id = ?").get("md-full")).toBeUndefined();
      const msg = db.prepare("SELECT id, task_id FROM chat_messages WHERE id = ?").get("cm-full") as { id: string; task_id: string | null };
      expect(msg).toBeDefined();
      expect(msg.task_id).toBeNull();
    });

    it("rejects missing mode with Zod validation error (DP-002 safety contract)", async () => {
      createTaskTemplate(makeTemplate("tmpl-no-mode"));
      const tool = getTool("delete_template");

      const inputSchema = tool.inputSchema as { mode: { safeParse: (v: unknown) => { success: boolean } } };
      const modeSchema = inputSchema.mode;
      const parsed = modeSchema.safeParse(undefined);
      expect(parsed.success).toBe(false);
    });

    it("returns error for unknown template id", async () => {
      const tool = getTool("delete_template");
      const result = await tool.handler({ templateId: "no-such", mode: "template_only" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("Template not found");
    });
  });
});
