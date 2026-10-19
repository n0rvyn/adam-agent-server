import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
const testRuntimeRoot = mkdtempSync(tmpdir() + sep + "adam-template-executor-");

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

vi.mock("../../store/role-workspace.js", () => ({
  ensureRoleWorkspace: vi.fn((role: { name: string }) => `/tmp/adam-test-roles/${role.name}`),
  getRoleWorkspacePath: vi.fn((roleName: string) => `/tmp/adam-test-roles/${roleName}`),
  writeRoleCLAUDEmd: vi.fn(),
  syncRoleSettings: vi.fn(),
}));

vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn(() => []),
}));

import { TemplateExecutor } from "../../scheduler/template-executor.js";
import { getTask, updateTask } from "../../store/tasks.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { getTemplateExecution, updateTemplateExecution } from "../../store/template-executions.js";
import { createGoal, getGoal, listGoals } from "../../store/goals.js";
import { createRole } from "../../store/roles.js";
import { serverBus } from "../../server/events/server-bus.js";
import type { Role, TaskTemplate } from "../../shared/types.js";

const DEFAULT_ROLE_ID = "role-test-default";

function seedRole(id: string, name?: string): void {
  const role: Role = {
    id,
    name: name ?? id,
    cagPrompt: "test role",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `ms-${id}`,
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  };
  createRole(role);
}

afterAll(() => {
  delete process.env.ADAM_TEST_DIR;
  rmSync(testRuntimeRoot, { recursive: true, force: true });
  cleanup();
});

