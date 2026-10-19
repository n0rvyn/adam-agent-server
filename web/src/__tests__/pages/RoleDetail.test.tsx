import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { RoleDetail } from "@/pages/RoleDetail";
import { useAppStore } from "@/store/useAppStore";
import type { Role } from "@/lib/types";
import * as apiModule from "@/lib/api";
import { server } from "../msw/server";

const mockRoleData: Role = {
  id: "role-001",
  name: "Engineer",
  cagPrompt: "You are a senior engineer focused on clean code.",
  learnedRules: { stylePreferences: ["Write tests first"], avoidedActions: [], pinnedParameters: [] },
  memoryStreamId: "mem-001",
  status: "active",
  performanceScore: 0.92,
  preferences: { effort: "high" },
  createdAt: Date.now() - 86_400_000,
  updatedAt: Date.now() - 86_400_000,
  osCapabilities: [{ id: "automation", targets: ["com.apple.mail"] }],
};

const mockDeleteRole = vi.fn().mockResolvedValue({ roleId: "role-001", deleted: true });

// Capture the original api before spying so we can delegate to it.
const originalApi = apiModule.api;
function mockApi() {
  return vi.spyOn(apiModule, "api").mockImplementation(
    (url: string, options?: RequestInit) => originalApi(url, options),
  );
}

