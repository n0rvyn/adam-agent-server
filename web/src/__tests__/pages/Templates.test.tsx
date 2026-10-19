import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { render, screen, fireEvent, waitFor } from "../utils/test-utils";
import { Templates } from "@/pages/Templates";
import { useAppStore } from "@/store/useAppStore";
import { mockTemplates, mockMultiStepTemplate, mockRoles, mockGoals } from "../fixtures";
import { server } from "../msw/server";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { toast } from "sonner";

describe("Templates", () => {
  beforeEach(() => {
    useAppStore.setState({ templates: mockTemplates, goals: mockGoals });
    vi.clearAllMocks();
  });

  it("should render page title", () => {
    render(<Templates />);
    expect(screen.getByText("Automations")).toBeInTheDocument();
  });

  it("should render New Automation button", () => {
    render(<Templates />);
    expect(screen.getByText("New Automation")).toBeInTheDocument();
  });

  it("should show template table headers", () => {
    render(<Templates />);
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Trigger")).toBeInTheDocument();
    expect(screen.getByText("Actions")).toBeInTheDocument();
  });

  it("should render template rows", () => {
    render(<Templates />);
    expect(screen.getByText("Daily Standup Report")).toBeInTheDocument();
  });

  it("should show trigger type badge", () => {
    render(<Templates />);
    expect(screen.getByText("Cron: 0 9 * * *")).toBeInTheDocument();
  });

  it("should show enabled toggle switch for cron template", () => {
    render(<Templates />);
    const toggle = screen.getByRole("switch", { name: /Toggle Daily Standup Report/ });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("data-state", "checked");
  });

  it("should have run and delete action buttons", () => {
    render(<Templates />);
    const runButton = document.querySelector('button[title="Run now"]');
    const deleteButton = document.querySelector('button[title="Delete"]');
    expect(runButton).toBeInTheDocument();
    expect(deleteButton).toBeInTheDocument();
  });

  it("should open create form when New Automation clicked", () => {
    render(<Templates />);
    fireEvent.click(screen.getByText("New Automation"));
    expect(screen.getByPlaceholderText("Template name")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Step 1 prompt")).toBeInTheDocument();
  });

  it("should show empty state when no templates", () => {
    useAppStore.setState({ templates: [] });
    render(<Templates />);
    expect(screen.getByText("No automations")).toBeInTheDocument();
  });

  it("should show confirmation dialog when Run Now clicked", () => {
    render(<Templates />);
    const runButton = document.querySelector('button[title="Run now"]')!;
    fireEvent.click(runButton);

    expect(screen.getByText("Run Template")).toBeInTheDocument();
    expect(screen.getByText(/Run .* now/i)).toBeInTheDocument();
  });

  it("should call toast.success after confirming Run Now", async () => {
    render(<Templates />);
    const runButton = document.querySelector('button[title="Run now"]')!;
    fireEvent.click(runButton);

    // Confirm in the AlertDialog
    const confirmButton = screen.getByRole("button", { name: "Run Now" });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining("Triggered: Daily Standup Report"),
      );
    });
  });

  it("should call toast.error when run fails", async () => {
    server.use(
      http.post("/task-templates/:id/run", () => {
        return HttpResponse.json(
          { code: "INTERNAL_ERROR", message: "Engine failure" },
          { status: 500 },
        );
      }),
    );

    render(<Templates />);
    const runButton = document.querySelector('button[title="Run now"]')!;
    fireEvent.click(runButton);

    const confirmButton = screen.getByRole("button", { name: "Run Now" });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("Trigger failed"),
      );
    });
  });

  it("should show delete confirmation dialog (no dependents path)", async () => {
    server.use(
      http.get("/task-templates/:id/dependents", () =>
        HttpResponse.json({ dependents: { executionCount: 0, taskCount: 0 } }),
      ),
    );
    render(<Templates />);
    const deleteButton = document.querySelector('button[title="Delete"]')!;
    fireEvent.click(deleteButton);

    expect(screen.getByText("Delete Template")).toBeInTheDocument();
    expect(await screen.findByText(/cannot be undone/)).toBeInTheDocument();
  });

  it("should show radio-choice dialog when template has tasks", async () => {
    // Default handler returns { executionCount: 2, taskCount: 3 }
    render(<Templates />);
    const deleteButton = document.querySelector('button[title="Delete"]')!;
    fireEvent.click(deleteButton);

    expect(await screen.findByText(/Template only/)).toBeInTheDocument();
    expect(screen.getByText(/Template and its tasks/)).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    // Default selection is template_only
    expect(radios[0]).toBeChecked();
    expect(radios[1]).not.toBeChecked();
  });

  it("should show template-executions-only copy when taskCount=0 but executionCount>0", async () => {
    server.use(
      http.get("/task-templates/:id/dependents", () =>
        HttpResponse.json({ dependents: { executionCount: 5, taskCount: 0 } }),
      ),
    );
    render(<Templates />);
    const deleteButton = document.querySelector('button[title="Delete"]')!;
    fireEvent.click(deleteButton);

    expect(await screen.findByText(/has 5 template executions which will be removed/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("should DELETE with mode=template_only by default when tasks exist", async () => {
    let capturedUrl = "";
    server.use(
      http.delete("/task-templates/:id", ({ request, params }) => {
        capturedUrl = request.url;
        const url = new URL(request.url);
        const mode = url.searchParams.get("mode") ?? "template_only";
        return HttpResponse.json({
          templateId: params.id,
          deleted: true,
          mode,
          deletedCounts: { template: 1, templateExecutions: 2, tasks: 0 },
        });
      }),
    );
    render(<Templates />);
    fireEvent.click(document.querySelector('button[title="Delete"]')!);
    // Wait for dialog to load dependents
    await screen.findByText(/Template only/);

    // Click the red Delete button in the footer
    const deleteActions = screen.getAllByText("Delete").filter((el) => el.tagName === "BUTTON");
    fireEvent.click(deleteActions[deleteActions.length - 1]);

    await waitFor(() => expect(capturedUrl).toContain("mode=template_only"));
  });

  it("should DELETE with mode=with_tasks when user picks 'Template and its tasks'", async () => {
    let capturedUrl = "";
    server.use(
      http.delete("/task-templates/:id", ({ request, params }) => {
        capturedUrl = request.url;
        const url = new URL(request.url);
        const mode = url.searchParams.get("mode") ?? "template_only";
        return HttpResponse.json({
          templateId: params.id,
          deleted: true,
          mode,
          deletedCounts: { template: 1, templateExecutions: 2, tasks: 3 },
        });
      }),
    );
    render(<Templates />);
    fireEvent.click(document.querySelector('button[title="Delete"]')!);
    await screen.findByText(/Template only/);

    // Select the second radio (with_tasks)
    const radios = screen.getAllByRole("radio");
    fireEvent.click(radios[1]);

    const deleteActions = screen.getAllByText("Delete").filter((el) => el.tagName === "BUTTON");
    fireEvent.click(deleteActions[deleteActions.length - 1]);

    await waitFor(() => expect(capturedUrl).toContain("mode=with_tasks"));
  });

  it("should show dash instead of switch for manual template", () => {
    const templatesWithManual = [
      ...mockTemplates,
      { id: "template-002", name: "Manual Task", trigger: { type: "manual" as const }, steps: [{ id: "s1", prompt: "do" }], enabled: true, createdAt: Date.now() },
    ];
    useAppStore.setState({ templates: templatesWithManual });
    render(<Templates />);
    // Manual template has no switch, cron template does
    expect(screen.getAllByRole("switch")).toHaveLength(1); // only cron template has switch
  });

  it("should call toast.success after toggling switch", async () => {
    render(<Templates />);
    const toggle = screen.getByRole("switch", { name: /Toggle Daily Standup Report/ });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining("disabled"),
      );
    });
  });

  it("should call toast.error when toggle fails", async () => {
    server.use(
      http.patch("/task-templates/:id", () => {
        return HttpResponse.json(
          { code: "INTERNAL_ERROR", message: "Toggle error" },
          { status: 500 },
        );
      }),
    );

    render(<Templates />);
    const toggle = screen.getByRole("switch", { name: /Toggle Daily Standup Report/ });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("Toggle failed"),
      );
    });
  });

  it("persists continueOnError when saving edits", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    useAppStore.setState({
      templates: [mockMultiStepTemplate],
      roles: mockRoles,
    });
    server.use(
      http.patch("/task-templates/:id", async ({ request }) => {
        capturedBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    render(<Templates />);
    const editButton = document.querySelector('button[title="Edit"]')!;
    fireEvent.click(editButton);

    const checkbox = screen.getByRole("checkbox", { name: /continue on error/i });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(capturedBody).not.toBeNull();
      // Phase 4 changed save handler from wholesale-overwrite to merge:
      // continueOnError is always written explicitly (false when unchecked) so it overrides any
      // existing config field rather than being dropped via wipe.
      expect((capturedBody as Record<string, unknown>).config).toEqual({ continueOnError: false });
    });
  });

  it("shows richer per-step execution details in expanded view", async () => {
    server.use(
      http.get("/task-templates", () => HttpResponse.json({
        templates: [mockMultiStepTemplate],
      })),
      http.get("/roles", () => HttpResponse.json({
        roles: [
          {
            id: "role-abc",
            name: "Researcher",
            cagPrompt: "test",
            learnedRules: [],
            memoryStreamId: "mem-abc",
            status: "active",
            preferences: {},
            createdAt: Date.now(),
          },
        ],
      })),
      http.get("/template-executions", () => HttpResponse.json({
        executions: [{
          id: "exec-1",
          templateId: "template-multi",
          status: "partial",
          stepStatuses: {
            "step-1": { taskId: "task-1", status: "completed", result: "Step one done" },
            "step-2": { taskId: "task-2", status: "failed", roleId: "role-abc", error: "Step two failed" },
          },
          startedAt: 1710000000000,
          completedAt: 1710000009000,
        }],
      })),
      http.get("/template-executions/:id", () => HttpResponse.json({
        execution: {
          id: "exec-1",
          templateId: "template-multi",
          status: "partial",
          stepStatuses: {
            "step-1": { taskId: "task-1", status: "completed", result: "Step one done" },
            "step-2": { taskId: "task-2", status: "failed", roleId: "role-abc", error: "Step two failed" },
          },
          startedAt: 1710000000000,
          completedAt: 1710000009000,
        },
        stepTasks: [
          { id: "task-1", stepId: "step-1", status: "completed", result: "Step one done", createdAt: 1710000000000, completedAt: 1710000003000 },
          { id: "task-2", stepId: "step-2", status: "failed", roleId: "role-abc", error: "Step two failed", createdAt: 1710000003000, completedAt: 1710000009000 },
        ],
      })),
    );

    render(<Templates />);
    fireEvent.click(await screen.findByText("Multi-Role Pipeline"));

    expect(await screen.findByText("Recent Template Executions")).toBeInTheDocument();
    expect(await screen.findByText("Step one done")).toBeInTheDocument();
    expect(await screen.findByText("Step two failed")).toBeInTheDocument();
    expect(await screen.findByText("@Researcher")).toBeInTheDocument();
    expect(await screen.findByText("after step-1")).toBeInTheDocument();
  });

  describe("delivery section", () => {
    it("renders delivery mode dropdown with three options (custom disabled)", async () => {
      render(<Templates />);
      fireEvent.click(screen.getByText("New Automation"));

      // Find the delivery mode dropdown (the third combobox — after trigger type and cascade target)
      const selects = screen.getAllByRole("combobox");
      const deliverySelect = selects.find((s) => {
        return Array.from(s.querySelectorAll("option")).some((o) => o.textContent === "拼接每步结果（默认）");
      });
      expect(deliverySelect).toBeDefined();

      const options = Array.from(deliverySelect!.querySelectorAll("option"));
      expect(options).toHaveLength(3);
      expect(options[0]!.textContent).toBe("拼接每步结果（默认）");
      expect(options[1]!.textContent).toBe("指定主产物");
      expect(options[2]!.textContent).toBe("自定义（即将推出）");
      expect(options[2]!).toHaveProperty("disabled", true);
    });

    it("switching to primary-artifact reveals stepId and key inputs", async () => {
      render(<Templates />);
      fireEvent.click(screen.getByText("New Automation"));

      // Find the delivery dropdown by its option text (not by index)
      const selects = screen.getAllByRole("combobox");
      const deliverySelect = selects.find((s) =>
        Array.from(s.querySelectorAll("option")).some((o) => o.textContent === "拼接每步结果（默认）"),
      );
      expect(deliverySelect).toBeDefined();

      fireEvent.change(deliverySelect!, { target: { value: "primary-artifact" } });

      await waitFor(() => {
        expect(screen.getByText("来源 step")).toBeInTheDocument();
        expect(screen.getByText("artifact key")).toBeInTheDocument();
      });
    });

    it("save with delivery config persists and reloads correctly", async () => {
      const templateWithDelivery = {
        id: "template-delivery-test",
        name: "Delivery Config Test",
        trigger: { type: "manual" as const },
        steps: [
          { id: "step-1", prompt: "Generate content" },
          { id: "step-2", prompt: "Polish output", dependsOn: ["step-1"] },
        ],
        config: {
          delivery: {
            mode: "primary-artifact",
            primaryArtifact: { stepId: "step-2", key: "final-script" },
          },
        },
        enabled: true,
      };

      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.get("/task-templates", () => HttpResponse.json({ templates: [templateWithDelivery] })),
        http.patch("/task-templates/:id", async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>;
          return HttpResponse.json({ ok: true });
        }),
        http.get("/roles", () => HttpResponse.json({ roles: [] })),
      );

      render(<Templates />);
      await waitFor(() => expect(screen.getByText("Delivery Config Test")).toBeInTheDocument());

      const editButtons = document.querySelectorAll('button[title="Edit"]');
      fireEvent.click(editButtons[0]!);

      await waitFor(() => expect(screen.getByText("Edit Automation")).toBeInTheDocument());

      // Submit form without changing delivery (pre-populated from template)
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(capturedBody).not.toBeNull());

      const config = (capturedBody as Record<string, unknown>).config as Record<string, unknown>;
      expect(config.delivery).toEqual({
        mode: "primary-artifact",
        primaryArtifact: { stepId: "step-2", key: "final-script" },
      });
    });

    it("preserves other config fields through edit save", async () => {
      const templateWithOtherConfig = {
        id: "template-other-config",
        name: "Other Config Template",
        trigger: { type: "manual" as const },
        steps: [{ id: "step-1", prompt: "Do thing" }],
        config: {
          continueOnError: true,
          delivery_message_type: "podcast_v1",
        },
        enabled: true,
      };

      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.get("/task-templates", () => HttpResponse.json({ templates: [templateWithOtherConfig] })),
        http.patch("/task-templates/:id", async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>;
          return HttpResponse.json({ ok: true });
        }),
        http.get("/roles", () => HttpResponse.json({ roles: [] })),
      );

      render(<Templates />);
      await waitFor(() => expect(screen.getByText("Other Config Template")).toBeInTheDocument());

      const editButtons = document.querySelectorAll('button[title="Edit"]');
      fireEvent.click(editButtons[0]!);

      await waitFor(() => expect(screen.getByText("Edit Automation")).toBeInTheDocument());

      // Submit form without changing anything — only save
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(capturedBody).not.toBeNull());

      const config = (capturedBody as Record<string, unknown>).config as Record<string, unknown>;
      // continueOnError and delivery_message_type must be preserved (merge-not-overwrite contract)
      expect(config.continueOnError).toBe(true);
      expect(config.delivery_message_type).toBe("podcast_v1");
    });
  });

  describe("multi-step editing (dependsOn + config)", () => {
    beforeEach(() => {
      useAppStore.setState({
        templates: [...mockTemplates, mockMultiStepTemplate],
        roles: mockRoles,
      });
    });

    it("edit form shows dependsOn selectors for multi-step template", () => {
      render(<Templates />);
      // Click the edit (pencil) button for the multi-step template
      const editButtons = document.querySelectorAll('button[title="Edit"]');
      // Second template is the multi-step one
      fireEvent.click(editButtons[1]!);

      // step-2 depends on step-1, so we should see "depends on:" label
      expect(screen.getByText("depends on:")).toBeInTheDocument();
    });

    it("edit form dependsOn toggle works", () => {
      render(<Templates />);
      const editButtons = document.querySelectorAll('button[title="Edit"]');
      fireEvent.click(editButtons[1]!);

      // The step-1 button for step-2's dependency should be active (accent)
      const depButton = screen.getByRole("button", { name: "step-1" });
      expect(depButton.className).toContain("bg-[var(--app-accent)]");

      // Click to toggle off
      fireEvent.click(depButton);
      expect(depButton.className).not.toContain("bg-[var(--app-accent)]");
    });

    it("edit form shows per-step config values", () => {
      render(<Templates />);
      const editButtons = document.querySelectorAll('button[title="Edit"]');
      fireEvent.click(editButtons[1]!);

      // step-1 has config: { timeout: 120, maxTurns: 10 }
      const timeoutInputs = screen.getAllByPlaceholderText("default") as HTMLInputElement[];
      // First timeout input should have value 120, first maxTurns should have 10
      const withValues = timeoutInputs.filter((input) => input.value !== "");
      expect(withValues.length).toBeGreaterThanOrEqual(2);
      expect(withValues.some((input) => input.value === "120")).toBe(true);
      expect(withValues.some((input) => input.value === "10")).toBe(true);
    });

    it("create form shows per-step config fields when adding steps", async () => {
      render(<Templates />);
      fireEvent.click(screen.getByText("New Automation"));

      // Initially 1 step — config fields should be present
      expect(await screen.findByText("timeout(s):", undefined, { timeout: 15000 })).toBeInTheDocument();
      expect(await screen.findByText("max turns:", undefined, { timeout: 15000 })).toBeInTheDocument();

      // Add a second step
      fireEvent.click(screen.getByText("Add Step"));
      // Should now have 2 sets of config labels
      await waitFor(() => {
        expect(screen.getAllByText("timeout(s):")).toHaveLength(2);
        expect(screen.getAllByText("max turns:")).toHaveLength(2);
      }, { timeout: 15000 });
    });

    it("create form serializes config in POST body", async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.post("/task-templates", async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>;
          return HttpResponse.json({ id: "new-tmpl", name: "test" });
        }),
      );

      render(<Templates />);
      fireEvent.click(screen.getByText("New Automation"));

      // Fill name
      fireEvent.change(screen.getByPlaceholderText("Template name"), { target: { value: "Config Test" } });

      // Fill step prompt
      fireEvent.change(screen.getByPlaceholderText("Step 1 prompt"), { target: { value: "Do something" } });

      // Fill timeout
      const timeoutInputs = screen.getAllByPlaceholderText("default") as HTMLInputElement[];
      fireEvent.change(timeoutInputs[0]!, { target: { value: "300" } });

      // Submit
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(capturedBody).not.toBeNull();
        const steps = (capturedBody as Record<string, unknown>).steps as Array<Record<string, unknown>>;
        expect(steps[0].config).toEqual({ timeout: 300 });
      });
    });

    it("create form serializes goalIds together with steps", async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.post("/task-templates", async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>;
          return HttpResponse.json({ id: "new-tmpl", name: "test" });
        }),
      );

      render(<Templates />);
      fireEvent.click(screen.getByText("New Automation"));

      fireEvent.change(screen.getByPlaceholderText("Template name"), { target: { value: "Goal Template" } });
      fireEvent.change(screen.getByPlaceholderText("Step 1 prompt"), { target: { value: "Do goal work" } });
      fireEvent.click(screen.getByLabelText(/Complete 50 tasks this week/));
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(capturedBody).not.toBeNull();
        const body = capturedBody as Record<string, unknown>;
        expect(body.goalIds).toEqual(["goal-001"]);
        expect(body.steps).toEqual([
          expect.objectContaining({ id: "step-1", prompt: "Do goal work" }),
        ]);
      });
    });

    it("keeps submit disabled when Goals are selected without a Template step", async () => {
      render(<Templates />);
      fireEvent.click(screen.getByText("New Automation"));

      fireEvent.change(screen.getByPlaceholderText("Template name"), { target: { value: "Goal Only" } });
      fireEvent.click(screen.getByLabelText(/Complete 50 tasks this week/));

      expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    });
  });
  describe("cascade trigger selector", () => {
    const cascadeTemplates = [
      {
        id: "tmpl-cron",
        name: "Daily Cron Job",
        trigger: { type: "cron" as const, cron: "0 9 * * *" },
        steps: [{ id: "s1", prompt: "run" }],
        enabled: true,
      },
      {
        id: "tmpl-manual",
        name: "Manual Step",
        trigger: { type: "manual" as const },
        steps: [{ id: "s1", prompt: "run" }],
        enabled: true,
      },
    ];

    beforeEach(() => {
      useAppStore.setState({ templates: cascadeTemplates });
      // Override MSW so fetchTemplates() on mount does not stomp the store
      server.use(
        http.get("/task-templates", () => HttpResponse.json({ templates: cascadeTemplates })),
      );
    });

    it("shows all 4 trigger types in the create dropdown", async () => {
      render(<Templates />);
      fireEvent.click(screen.getByText("New Automation"));

      const selects = screen.getAllByRole("combobox");
      const triggerSelect = selects[0];

      const options = Array.from(triggerSelect.querySelectorAll("option")).map((o) => o.textContent);
      expect(options).toEqual([
        "Manual",
        "Schedule (Cron)",
        "One-time",
        "Template completion",
        "Event (definition)",
      ]);
    });

    it("renders cascade target template selector when template_complete is chosen", async () => {
      render(<Templates />);
      fireEvent.click(screen.getByText("New Automation"));

      // Select template_complete trigger
      const selects = screen.getAllByRole("combobox");
      fireEvent.change(selects[0], { target: { value: "template_complete" } });

      // Cascade select should appear
      expect(await screen.findByText("-- Select target template --")).toBeInTheDocument();
      // Existing templates should appear as options (role=option scoped to the select)
      expect(screen.getByRole("option", { name: "Daily Cron Job" })).toBeInTheDocument();
    });

    it("POST body includes trigger.type=template_complete and trigger.event with target id on submit", async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.post("/task-templates", async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>;
          return HttpResponse.json({ id: "new-tmpl", name: "Cascade Test" });
        }),
      );

      render(<Templates />);
      fireEvent.click(screen.getByText("New Automation"));

      // Fill name
      fireEvent.change(screen.getByPlaceholderText("Template name"), { target: { value: "Cascade Test" } });

      // Select template_complete
      const selects = screen.getAllByRole("combobox");
      fireEvent.change(selects[0], { target: { value: "template_complete" } });

      // Wait for cascade select (second combobox) then select a target
      await screen.findByText("-- Select target template --");
      const allSelects = screen.getAllByRole("combobox");
      fireEvent.change(allSelects[1], { target: { value: "tmpl-cron" } });

      // Fill step prompt
      fireEvent.change(
        screen.getByPlaceholderText("Step 1 prompt"),
        { target: { value: "after cascade" } },
      );

      // Submit
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(capturedBody).not.toBeNull();
        const trigger = (capturedBody as Record<string, unknown>).trigger as Record<string, unknown>;
        expect(trigger.type).toBe("template_complete");
        expect(trigger.event).toBe("template_complete:tmpl-cron");
      });
    });

    it("disables submit button when template_complete selected without a target", async () => {
      render(<Templates />);
      fireEvent.click(screen.getByText("New Automation"));

      fireEvent.change(screen.getByPlaceholderText("Template name"), { target: { value: "No Target Test" } });
      fireEvent.change(
        screen.getByPlaceholderText("Step 1 prompt"),
        { target: { value: "test" } },
      );

      const selects = screen.getAllByRole("combobox");
      fireEvent.change(selects[0], { target: { value: "template_complete" } });

      // Wait for cascade select
      await screen.findByText("-- Select target template --");

      // Create button should be disabled (no target selected)
      const createBtn = screen.getByRole("button", { name: "Create" });
      expect(createBtn).toBeDisabled();
    });

    it("excludes the current template from cascade selector in edit mode", async () => {
      const editTemplates = [
        {
          id: "tmpl-to-edit",
          name: "Edit Me",
          trigger: { type: "template_complete" as const, event: "template_complete:tmpl-other" },
          steps: [{ id: "s1", prompt: "x" }],
          enabled: true,
        },
        {
          id: "tmpl-other",
          name: "Other Template",
          trigger: { type: "manual" as const },
          steps: [{ id: "s1", prompt: "y" }],
          enabled: true,
        },
      ];
      useAppStore.setState({ templates: editTemplates });
      server.use(
        http.get("/task-templates", () => HttpResponse.json({ templates: editTemplates })),
      );

      render(<Templates />);

      // Click edit on the template_complete template
      const editButtons = document.querySelectorAll('button[title="Edit"]');
      fireEvent.click(editButtons[0]!);

      // Cascade select should appear pre-populated with "tmpl-other"
      const cascadeOption = await screen.findByRole("option", { name: "Other Template" });
      expect(cascadeOption).toBeInTheDocument();
      // "Edit Me" should NOT appear as an option (self-reference excluded)
      expect(screen.queryByRole("option", { name: "Edit Me" })).not.toBeInTheDocument();
    });

    it("renders '[deleted template]' when referenced template does not exist in list", async () => {
      const orphanTemplates = [
        {
          id: "tmpl-orphan",
          name: "Orphan Cascade",
          trigger: { type: "template_complete" as const, event: "template_complete:deleted-id" },
          steps: [{ id: "s1", prompt: "x" }],
          enabled: true,
        },
      ];
      useAppStore.setState({ templates: orphanTemplates });
      server.use(
        http.get("/task-templates", () => HttpResponse.json({ templates: orphanTemplates })),
      );

      render(<Templates />);

      expect(await screen.findByText("When template '[deleted template]' completes")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Task 17: primary-artifact key is optional — outputAs resolves from selected step
  // ---------------------------------------------------------------------------
  describe("primary-artifact key optional (Task 17)", () => {
    it("step has outputAs, user picks it → renders resolved outputAs label (no key override needed)", async () => {
      // Template with a step that has outputAs declared
      const templateWithOutputAs = {
        id: "template-outputas-test",
        name: "OutputAs Test",
        trigger: { type: "manual" as const },
        steps: [
          { id: "step-1", prompt: "Generate content", outputAs: "final-draft" },
          { id: "step-2", prompt: "Polish", dependsOn: ["step-1"] },
        ],
        config: {
          delivery: {
            mode: "primary-artifact",
            primaryArtifact: { stepId: "step-1" }, // no key — to be derived from outputAs
          },
        },
        enabled: true,
      };

      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.get("/task-templates", () => HttpResponse.json({ templates: [templateWithOutputAs] })),
        http.patch("/task-templates/:id", async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>;
          return HttpResponse.json({ ok: true });
        }),
        http.get("/roles", () => HttpResponse.json({ roles: [] })),
      );

      render(<Templates />);
      await waitFor(() => expect(screen.getByText("OutputAs Test")).toBeInTheDocument());

      const editButtons = document.querySelectorAll('button[title="Edit"]');
      fireEvent.click(editButtons[0]!);

      // Switch delivery mode to primary-artifact
      const selects = screen.getAllByRole("combobox");
      const deliverySelect = selects.find((s) =>
        Array.from(s.querySelectorAll("option")).some((o) => o.textContent === "指定主产物"),
      );
      expect(deliverySelect).toBeDefined();

      // Switch to primary-artifact if not already
      if ((deliverySelect as HTMLSelectElement).value !== "primary-artifact") {
        fireEvent.change(deliverySelect!, { target: { value: "primary-artifact" } });
      }

      // Step "step-1" is pre-selected (from config.primaryArtifact.stepId)
      // The "Will use step's output:" label must be visible
      await waitFor(() => {
        expect(screen.getByText(/Will use step's output:/)).toBeInTheDocument();
        expect(screen.getByText(/final-draft/)).toBeInTheDocument();
      });

      // Submit without typing a custom key — stepId only sent, key omitted
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(capturedBody).not.toBeNull());
      const config = (capturedBody as Record<string, unknown>).config as Record<string, unknown>;
      expect(config.delivery).toEqual({
        mode: "primary-artifact",
        primaryArtifact: { stepId: "step-1" }, // key omitted — server derives from outputAs
      });
    });

    it("user picks a step without outputAs, types custom key → save sends {stepId, key}", async () => {
      render(<Templates />);
      fireEvent.click(screen.getByText("New Automation"));

      // Add a step
      fireEvent.click(screen.getByText("Add Step"));

      // Fill step prompts
      const promptInputs = screen.getAllByPlaceholderText("Step 1 prompt");
      fireEvent.change(promptInputs[0]!, { target: { value: "Write draft" } });

      // Select primary-artifact delivery mode
      const selects = screen.getAllByRole("combobox");
      const deliverySelect = selects.find((s) =>
        Array.from(s.querySelectorAll("option")).some((o) => o.textContent === "指定主产物"),
      );
      expect(deliverySelect).toBeDefined();
      fireEvent.change(deliverySelect!, { target: { value: "primary-artifact" } });

      // Pick step-1 as the primary artifact source
      await waitFor(() => {
        expect(screen.getByText("来源 step")).toBeInTheDocument();
      });
      const stepSelects = screen.getAllByRole("combobox");
      const stepSelect = stepSelects.find((s) =>
        Array.from(s.querySelectorAll("option")).some((o) => o.textContent === "step-1"),
      );
      expect(stepSelect).toBeDefined();
      fireEvent.change(stepSelect!, { target: { value: "step-1" } });

      // In create form, steps have no outputAs — so the label is absent and key is required.
      // The key input is visible with placeholder "手动输入 key"
      await waitFor(() => {
        const inputs = screen.getAllByPlaceholderText("手动输入 key");
        expect(inputs.length).toBeGreaterThan(0);
      });

      // Type a custom key override
      const keyInputs = screen.getAllByPlaceholderText("手动输入 key");
      fireEvent.change(keyInputs[keyInputs.length - 1]!, { target: { value: "my-custom-key" } });

      // Submit — save sends {stepId, key}
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.post("/task-templates", async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>;
          return HttpResponse.json({ id: "new-tmpl" });
        }),
        http.get("/task-templates", () => HttpResponse.json({ templates: [] })),
      );
      fireEvent.change(screen.getByPlaceholderText("Template name"), { target: { value: "Custom Key Test" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => expect(capturedBody).not.toBeNull());
      const config = (capturedBody as Record<string, unknown>).config as Record<string, unknown>;
      expect(config.delivery).toEqual({
        mode: "primary-artifact",
        primaryArtifact: { stepId: "step-1", key: "my-custom-key" },
      });
    });
  });
});
