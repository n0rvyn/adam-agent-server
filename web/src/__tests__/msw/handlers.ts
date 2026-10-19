import { http, HttpResponse } from "msw";
import {
  mockTasks,
  mockGoals,
  mockStrategies,
  mockTemplates,
  mockReadiness,
  mockRoles,
  mockMistakePatterns,
} from "../fixtures";
import type { Task, Goal, TaskTemplate, Role } from "@/lib/types";

export const handlers = [
  // Tasks
  http.get("/tasks", ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    let tasks = [...mockTasks];
    if (status && status !== "all") {
      tasks = tasks.filter((t) => t.status === status);
    }
    return HttpResponse.json({ tasks, total: tasks.length });
  }),

  http.get("/tasks/:id", ({ params }) => {
    const task = mockTasks.find((t) => t.id === params.id);
    if (!task) return HttpResponse.json({ error: "Not found" }, { status: 404 });
    return HttpResponse.json({ task });
  }),

  http.post("/tasks", async ({ request }) => {
    const body = (await request.json()) as { prompt: string };
    const newTask: Task = {
      id: `task-${Date.now()}`,
      status: "pending",
      prompt: body.prompt,
      createdAt: Date.now(),
    };
    return HttpResponse.json({ task: newTask }, { status: 201 });
  }),

  http.post("/tasks/:id/cancel", ({ params }) => {
    const task = mockTasks.find((t) => t.id === params.id);
    if (!task) return HttpResponse.json({ error: "Not found" }, { status: 404 });
    return HttpResponse.json({ task: { ...task, status: "cancelled" } });
  }),

  // Plugins
  http.get("/plugins/stats", () => HttpResponse.json({ stats: [] })),

  // Goals
  http.get("/goals", () => HttpResponse.json({ goals: mockGoals })),

  http.post("/goals", async ({ request }) => {
    const body = (await request.json()) as { input: string };
    const newGoal: Goal = {
      id: `goal-${Date.now()}`,
      name: body.input.slice(0, 50),
      roleId: "role-001",
      metricType: "count",
      targetValue: 10,
      currentValue: 0,
      deadline: Date.now() + 86_400_000,
      budgetUsd: 100,
      status: "active",
      createdAt: Date.now(),
    };
    return HttpResponse.json({ goal: newGoal }, { status: 201 });
  }),

  // Strategies
  http.get("/strategies", () => HttpResponse.json({ strategies: mockStrategies })),

  // Templates
  http.get("/task-templates", () => HttpResponse.json({ templates: mockTemplates })),

  http.post("/task-templates", async ({ request }) => {
    const body = (await request.json()) as {
      name: string;
      trigger: { type: string };
      steps: Array<{ id: string; prompt: string }>;
      enabled: boolean;
    };
    const newTemplate: TaskTemplate = {
      id: `template-${Date.now()}`,
      name: body.name,
      trigger: body.trigger as TaskTemplate["trigger"],
      steps: body.steps,
      enabled: body.enabled,
      createdAt: Date.now(),
    };
    return HttpResponse.json({ template: newTemplate }, { status: 201 });
  }),

  http.patch("/task-templates/:id", ({ params }) => {
    return HttpResponse.json({ templateId: params.id });
  }),

  http.post("/task-templates/:id/run", () => {
    return HttpResponse.json({ executionId: `exec-${Date.now()}`, status: "started" });
  }),

  http.get("/task-templates/:id/dependents", () => {
    return HttpResponse.json({
      dependents: { executionCount: 2, taskCount: 3 },
    });
  }),

  // Template Executions
  http.get("/template-executions", ({ request }) => {
    const url = new URL(request.url);
    const templateId = url.searchParams.get("templateId");
    if (!templateId) return HttpResponse.json({ executions: [] });
    return HttpResponse.json({
      executions: [
        {
          id: `exec-${templateId}-1`,
          templateId,
          status: "completed",
          stepStatuses: {},
          startedAt: Date.now() - 60000,
          completedAt: Date.now() - 30000,
          stepTasks: [],
        },
      ],
    });
  }),

  http.get("/template-executions/:id", ({ params }) => {
    return HttpResponse.json({
      execution: {
        id: params.id,
        templateId: "tmpl-001",
        status: "completed",
        stepStatuses: {},
        startedAt: Date.now() - 60000,
        completedAt: Date.now() - 30000,
      },
      stepTasks: [],
    });
  }),

  // Execution Feedback
  http.post("/executions/:executionId/feedback", () => {
    return HttpResponse.json({ ok: true });
  }),

  http.delete("/task-templates/:id", ({ request, params }) => {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") ?? "template_only";
    return HttpResponse.json({
      templateId: params.id,
      deleted: true,
      mode,
      deletedCounts: {
        template: 1,
        templateExecutions: 2,
        tasks: mode === "with_tasks" ? 3 : 0,
      },
    });
  }),

  // Plugins
  http.get("/plugins", () => HttpResponse.json({
    plugins: [
      {
        id: "dev-workflow@indie",
        version: "2.18.0",
        scope: "user",
        installPath: "/home/.claude/plugins/cache/dev-workflow",
        enabled: true,
        installedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        globalEnabled: true,
        manifest: {
          name: "dev-workflow",
          version: "2.18.0",
          description: "Developer workflow plugin",
          skills: [{ name: "commit", description: "Auto commit" }],
          agents: [],
          mcpServers: [],
          hooks: ["pre-commit"],
          lspServers: [],
        },
      },
      {
        id: "test-plugin@proj",
        version: "1.0.0",
        scope: "project",
        projectPath: "/Users/test/project",
        installPath: "/test/plugin",
        enabled: true,
        installedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        globalEnabled: false,
        manifest: {
          name: "test-plugin",
          version: "1.0.0",
          description: "A test plugin",
          skills: [],
          agents: [{ name: "test-agent", description: "Test agent" }],
          mcpServers: ["test-mcp"],
          hooks: [],
          lspServers: [],
        },
      },
    ],
  })),

  http.patch("/plugins/:id", ({ params }) => {
    if (typeof params.id === "string" && params.id.startsWith("global:")) {
      return HttpResponse.json({ code: "READ_ONLY", message: "Global plugins are managed by Claude Code CLI" }, { status: 403 });
    }
    return HttpResponse.json({ pluginId: params.id });
  }),

  http.post("/plugins/:id/enable", ({ params }) => {
    return HttpResponse.json({ pluginId: params.id, globalEnabled: true });
  }),

  http.post("/plugins/:id/disable", ({ params }) => {
    return HttpResponse.json({ pluginId: params.id, globalEnabled: false });
  }),

  http.post("/plugins/uninstall/:id", () => {
    return HttpResponse.json({ success: true });
  }),

  // Marketplace
  http.get("/plugins/marketplace", () => HttpResponse.json({
    available: [
      { pluginId: "cool-plugin@mkt", name: "cool-plugin", description: "A cool plugin", marketplaceName: "mkt", source: { source: "url", url: "https://example.com" }, installCount: 42 },
    ],
    installed: [
      { id: "dev-workflow@indie", version: "2.18.0", scope: "user", enabled: true },
    ],
  })),

  http.get("/plugins/marketplace/sources", () => HttpResponse.json({
    sources: [
      { name: "claude-plugins-official", source: "github", repo: "anthropics/claude-plugins-official" },
    ],
  })),

  http.get("/plugins/marketplaces", () => HttpResponse.json({
    sources: [
      { name: "claude-plugins-official", source: "github", repo: "anthropics/claude-plugins-official", installLocation: "~/.claude/plugins" },
    ],
  })),

  http.post("/plugins/marketplace/sources", () => HttpResponse.json({ success: true, name: "new-mkt" })),

  http.post("/plugins/marketplaces", async ({ request }) => {
    const body = (await request.json()) as { url: string };
    return HttpResponse.json({ success: true, url: body.url });
  }),

  http.delete("/plugins/marketplaces/:name", ({ params }) =>
    HttpResponse.json({ success: true, name: params.name }),
  ),

  http.post("/plugins/marketplace/install/:name", () => HttpResponse.json({ success: true })),

  http.post("/plugins/marketplace/uninstall/:name", () => HttpResponse.json({ success: true })),

  // Task artifacts
  http.get("/tasks/:id/artifacts", ({ params }) => {
    return HttpResponse.json({
      artifacts: [
        {
          id: "art-task-1",
          sourceKind: "task_published",
          taskId: params.id,
          kind: "file",
          mime: "text/plain",
          originalFilename: "output.txt",
          sizeBytes: 1024,
          createdAt: Date.now() - 10000,
        },
        {
          id: "art-task-2",
          sourceKind: "task_published",
          taskId: params.id,
          kind: "file",
          mime: "audio/mpeg",
          originalFilename: "podcast.mp3",
          sizeBytes: 2048000,
          createdAt: Date.now() - 5000,
        },
      ],
      total: 2,
    });
  }),

  // Step logs
  http.get("/tasks/:id/logs", () => {
    return HttpResponse.json({
      logs: [
        { id: "log-1", taskId: "task-001", index: 0, type: "tool_call", content: "Reading file", toolName: "Read", timestamp: Date.now() - 5000 },
        { id: "log-2", taskId: "task-001", index: 1, type: "tool_result", content: "File content here", toolName: "Read", timestamp: Date.now() - 4000 },
        { id: "log-3", taskId: "task-001", index: 2, type: "plugin_error", content: "Plugin 'x' failed to load", timestamp: Date.now() - 3000 },
      ],
    });
  }),

  // Plan approval
  http.get("/tasks/:id/plan", ({ params }) => {
    if (params.id === "task-001") {
      return HttpResponse.json({
        plans: [{
          id: "plan-001",
          taskId: "task-001",
          status: "approved",
          approvalType: "once",
          plan: {
            steps: [
              { index: 0, description: "Analyze codebase structure", toolsNeeded: ["Read"], riskLevel: "low", expectedOutput: "Code structure summary" },
              { index: 1, description: "Implement authentication module", toolsNeeded: ["Write", "Edit"], riskLevel: "high", expectedOutput: "Auth module with login/logout" },
            ],
            overallRisk: "high",
            requiredPermissions: { fileSystem: true },
          },
          deviationReport: {
            stepsPlanned: 2,
            stepsExecuted: 2,
            overallAccuracy: 0.85,
            deviations: [
              { stepIndex: 1, planned: "Auth module", actual: "Auth module + token refresh", deviationType: "added" },
            ],
          },
          learnedRules: { stylePreferences: ["Prefer explicit token refresh over implicit expiry handling"], avoidedActions: [], pinnedParameters: [] },
          createdAt: Date.now() - 60000,
          approvedAt: Date.now() - 55000,
        }],
      });
    }
    return HttpResponse.json({ plans: [] });
  }),

  http.post("/tasks/:id/approve-plan", async ({ request }) => {
    const body = (await request.json()) as { planId: string; decision: string; approvalType?: string };
    return HttpResponse.json({ planId: body.planId, decision: body.decision, approvalType: body.approvalType });
  }),

  // Config (Settings page)
  http.get("/config", () =>
    HttpResponse.json({
      config: {
        "defaults.model": { value: "claude-sonnet-4-6", mutable: true },
        "defaults.effort": { value: "medium", mutable: true },
        "defaults.deniedReadPaths": { value: ["~/.ssh"], mutable: false },
      },
      mutable: ["defaults.model", "defaults.effort"],
      restartRequired: [],
      sandbox: { platform: "sandbox-exec", available: true },
      osCapabilities: {
        registry: [
          {
            id: "automation",
            label: "Automation",
            description: "Launch and control other apps via Apple Events.",
            platform: "darwin",
            status: "runtime-enforced",
            availability: "editable",
            editable: true,
            supportsTargets: true,
          },
          {
            id: "accessibility",
            label: "Accessibility",
            description: "Control desktop UI and accessibility automation surfaces.",
            platform: "darwin",
            status: "runtime-enforced",
            availability: "editable",
            editable: true,
          },
          {
            id: "full-disk-access",
            label: "Full Disk Access",
            description: "Host-level macOS grant for protected storage locations.",
            platform: "darwin",
            status: "host-only",
            availability: "host-only",
            editable: false,
            effectiveDisabledReason: "This is a host app permission, not a Role-level control.",
          },
        ],
      },
    }),
  ),

  // File system
  http.get("/fs/suggest-dirs", () => HttpResponse.json({ suggestions: [] })),

  // Channels
  http.get("/channels", () => HttpResponse.json({ channels: [] })),

  // Logs / events
  http.get("/logs", () => HttpResponse.json({ logs: [] })),

  // Health
  http.get("/readyz", () => HttpResponse.json(mockReadiness)),
  http.get("/healthz", () => HttpResponse.json({ status: "ok" })),

  // Roles
  http.get("/roles", () => HttpResponse.json({ roles: mockRoles })),

  http.get("/roles/:id", ({ params }) => {
    const role = mockRoles.find((r) => r.id === params.id);
    if (!role) return HttpResponse.json({ error: "Not found" }, { status: 404 });
    return HttpResponse.json({ role, projectPlugins: [], workspacePath: `/home/.adam/roles/${role.name}` });
  }),

  // Mistake Patterns
  http.get("/mistake-patterns", ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    let patterns = [...mockMistakePatterns];
    if (status && status !== "all") {
      patterns = patterns.filter((p) => p.status === status);
    }
    return HttpResponse.json({ mistakePatterns: patterns });
  }),

  http.patch("/mistake-patterns/:id", ({ params }) => {
    return HttpResponse.json({ ok: true, id: params.id, status: "acknowledged" });
  }),

  http.get("/memories/:roleId", () =>
    HttpResponse.json({ memories: [] }),
  ),

  http.get("/evolution-audit", ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.get("roleId")) {
      return HttpResponse.json([]);
    }
    return HttpResponse.json([]);
  }),
];