describe("RoleDetail page", () => {
  let apiSpy: ReturnType<typeof mockApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiSpy = mockApi();

    // BoundExtensionsCard (Phase 2) calls these on mount — stub to empty so
    // the test environment doesn't try real fetch (ECONNREFUSED otherwise).
    vi.spyOn(apiModule, "listRoleExtensions").mockResolvedValue([]);
    vi.spyOn(apiModule, "listExtensions").mockResolvedValue([]);

    useAppStore.setState({
      updateRole: async () => { /* noop */ },
      deleteRole: mockDeleteRole,
    });
  });

  afterEach(() => {
    apiSpy.mockRestore();
  });

  function renderRoleDetail() {
    return render(
      <MemoryRouter initialEntries={["/roles/role-001"]}>
        <Routes>
          <Route path="/roles" element={<div>Roles</div>} />
          <Route path="/roles/:id" element={<RoleDetail />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  async function waitForRoleDetail() {
    expect(await screen.findByText("Engineer", undefined, { timeout: 15000 })).toBeInTheDocument();
  }

  it("renders role detail sections", async () => {
    renderRoleDetail();
    await waitForRoleDetail();

    expect(screen.getByText("CAG Prompt")).toBeInTheDocument();
    expect(screen.getByText("Tool Permissions")).toBeInTheDocument();
    expect(screen.getByText("OS Capabilities")).toBeInTheDocument();
    expect(screen.getByText("Role Plugins")).toBeInTheDocument();
    expect(screen.getByText("Execution Config")).toBeInTheDocument();
    expect(screen.getByText(/Memories/)).toBeInTheDocument();
    expect(screen.getByText(/Evolution History/)).toBeInTheDocument();
  });

  it("Delete button opens confirmation dialog", async () => {
    renderRoleDetail();
    await waitForRoleDetail();

    await act(async () => {
      const deleteButton = screen.getByRole("button", { name: "Delete" });
      await deleteButton.click();
    });

    await waitFor(() => {
      expect(screen.getByText("Delete Role")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Are you sure you want to delete "Engineer"\? This action cannot be undone./),
    ).toBeInTheDocument();
  });

  it("Confirming delete calls deleteRole", async () => {
    renderRoleDetail();
    await waitForRoleDetail();

    await act(async () => {
      const deleteButton = screen.getByRole("button", { name: "Delete" });
      await deleteButton.click();
    });

    await waitFor(() => {
      expect(screen.getByText("Delete Role")).toBeInTheDocument();
    });

    // Click the destructive action button (AlertDialogAction).
    // Label is "Delete Anyway" in src/pages/RoleDetail.tsx:368 (not "Delete" — that's the trigger).
    await act(async () => {
      const deleteAction = screen.getByRole("button", { name: "Delete Anyway" });
      await deleteAction.click();
    });

    await waitFor(() => {
      expect(mockDeleteRole).toHaveBeenCalledWith("role-001");
    });
  });

  it("Cancel delete closes dialog without calling deleteRole", async () => {
    renderRoleDetail();
    await waitForRoleDetail();

    await act(async () => {
      const deleteButton = screen.getByRole("button", { name: "Delete" });
      await deleteButton.click();
    });

    await waitFor(() => {
      expect(screen.getByText("Delete Role")).toBeInTheDocument();
    });

    await act(async () => {
      const cancelButton = screen.getByRole("button", { name: "Cancel" });
      await cancelButton.click();
    });

    await waitFor(() => {
      expect(screen.queryByText("Delete Role")).not.toBeInTheDocument();
    });
    expect(mockDeleteRole).not.toHaveBeenCalled();
  });

  it("Evolution history renders from bare array response", async () => {
    renderRoleDetail();
    await waitForRoleDetail();
    expect(await screen.findByText(/Evolution History/, undefined, { timeout: 15000 })).toBeInTheDocument();
    expect(
      await screen.findByText(/No evolution history for this role/, undefined, { timeout: 15000 }),
    ).toBeInTheDocument();
  });

  describe("Tool Permissions section", () => {
    it("renders checkboxes for all built-in tools", async () => {
      renderRoleDetail();
      await waitForRoleDetail();
      expect(await screen.findByText("Tool Permissions", undefined, { timeout: 15000 })).toBeInTheDocument();

      // Verify all 11 built-in tools are rendered as switches
      for (const tool of ["Read", "Write", "Edit", "Bash", "Grep", "Glob",
        "WebSearch", "WebFetch", "LSP", "NotebookEdit", "Agent"]) {
        expect(screen.getByRole("switch", { name: `Toggle ${tool}` })).toBeInTheDocument();
      }
    });
  });

  describe("OS Capabilities section", () => {
    it("renders the full registry and automation targets editor", async () => {
      server.use(
        http.get("/roles/:id", () =>
          HttpResponse.json({
            role: { ...mockRoleData },
            workspacePath: `/home/.adam/roles/${mockRoleData.name}`,
            projectPlugins: [],
          }),
        ),
      );

      renderRoleDetail();
      await waitForRoleDetail();
      expect(await screen.findByText("OS Capabilities", undefined, { timeout: 15000 })).toBeInTheDocument();
      expect(await screen.findByText("Automation", undefined, { timeout: 15000 })).toBeInTheDocument();

      expect(screen.getByText("Accessibility")).toBeInTheDocument();
      expect(screen.getByText("Full Disk Access")).toBeInTheDocument();
      expect(screen.getByDisplayValue("com.apple.mail")).toBeInTheDocument();
      expect(screen.getByRole("switch", { name: "Toggle OS capability Automation" })).toBeInTheDocument();
    });
  });

  describe("Execution Config section", () => {
    it("shows model-tier and budget fields", async () => {
      renderRoleDetail();
      await waitForRoleDetail();
      expect(await screen.findByText("Execution Config", undefined, { timeout: 15000 })).toBeInTheDocument();

      // Verify execution mode select is present (multiple comboboxes due to permissionMode)
      const comboboxes = screen.getAllByRole("combobox");
      expect(comboboxes.length).toBeGreaterThanOrEqual(1);
      // Model is now chosen via the tier select (the standalone hardcoded-model input was removed).
      expect(screen.getByText("Model Tier")).toBeInTheDocument();
      // Verify Max Budget input (number input)
      expect(screen.getByPlaceholderText("0 = unlimited")).toBeInTheDocument();
    });
  });

  describe("Role Plugins section", () => {
    it("shows project plugins from hook data", async () => {
      server.use(
        http.get("/roles/:id", () =>
          HttpResponse.json({
            role: { ...mockRoleData },
            workspacePath: `/home/.adam/roles/${mockRoleData.name}`,
            projectPlugins: [],
          }),
        ),
        http.get("/roles", () => HttpResponse.json({
          roles: [
            {
              id: "role-001",
              name: "Engineer",
              workspacePath: `/home/.adam/roles/${mockRoleData.name}`,
            },
          ],
        })),
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
            },
            {
              id: "test-plugin@proj",
              version: "1.0.0",
              scope: "project",
              projectPath: `/home/.adam/roles/${mockRoleData.name}`,
              installPath: "/test/plugin",
              enabled: true,
              installedAt: new Date().toISOString(),
              lastUpdated: new Date().toISOString(),
              globalEnabled: true,
            },
          ],
        })),
      );
      renderRoleDetail();
      await waitForRoleDetail();
      expect(await screen.findByText("Role Plugins", undefined, { timeout: 15000 })).toBeInTheDocument();

      expect(await screen.findByText("test-plugin", undefined, { timeout: 15000 })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Uninstall" })).toBeInTheDocument();
    });

    it("shows empty state when no project plugins", async () => {
      renderRoleDetail();
      await waitForRoleDetail();
      expect(await screen.findByText("Role Plugins", undefined, { timeout: 15000 })).toBeInTheDocument();

      expect(screen.getByText("This Role uses the user-scope defaults")).toBeInTheDocument();
    });

    it("installs a user-scope plugin from the picker", async () => {
      const installBodies: unknown[] = [];
      let plugins = [
        {
          id: "dev-workflow@indie",
          version: "2.18.0",
          scope: "user",
          installPath: "/home/.claude/plugins/cache/dev-workflow",
          enabled: true,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          globalEnabled: true,
        },
      ];

      server.use(
        http.get("/roles", () => HttpResponse.json({
          roles: [
            {
              id: "role-001",
              name: "Engineer",
              workspacePath: `/home/.adam/roles/${mockRoleData.name}`,
            },
          ],
        })),
        http.get("/plugins", () => HttpResponse.json({ plugins })),
        http.post("/plugins/install/:id", async ({ request, params }) => {
          const body = await request.json();
          installBodies.push(body);
          const pluginId = decodeURIComponent(String(params.id));
          const source = plugins.find((plugin) => plugin.id === pluginId);
          if (source && body && typeof body === "object" && "cwd" in body) {
            plugins = [
              ...plugins,
              {
                ...source,
                scope: "project",
                projectPath: body.cwd as string,
                installPath: `${body.cwd}/plugins/${pluginId.split("@")[0]}`,
              },
            ];
          }
          return HttpResponse.json({ success: true });
        }),
      );

      renderRoleDetail();
      await waitForRoleDetail();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Add plugin to role" }));
      });
      const installPanel = await screen.findByText("Install plugin for this Role (project-scope)");
      const panelContainer = installPanel.parentElement;
      if (!panelContainer) throw new Error("Install panel missing");

      await act(async () => {
        fireEvent.click(within(panelContainer).getByRole("button", { name: "Install" }));
      });

      await waitFor(() => {
        expect(installBodies).toContainEqual({
          scope: "project",
          cwd: `/home/.adam/roles/${mockRoleData.name}`,
        });
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Add plugin to role" }));
      });
      expect(await screen.findByText("No plugins available to install. Install plugins from a marketplace first.")).toBeInTheDocument();
    });

    it("uninstalls a project plugin with matching scope body", async () => {
      const uninstallBodies: unknown[] = [];
      let plugins = [
        {
          id: "dev-workflow@indie",
          version: "2.18.0",
          scope: "user",
          installPath: "/home/.claude/plugins/cache/dev-workflow",
          enabled: true,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          globalEnabled: true,
        },
        {
          id: "test-plugin@proj",
          version: "1.0.0",
          scope: "project",
          projectPath: `/home/.adam/roles/${mockRoleData.name}`,
          installPath: "/test/plugin",
          enabled: true,
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          globalEnabled: true,
        },
      ];

      server.use(
        http.get("/roles", () => HttpResponse.json({
          roles: [
            {
              id: "role-001",
              name: "Engineer",
              workspacePath: `/home/.adam/roles/${mockRoleData.name}`,
            },
          ],
        })),
        http.get("/plugins", () => HttpResponse.json({ plugins })),
        http.post("/plugins/uninstall/:id", async ({ request, params }) => {
          const body = await request.json();
          uninstallBodies.push(body);
          const pluginId = decodeURIComponent(String(params.id));
          plugins = plugins.filter((plugin) => !(plugin.id === pluginId && plugin.projectPath === body.cwd));
          return HttpResponse.json({ success: true });
        }),
      );

      renderRoleDetail();
      await waitForRoleDetail();
      expect(await screen.findByText("test-plugin")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
      });

      await waitFor(() => {
        expect(uninstallBodies).toContainEqual({
          scope: "project",
          cwd: `/home/.adam/roles/${mockRoleData.name}`,
        });
        expect(screen.getByText("This Role uses the user-scope defaults")).toBeInTheDocument();
      });
    });
  });

  describe("AdditionalDirectoriesCard section", () => {
    it("renders empty state when no directories configured", async () => {
      renderRoleDetail();
      await waitForRoleDetail();
      expect(await screen.findByText("Additional Directories", undefined, { timeout: 15000 })).toBeInTheDocument();

      expect(screen.getByText("No additional directories configured.")).toBeInTheDocument();
    });

    it("renders directory entries with inheritance toggles", async () => {
      server.use(
        http.get("/roles/:id", () =>
          HttpResponse.json({
            role: {
              ...mockRoleData,
              additionalDirectories: [
                { path: "/Users/example/Projects/foo", inheritPlugins: true, inheritMcp: false, inheritPermissions: false },
                { path: "/var/data/bar" },
              ],
            },
            projectPlugins: [],
          }),
        ),
      );

      renderRoleDetail();
      await waitForRoleDetail();
      expect(await screen.findByText("Additional Directories", undefined, { timeout: 15000 })).toBeInTheDocument();
      expect(await screen.findByText("/Users/example/Projects/foo", undefined, { timeout: 15000 })).toBeInTheDocument();
      expect(await screen.findByText("/var/data/bar", undefined, { timeout: 15000 })).toBeInTheDocument();

      // Each directory entry has 3 inheritance toggles: Plugins, MCP, Permissions
      expect(screen.getAllByText("Plugins").length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText("MCP").length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText("Permissions").length).toBeGreaterThanOrEqual(2);
    });

    it("shows Add Directory button and input when clicked", async () => {
      renderRoleDetail();
      await waitForRoleDetail();
      expect(await screen.findByText("Additional Directories", undefined, { timeout: 15000 })).toBeInTheDocument();

      const addButton = screen.getByRole("button", { name: /Add Directory/i });
      await act(async () => { await addButton.click(); });

      expect(screen.getByPlaceholderText("/absolute/path/to/directory")).toBeInTheDocument();
    });

    it("rejects relative paths in the Add Directory input", async () => {
      vi.mock("sonner", () => ({
        toast: { success: vi.fn(), error: vi.fn() },
      }));

      renderRoleDetail();
      await waitForRoleDetail();
      expect(await screen.findByText("Additional Directories", undefined, { timeout: 15000 })).toBeInTheDocument();

      const addButton = screen.getByRole("button", { name: /Add Directory/i });
      await act(async () => { await addButton.click(); });

      const input = screen.getByPlaceholderText("/absolute/path/to/directory");
      await act(async () => {
        await import("@testing-library/user-event").then((ue) =>
          ue.default.type(input, "relative/path"),
        );
      });

      // Attempt to add (press Add button nearest to the directory input)
      const dirInput = screen.getByPlaceholderText("/absolute/path/to/directory");
      const addConfirmButton = dirInput.closest("div")?.querySelector("button")
        ?? screen.getAllByRole("button", { name: "Add" })[0];
      await act(async () => { await (addConfirmButton as HTMLElement).click(); });

      // The card stays open with the input still visible (relative path rejected)
      expect(screen.getByPlaceholderText("/absolute/path/to/directory")).toBeInTheDocument();
    });
  });

  describe("LearnedRulesSection — three-section render", () => {
    it("renders all three subsection headings", async () => {
      renderRoleDetail();
      await waitForRoleDetail();
      expect(await screen.findByText("风格偏好", undefined, { timeout: 15000 })).toBeInTheDocument();
      expect(screen.getByText("应避免的操作")).toBeInTheDocument();
      expect(screen.getByText("固定参数")).toBeInTheDocument();
    });

    it("renders pinned parameter rows with tool name and params", async () => {
      const roleWithPin: Role = {
        ...mockRoleData,
        learnedRules: {
          stylePreferences: [],
          avoidedActions: [],
          pinnedParameters: [{ tool: "Bash:generate_voice.sh", params: { "-v": "male-qn-qing-xx" }, pinnedAt: 1234567890000 }],
        },
      };
      server.use(
        http.get("/roles/:id", () =>
          HttpResponse.json({
            role: roleWithPin,
            workspacePath: `/home/.adam/roles/${mockRoleData.name}`,
            projectPlugins: [],
          }),
        ),
      );
      renderRoleDetail();
      await waitForRoleDetail();
      expect(await screen.findByText("Bash:generate_voice.sh", undefined, { timeout: 15000 })).toBeInTheDocument();
      expect(screen.getByText("-v")).toBeInTheDocument();
      // Component renders params via JSON.stringify, so string values are wrapped in quotes
      expect(screen.getByText('"male-qn-qing-xx"')).toBeInTheDocument();
    });

    it("edit button opens inline edit form", async () => {
      const roleWithPin: Role = {
        ...mockRoleData,
        learnedRules: {
          stylePreferences: [],
          avoidedActions: [],
          pinnedParameters: [{ tool: "Bash:test.sh", params: { "-x": "1" }, pinnedAt: 1234567890000 }],
        },
      };
      server.use(
        http.get("/roles/:id", () =>
          HttpResponse.json({
            role: roleWithPin,
            workspacePath: `/home/.adam/roles/${mockRoleData.name}`,
            projectPlugins: [],
          }),
        ),
      );
      renderRoleDetail();
      await waitForRoleDetail();
      expect(await screen.findByText("Bash:test.sh", undefined, { timeout: 15000 })).toBeInTheDocument();
      // Multiple "Edit" buttons exist (CAG prompt edit + pin edit). Pick the last one
      // which is inside the pinned parameter row (CAG edit appears earlier in the DOM).
      await act(async () => {
        const editButtons = screen.getAllByRole("button", { name: "Edit" });
        fireEvent.click(editButtons[editButtons.length - 1]);
      });
      await waitFor(() => {
        expect(screen.getByText("Tool pattern")).toBeInTheDocument();
      });
    });

    it("Add Pin button opens empty inline edit form", async () => {
      renderRoleDetail();
      await waitForRoleDetail();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Add Pin" }));
      });
      await waitFor(() => {
        expect(screen.getByText("Tool pattern")).toBeInTheDocument();
      });
    });
  });
});