describe("TemplateExecutor", () => {
  let executor: TemplateExecutor;

  beforeEach(() => {
    clearTestDb();
    process.env.ADAM_TEST_DIR = testRuntimeRoot;
    rmSync(join(testRuntimeRoot, "template-executions"), { recursive: true, force: true });
    executor = new TemplateExecutor({ maxRetries: 1, baseDelayMs: 10 });
    // Seed the default role plus every explicit role id referenced by tests below
    seedRole(DEFAULT_ROLE_ID, "default");
    seedRole("role-abc123", "Abc");
    seedRole("role-override", "Override");
    seedRole("role-default", "Default");
  });

  let templateCounter = 0;
  function makeTemplate(steps: TaskTemplate["steps"], overrides?: Partial<TaskTemplate>): TaskTemplate {
    templateCounter++;
    // Every step needs a roleId (or autoSelectRole+requirements) to pass admission.
    // If the template override does not provide rolePreference and the step itself
    // has no roleId, fall back to DEFAULT_ROLE_ID so admission succeeds in tests.
    const hasRolePreference = overrides?.rolePreference !== undefined;
    const withRoles = steps.map((s) =>
      s.roleId || hasRolePreference ? s : { ...s, roleId: DEFAULT_ROLE_ID },
    );
    const template: TaskTemplate = {
      id: `tmpl-${templateCounter}`,
      name: "test-template",
      trigger: { type: "manual" },
      steps: withRoles,
      enabled: true,
      createdAt: Date.now(),
      ...overrides,
    };
    // Persist to DB so template_executions FK is satisfied
    createTaskTemplate(template);
    return template;
  }

  /**
   * Background poller: watches for pending tasks under a parentId
   * and marks them completed immediately. Emits task_status_change
   * event for the new event-based TemplateExecutor.
   */
  function autoCompleter(parentId: string, resultFn?: (taskId: string) => string) {
    let running = true;
    const interval = setInterval(() => {
      if (!running) return;
      try {
        const db = getTestDb();
        const rows = db.prepare("SELECT id FROM tasks WHERE parent_id = ? AND status = 'pending'").all(parentId) as { id: string }[];
        for (const row of rows) {
          const result = resultFn ? resultFn(row.id) : "done";
          updateTask(row.id, { status: "completed", result, completedAt: Date.now() });
          serverBus.emit({
            type: "task_status_change",
            taskId: row.id,
            oldStatus: "pending",
            newStatus: "completed",
          });
        }
      } catch { /* DB may be closed during teardown */ }
    }, 50);

    return () => {
      running = false;
      clearInterval(interval);
    };
  }

  /**
   * Background poller: marks pending tasks as failed.
   */
  function autoFailer(parentId: string) {
    let running = true;
    const interval = setInterval(() => {
      if (!running) return;
      try {
        const db = getTestDb();
        const rows = db.prepare("SELECT id FROM tasks WHERE parent_id = ? AND status = 'pending'").all(parentId) as { id: string }[];
        for (const row of rows) {
          updateTask(row.id, { status: "failed", error: "simulated failure", completedAt: Date.now() });
          serverBus.emit({
            type: "task_status_change",
            taskId: row.id,
            oldStatus: "pending",
            newStatus: "failed",
          });
        }
      } catch { /* DB may be closed during teardown */ }
    }, 50);

    return () => {
      running = false;
      clearInterval(interval);
    };
  }

  describe("execute", () => {
    it("creates tasks for each step", async () => {
      const template = makeTemplate([
        { id: "step-1", prompt: "Do step 1" },
        { id: "step-2", prompt: "Do step 2" },
      ]);

      const stopCompleter = autoCompleter("exec-1");

      await executor.execute(template, "exec-1");

      stopCompleter();

      const db = getTestDb();
      const rows = db.prepare("SELECT id, step_id FROM tasks WHERE parent_id = ? ORDER BY created_at ASC").all("exec-1") as Array<{ id: string; step_id: string | null }>;
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.step_id)).toEqual(["step-1", "step-2"]);
      expect(existsSync(join(testRuntimeRoot, "template-executions", "exec-1", "artifacts"))).toBe(true);
    });

    it("resolves variables from previous step results", async () => {
      const template = makeTemplate([
        { id: "step-a", prompt: "Generate data" },
        { id: "step-b", prompt: "Process {{step-a.result}}", dependsOn: ["step-a"] },
      ]);

      const stopCompleter = autoCompleter("exec-var", () => "generated-data");

      await executor.execute(template, "exec-var");

      stopCompleter();

      const db = getTestDb();
      const tasks = db.prepare("SELECT prompt FROM tasks WHERE parent_id = ? ORDER BY created_at ASC").all("exec-var") as { prompt: string }[];

      expect(tasks).toHaveLength(2);
      // Second task should have the resolved variable
      expect(tasks[1].prompt).toContain("generated-data");
    });

    it("stops template execution on step failure after retries", async () => {
      const template = makeTemplate([
        { id: "step-fail", prompt: "This will fail" },
        { id: "step-after", prompt: "Should not run", dependsOn: ["step-fail"] },
      ]);

      const stopFailer = autoFailer("exec-fail");

      await executor.execute(template, "exec-fail");

      stopFailer();

      const db = getTestDb();
      const allTasks = db.prepare("SELECT prompt FROM tasks WHERE parent_id = ?").all("exec-fail") as { prompt: string }[];

      // Only the failing step should have been created (possibly multiple times due to retry)
      // The second step "Should not run" should NOT be present
      // Note: prompt is now wrapped via assemblePrompt, so we check with .includes
      const afterStepTasks = allTasks.filter(t => t.prompt.includes("Should not run"));
      expect(afterStepTasks).toHaveLength(0);
    }, 20000);
  });

  describe("sortSteps (via execute)", () => {
    it("orders steps respecting dependencies", async () => {
      const template = makeTemplate([
        { id: "c", prompt: "C", dependsOn: ["b"] },
        { id: "a", prompt: "A" },
        { id: "b", prompt: "B", dependsOn: ["a"] },
      ]);

      const stopCompleter = autoCompleter("exec-sort");

      await executor.execute(template, "exec-sort");

      stopCompleter();

      const db = getTestDb();
      const tasks = db.prepare("SELECT prompt FROM tasks WHERE parent_id = ? ORDER BY created_at ASC").all("exec-sort") as { prompt: string }[];

      // Topological order: A -> B -> C
      // Note: prompt is now wrapped via assemblePrompt — check with .includes
      expect(tasks[0].prompt).toContain("A");
      expect(tasks[1].prompt).toContain("B");
      expect(tasks[2].prompt).toContain("C");
    });
  });

  describe("template field propagation", () => {
    it("propagates rolePreference but NOT deliverTo/reportTo to step tasks (D-007: aggregated delivery)", async () => {
      const template = makeTemplate(
        [{ id: "step-1", prompt: "Do something" }],
        {
          rolePreference: "role-abc123",
          deliverTo: [{ type: "channel", channelId: "ch-1", chatId: "chat-1" }],
          reportTo: [{ type: "channel", channelId: "ch-2", chatId: "chat-2" }],
        },
      );

      const stopCompleter = autoCompleter("exec-propagate");

      await executor.execute(template, "exec-propagate");

      stopCompleter();

      const db = getTestDb();
      const rows = db.prepare("SELECT role_id, deliver_to, report_to FROM tasks WHERE parent_id = ?").all("exec-propagate") as { role_id: string | null; deliver_to: string | null; report_to: string | null }[];

      expect(rows).toHaveLength(1);
      expect(rows[0].role_id).toBe("role-abc123");
      // D-007: deliverTo/reportTo NOT propagated to step tasks — TemplateExecution-level delivery handles this
      expect(rows[0].deliver_to).toBeNull();
      expect(rows[0].report_to).toBeNull();
    });

    it("leaves deliverTo/reportTo null when template has no deliverTo/reportTo (D-007: aggregated delivery)", async () => {
      // Admission requires a role; use step-level roleId to make this explicit
      // (template has no rolePreference).
      const template = makeTemplate([
        { id: "step-1", prompt: "Do something", roleId: DEFAULT_ROLE_ID },
      ]);

      const stopCompleter = autoCompleter("exec-no-fields");

      await executor.execute(template, "exec-no-fields");

      stopCompleter();

      const db = getTestDb();
      const rows = db.prepare("SELECT role_id, deliver_to, report_to FROM tasks WHERE parent_id = ?").all("exec-no-fields") as { role_id: string | null; deliver_to: string | null; report_to: string | null }[];

      expect(rows).toHaveLength(1);
      expect(rows[0].role_id).toBe(DEFAULT_ROLE_ID);
      expect(rows[0].deliver_to).toBeNull();
      expect(rows[0].report_to).toBeNull();
    });
  });

  describe("admission failure (D-011)", () => {
    it("stops step and records admission error when requirements exceed role capabilities", async () => {
      // Seed a role with only Read — step demands Bash, admission must reject.
      const restrictedRoleId = "role-restricted-template-execution";
      createRole({
        id: restrictedRoleId,
        name: "restricted",
        cagPrompt: "test",
        learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
        memoryStreamId: `ms-${restrictedRoleId}`,
        status: "active",
        preferences: {},
        createdAt: Date.now(),
        allowedTools: ["Read"],
      });

      const template = makeTemplate([
        {
          id: "step-admission-fail",
          prompt: "run a command",
          roleId: restrictedRoleId,
          requirements: { tools: ["Bash"] },
        },
        { id: "step-dependent", prompt: "Follow up", dependsOn: ["step-admission-fail"] },
      ]);

      await executor.execute(template, "exec-admission-fail");

      // No task should have been created for the admission-failed step
      const db = getTestDb();
      const rows = db.prepare(
        "SELECT step_id, status FROM tasks WHERE parent_id = ?",
      ).all("exec-admission-fail") as Array<{ step_id: string | null; status: string }>;
      const step1Rows = rows.filter((r) => r.step_id === "step-admission-fail");
      expect(step1Rows).toHaveLength(0);

      // TemplateExecution record reflects step failure with admission code
      const execution = getTemplateExecution("exec-admission-fail");
      expect(execution).toBeDefined();
      expect(execution!.stepStatuses["step-admission-fail"].status).toBe("failed");
      expect(execution!.stepStatuses["step-admission-fail"].error).toContain("Bash");
    });
  });

  describe("per-step roleId (D-002)", () => {
    it("uses step-level roleId overriding template rolePreference", async () => {
      const template = makeTemplate(
        [
          { id: "step-1", prompt: "Do A", roleId: "role-override" },
          { id: "step-2", prompt: "Do B", dependsOn: ["step-1"] }, // Should fall back to template
        ],
        { rolePreference: "role-default" },
      );

      const stopCompleter = autoCompleter("exec-role-override");

      await executor.execute(template, "exec-role-override");

      stopCompleter();

      const db = getTestDb();
      const rows = db.prepare("SELECT role_id FROM tasks WHERE parent_id = ? ORDER BY created_at ASC").all("exec-role-override") as { role_id: string | null }[];

      expect(rows).toHaveLength(2);
      expect(rows[0].role_id).toBe("role-override");
      expect(rows[1].role_id).toBe("role-default");
    });

    it("resolves rolePreference by name when no role exists with that id (PE-001 regression)", async () => {
      // Yaml-shipped templates use rolePreference: "<role-name>" (e.g. "达芬奇", "周杰伦")
      // — a name, not a uuid id. Pre-fix, getRole(name) returned undefined and admission
      // failed with "Role not found". The fix: getRole(id) ?? getRoleByName(name).
      seedRole("role-name-fallback-id", "TheNamedRole");
      const template = makeTemplate(
        [
          { id: "step-name-only", prompt: "Do A" },
        ],
        { rolePreference: "TheNamedRole" }, // pass NAME, not id
      );

      const stopCompleter = autoCompleter("exec-name-fallback");

      await executor.execute(template, "exec-name-fallback");

      stopCompleter();

      const db = getTestDb();
      const rows = db.prepare("SELECT role_id FROM tasks WHERE parent_id = ? ORDER BY created_at ASC").all("exec-name-fallback") as { role_id: string | null }[];

      expect(rows).toHaveLength(1);
      // Admission must receive the canonical id, not the name
      expect(rows[0].role_id).toBe("role-name-fallback-id");
    });
  });

  describe("continueOnError + skip_dependents (D-006)", () => {
    it("continues executing independent steps when continueOnError=true", async () => {
      // Steps: A (fails), B (depends on A, should skip), C (independent, should run)
      const template = makeTemplate(
        [
          { id: "a", prompt: "Fail" },
          { id: "b", prompt: "Depends on A", dependsOn: ["a"] },
          { id: "c", prompt: "Independent" },
        ],
        { config: { continueOnError: true } },
      );

      // Auto-fail step A, auto-complete step C
      // Note: prompt is now wrapped, so we identify step A by step id in the DB
      let failedA = false;
      const stop = (() => {
        let running = true;
        const interval = setInterval(() => {
          if (!running) return;
          try {
            const db = getTestDb();
            const rows = db.prepare("SELECT id, step_id FROM tasks WHERE parent_id = ? AND status = 'pending'").all("exec-continue") as { id: string; step_id: string }[];
            for (const row of rows) {
              if (row.step_id === "a" && !failedA) {
                failedA = true;
                updateTask(row.id, { status: "failed", error: "boom", completedAt: Date.now() });
                serverBus.emit({ type: "task_status_change", taskId: row.id, oldStatus: "pending", newStatus: "failed" });
              } else if (row.step_id !== "a") {
                updateTask(row.id, { status: "completed", result: "ok", completedAt: Date.now() });
                serverBus.emit({ type: "task_status_change", taskId: row.id, oldStatus: "pending", newStatus: "completed" });
              }
            }
          } catch { /* DB may be closed */ }
        }, 50);
        return () => { running = false; clearInterval(interval); };
      })();

      const result = await executor.execute(template, "exec-continue");

      stop();

      expect(result.status).toBe("partial");
      // Step B should be skipped (depends on failed A)
      const stepB = result.stepResults.get("b");
      expect(stepB?.status).toBe("skipped");
      // Step C should have completed
      const stepC = result.stepResults.get("c");
      expect(stepC?.status).toBe("completed");
    });
  });

  describe("resolveVariables", () => {
    it("replaces {{stepId.result}} with step result", async () => {
      const template = makeTemplate([
        { id: "data", prompt: "Get data" },
        { id: "process", prompt: "Use {{data.result}} here", dependsOn: ["data"] },
      ]);

      const stopCompleter = autoCompleter("exec-resolve", () => "RESOLVED_VALUE");

      await executor.execute(template, "exec-resolve");

      stopCompleter();

      const db = getTestDb();
      const tasks = db.prepare("SELECT prompt FROM tasks WHERE parent_id = ? ORDER BY created_at ASC").all("exec-resolve") as { prompt: string }[];

      // Prompt is now wrapped via assemblePrompt; check that the resolved value is present
      expect(tasks[1].prompt).toContain("RESOLVED_VALUE");
    });

    it("falls back for missing step result", async () => {
      const template = makeTemplate([
        { id: "only", prompt: "Check {{missing.result}} value" },
      ]);

      const stopCompleter = autoCompleter("exec-missing");

      await executor.execute(template, "exec-missing");

      stopCompleter();

      const db = getTestDb();
      const tasks = db.prepare("SELECT prompt FROM tasks WHERE parent_id = ?").all("exec-missing") as { prompt: string }[];

      // Should contain fallback text since "missing" step never ran
      expect(tasks[0].prompt).toContain("[no result from missing]");
    });
  });

  describe("parallel layers (D-003)", () => {
    it("dispatches independent steps in parallel (same layer)", async () => {
      const template = makeTemplate([
        { id: "a", prompt: "Do A" },
        { id: "b", prompt: "Do B" },
        { id: "c", prompt: "Do C" },
      ]);

      const stopCompleter = autoCompleter("exec-parallel");
      const result = await executor.execute(template, "exec-parallel");
      stopCompleter();

      expect(result.status).toBe("completed");
      expect(result.stepResults.size).toBe(3);

      // All 3 should be created with very close timestamps (same layer dispatch)
      const db = getTestDb();
      const tasks = db.prepare("SELECT created_at FROM tasks WHERE parent_id = ? ORDER BY created_at ASC").all("exec-parallel") as { created_at: number }[];
      expect(tasks).toHaveLength(3);
      // Parallel: created_at difference should be < 100ms (vs sequential which would be seconds apart)
      const spread = tasks[tasks.length - 1]!.created_at - tasks[0]!.created_at;
      expect(spread).toBeLessThan(100);
    });

    it("handles diamond DAG: A -> (B,C) -> D", async () => {
      const template = makeTemplate([
        { id: "a", prompt: "root" },
        { id: "b", prompt: "left {{a.result}}", dependsOn: ["a"] },
        { id: "c", prompt: "right {{a.result}}", dependsOn: ["a"] },
        { id: "d", prompt: "join {{b.result}} {{c.result}}", dependsOn: ["b", "c"] },
      ]);

      const stopCompleter = autoCompleter("exec-diamond", (taskId) => `result-${taskId.slice(0, 4)}`);
      const result = await executor.execute(template, "exec-diamond");
      stopCompleter();

      expect(result.status).toBe("completed");
      expect(result.stepResults.size).toBe(4);

      // Verify B and C have close creation times (same layer)
      const db = getTestDb();
      const tasks = db.prepare("SELECT prompt, created_at FROM tasks WHERE parent_id = ? ORDER BY created_at ASC").all("exec-diamond") as { prompt: string; created_at: number }[];
      // A is first, B and C are in same layer (close timestamps), D is last
      // Note: prompt is now wrapped via assemblePrompt, check with .includes
      expect(tasks[0]!.prompt).toContain("root");
      const bcTasks = tasks.filter(t => t.prompt.includes("left") || t.prompt.includes("right"));
      expect(bcTasks).toHaveLength(2);
      const bcSpread = Math.abs(bcTasks[1]!.created_at - bcTasks[0]!.created_at);
      expect(bcSpread).toBeLessThan(100);
    });
  });

  describe("per-step config (D-S01)", () => {
    it("merges step-level timeout and maxTurns overrides", async () => {
      const template = makeTemplate(
        [
          { id: "fast", prompt: "Quick task", config: { timeout: 60, maxTurns: 5 } },
          { id: "slow", prompt: "Long task", dependsOn: ["fast"] },
        ],
        { config: { timeout: 300 } },
      );

      const stopCompleter = autoCompleter("exec-config");
      await executor.execute(template, "exec-config");
      stopCompleter();

      const db = getTestDb();
      const tasks = db.prepare("SELECT config FROM tasks WHERE parent_id = ? ORDER BY created_at ASC").all("exec-config") as { config: string }[];
      const fastConfig = JSON.parse(tasks[0]!.config);
      const slowConfig = JSON.parse(tasks[1]!.config);

      expect(fastConfig.timeout).toBe(60);
      expect(fastConfig.maxTurns).toBe(5);
      expect(slowConfig.timeout).toBe(300);
    });

    it("does not create a retry while the active attempt has recent step log activity", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(2_000_000_000);
      try {
        const template = makeTemplate([
          { id: "slow", prompt: "Slow task", config: { timeout: 1 } },
        ]);

        const resultPromise = executor.execute(template, "exec-active-attempt");
        await Promise.resolve();

        const db = getTestDb();
        const task = db.prepare("SELECT id FROM tasks WHERE parent_id = ?").get("exec-active-attempt") as { id: string };

        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(4800);
        db.prepare(`
          INSERT INTO step_logs (id, task_id, "index", type, content, timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run("log-active-attempt", task.id, 0, "reasoning", "still producing output", Date.now());
        await vi.advanceTimersByTimeAsync(200);

        const runningRows = db.prepare("SELECT id FROM tasks WHERE parent_id = ?").all("exec-active-attempt") as { id: string }[];
        expect(runningRows).toHaveLength(1);
        expect(getTask(task.id)?.status).toBe("pending");

        updateTask(task.id, { status: "completed", result: "done", completedAt: Date.now() });
        serverBus.emit({ type: "task_status_change", taskId: task.id, oldStatus: "pending", newStatus: "completed" });

        const result = await resultPromise;
        expect(result.status).toBe("completed");
        const finalRows = db.prepare("SELECT id FROM tasks WHERE parent_id = ?").all("exec-active-attempt") as { id: string }[];
        expect(finalRows).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("template_executions record (D-005)", () => {
    it("expands goalIds into TemplateExecution steps and applies Goal review", async () => {
      seedRole("role-goal", "Goal Role");
      createGoal({
        id: "goal-template-1",
        name: "Publish report",
        description: "Publish the report",
        roleId: "role-goal",
        metricType: "completion",
        targetValue: 1,
        currentValue: 0,
        deadline: Date.now() + 86_400_000,
        budgetUsd: 5,
        status: "active",
        createdAt: Date.now(),
      });
      const template = makeTemplate(
        [{ id: "write", prompt: "Write the report", roleId: "role-goal" }],
        { goalIds: ["goal-template-1"] },
      );

      const stopCompleter = autoCompleter("exec-goal-template", (taskId) => {
        const task = getTask(taskId);
        if (task?.stepId === "goal-1-review") {
          return '{"goalAchieved":true,"currentValue":1,"status":"completed","reason":"report published"}';
        }
        return `result-${task?.stepId ?? taskId}`;
      });
      const result = await executor.execute(template, "exec-goal-template");
      stopCompleter();

      expect(result.status).toBe("completed");

      const db = getTestDb();
      const tasks = db.prepare("SELECT parent_id, template_id, step_id FROM tasks WHERE parent_id = ? ORDER BY created_at ASC").all("exec-goal-template") as Array<{
        parent_id: string;
        template_id: string;
        step_id: string | null;
      }>;
      expect(tasks.map((task) => task.step_id)).toEqual(["goal-1-decompose", "write", "goal-1-review"]);
      expect(tasks.every((task) => task.parent_id === "exec-goal-template")).toBe(true);
      expect(tasks.every((task) => task.template_id === template.id)).toBe(true);

      const goal = getGoal("goal-template-1");
      expect(goal?.status).toBe("completed");
      expect(goal?.currentValue).toBe(1);
      expect(listGoals()).toHaveLength(1);
    });

    it("leaves Goal unchanged when review output is malformed", async () => {
      seedRole("role-goal", "Goal Role");
      createGoal({
        id: "goal-template-malformed",
        name: "Publish report",
        roleId: "role-goal",
        metricType: "completion",
        targetValue: 1,
        currentValue: 0,
        deadline: Date.now() + 86_400_000,
        budgetUsd: 5,
        status: "active",
        createdAt: Date.now(),
      });
      const template = makeTemplate(
        [{ id: "write", prompt: "Write the report", roleId: "role-goal" }],
        { goalIds: ["goal-template-malformed"] },
      );

      const stopCompleter = autoCompleter("exec-goal-malformed", (taskId) => {
        const task = getTask(taskId);
        return task?.stepId === "goal-1-review" ? "not json" : "done";
      });
      await executor.execute(template, "exec-goal-malformed");
      stopCompleter();

      const goal = getGoal("goal-template-malformed");
      expect(goal?.status).toBe("active");
      expect(goal?.currentValue).toBe(0);
      expect(listGoals()).toHaveLength(1);
    });

    it("creates record at start and updates at completion", async () => {
      const template = makeTemplate([{ id: "only", prompt: "Single step" }]);

      const stopCompleter = autoCompleter("exec-record");
      const result = await executor.execute(template, "exec-record");
      stopCompleter();

      const db = getTestDb();
      const row = db.prepare("SELECT * FROM template_executions WHERE id = ?").get("exec-record") as {
        id: string; status: string; step_statuses: string; started_at: number; completed_at: number | null;
      } | undefined;

      expect(row).toBeDefined();
      expect(row!.id).toBe("exec-record");
      expect(row!.status).toBe("completed");
      expect(row!.completed_at).toBeGreaterThan(0);

      const stepStatuses = JSON.parse(row!.step_statuses);
      expect(stepStatuses.only).toBeDefined();
      expect(stepStatuses.only.status).toBe("completed");
    });

    it("sets status to 'partial' when continueOnError with failures", async () => {
      const template = makeTemplate(
        [
          { id: "fail", prompt: "Will fail" },
          { id: "pass", prompt: "Will pass" },
        ],
        { config: { continueOnError: true } },
      );

      let failDone = false;
      const stop = (() => {
        let running = true;
        const interval = setInterval(() => {
          if (!running) return;
          try {
            const db = getTestDb();
            // Identify steps by step_id (prompt is now wrapped via assemblePrompt)
            const rows = db.prepare("SELECT id, step_id FROM tasks WHERE parent_id = ? AND status = 'pending'").all("exec-partial") as { id: string; step_id: string }[];
            for (const row of rows) {
              if (row.step_id === "fail" && !failDone) {
                failDone = true;
                updateTask(row.id, { status: "failed", error: "boom", completedAt: Date.now() });
                serverBus.emit({ type: "task_status_change", taskId: row.id, oldStatus: "pending", newStatus: "failed" });
              } else if (row.step_id !== "fail") {
                updateTask(row.id, { status: "completed", result: "ok", completedAt: Date.now() });
                serverBus.emit({ type: "task_status_change", taskId: row.id, oldStatus: "pending", newStatus: "completed" });
              }
            }
          } catch { /* DB may be closed */ }
        }, 50);
        return () => { running = false; clearInterval(interval); };
      })();

      const result = await executor.execute(template, "exec-partial");
      stop();

      expect(result.status).toBe("partial");

      const db = getTestDb();
      const row = db.prepare("SELECT status FROM template_executions WHERE id = ?").get("exec-partial") as { status: string } | undefined;
      expect(row!.status).toBe("partial");
    });

    it("preserves cancelled status when template execution is cancelled during execution", async () => {
      const template = makeTemplate([{ id: "only", prompt: "Long running step" }]);

      const stop = (() => {
        let running = true;
        const interval = setInterval(() => {
          if (!running) return;
          try {
            const db = getTestDb();
            const rows = db.prepare("SELECT id FROM tasks WHERE parent_id = ? AND status = 'pending'").all("exec-cancelled") as { id: string }[];
            for (const row of rows) {
              updateTask(row.id, { status: "cancelled", completedAt: Date.now(), error: "TemplateExecution cancelled" });
              updateTemplateExecution("exec-cancelled", {
                status: "cancelled",
                stepStatuses: {
                  only: {
                    taskId: row.id,
                    status: "cancelled",
                    error: "TemplateExecution cancelled",
                  },
                },
                completedAt: Date.now(),
              });
              serverBus.emit({ type: "task_status_change", taskId: row.id, oldStatus: "pending", newStatus: "cancelled" });
            }
          } catch { /* DB may be closed during teardown */ }
        }, 50);
        return () => { running = false; clearInterval(interval); };
      })();

      const result = await executor.execute(template, "exec-cancelled");
      stop();

      expect(result.status).toBe("cancelled");
      expect(getTemplateExecution("exec-cancelled")?.status).toBe("cancelled");
      expect(getTemplateExecution("exec-cancelled")?.stepStatuses.only?.status).toBe("cancelled");
    });
  });

  /**
   * Background poller: marks pending tasks as blocked.
   */
  function autoBlocker(parentId: string) {
    let running = true;
    const interval = setInterval(() => {
      if (!running) return;
      try {
        const db = getTestDb();
        const rows = db.prepare("SELECT id FROM tasks WHERE parent_id = ? AND status = 'pending'").all(parentId) as { id: string }[];
        for (const row of rows) {
          updateTask(row.id, {
            status: "blocked",
            blockReason: { reason: "missing_credential", missingPrereqs: ["MINIMAX_API_KEY"], resumeHint: "Set MINIMAX_API_KEY in role env" },
            completedAt: Date.now(),
          });
          serverBus.emit({
            type: "task_status_change",
            taskId: row.id,
            oldStatus: "pending",
            newStatus: "blocked",
          });
        }
      } catch { /* DB may be closed during teardown */ }
    }, 50);

    return () => {
      running = false;
      clearInterval(interval);
    };
  }

  describe("blocked step handling (T20)", () => {
    it("finalizes template execution without hanging when a step task ends as blocked", async () => {
      // T20: dispatch a template execution with one step whose task ends as 'blocked';
      // assert the template execution finalizes (does not hang) and the step is treated
      // as failed for template execution aggregation.
      const template = makeTemplate([
        { id: "step-blocked", prompt: "Do something that will be blocked" },
        { id: "step-after", prompt: "Should not run", dependsOn: ["step-blocked"] },
      ]);

      const stopBlocker = autoBlocker("exec-blocked");

      // Use a short timeout to verify the template execution does NOT hang.
      // If waitForTaskCompletion did not resolve 'blocked', this would time out at 600s
      // but the test harness timeout (20000ms) would fire first.
      const result = await Promise.race([
        executor.execute(template, "exec-blocked"),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000)),
      ]);

      stopBlocker();

      expect(result).not.toBe("timeout");

      const templateExecutionResult = result as Awaited<ReturnType<typeof executor.execute>>;

      // TemplateExecution must finalize (not hang)
      expect(templateExecutionResult.status).toBe("failed");

      // Blocked step must appear in stepResults as failed
      const blockedStep = templateExecutionResult.stepResults.get("step-blocked");
      expect(blockedStep).toBeDefined();
      expect(blockedStep!.status).toBe("failed");

      // step-after was never dispatched (template execution aborted on blocked step before reaching it).
      // Verify via the template_executions DB record which tracks all steps by name.
      const db = getTestDb();
      const execRow = db.prepare("SELECT status, step_statuses FROM template_executions WHERE id = ?").get("exec-blocked") as { status: string; step_statuses: string } | undefined;
      expect(execRow).toBeDefined();
      expect(execRow!.status).toBe("failed");
      const stepStatuses = JSON.parse(execRow!.step_statuses) as Record<string, { status: string }>;
      expect(stepStatuses["step-blocked"]).toBeDefined();
      expect(stepStatuses["step-blocked"].status).toBe("failed");
    });
  });

  describe("retry creates new task (G-05 fix)", () => {
    it("creates multiple tasks when step fails and retries", async () => {
      // Use a separate executor with 3 retries and fast backoff for this test
      const retryExecutor = new TemplateExecutor({ maxRetries: 3, baseDelayMs: 50 });
      const template = makeTemplate([
        { id: "flaky", prompt: "Flaky step" },
      ]);

      // Fail first 2 attempts, succeed on 3rd
      let attempts = 0;
      const stop = (() => {
        let running = true;
        const interval = setInterval(() => {
          if (!running) return;
          try {
            const db = getTestDb();
            const rows = db.prepare("SELECT id FROM tasks WHERE parent_id = ? AND status = 'pending'").all("exec-retry") as { id: string }[];
            for (const row of rows) {
              attempts++;
              if (attempts <= 2) {
                updateTask(row.id, { status: "failed", error: `fail-${attempts}`, completedAt: Date.now() });
                serverBus.emit({ type: "task_status_change", taskId: row.id, oldStatus: "pending", newStatus: "failed" });
              } else {
                updateTask(row.id, { status: "completed", result: "success", completedAt: Date.now() });
                serverBus.emit({ type: "task_status_change", taskId: row.id, oldStatus: "pending", newStatus: "completed" });
              }
            }
          } catch { /* DB may be closed */ }
        }, 50);
        return () => { running = false; clearInterval(interval); };
      })();

      const result = await retryExecutor.execute(template, "exec-retry");
      stop();

      expect(result.status).toBe("completed");

      // Should have created 3 separate tasks (one per attempt)
      const db = getTestDb();
      const tasks = db.prepare("SELECT id, status FROM tasks WHERE parent_id = ?").all("exec-retry") as { id: string; status: string }[];
      expect(tasks.length).toBe(3);
      expect(tasks.filter(t => t.status === "failed")).toHaveLength(2);
      expect(tasks.filter(t => t.status === "completed")).toHaveLength(1);
    });
  });

  describe("TemplateExecutor identity wording preservation", () => {
    it("preserves identity wording in step prompt through task creation", async () => {
      const identityPrompt = "你是 Boris。执行模板步骤";
      const template = makeTemplate([
        { id: "step-1", prompt: identityPrompt, roleId: DEFAULT_ROLE_ID },
      ]);

      const stopCompleter = autoCompleter("exec-identity-template");

      await executor.execute(template, "exec-identity-template");

      stopCompleter();

      const db = getTestDb();
      const rows = db.prepare("SELECT id, prompt FROM tasks WHERE parent_id = ?").all("exec-identity-template") as Array<{ id: string; prompt: string }>;
      expect(rows).toHaveLength(1);
      // The prompt is now wrapped via assemblePrompt — the user's identity wording appears
      // inside the ## Task Instruction block. Legacy steps with no new fields still get the
      // wrapper (safety note only when artifacts present; otherwise just Task Instruction).
      expect(rows[0].prompt).toContain(identityPrompt);
    });
  });
});
