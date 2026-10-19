import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor, within } from "../utils/test-utils";
import { Plugins } from "@/pages/Plugins";
import { server } from "../msw/server";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function setupPluginState() {
  const roles = [
    { id: "role-001", name: "Engineer", workspacePath: "/work/engineer" },
    { id: "role-002", name: "Reviewer", workspacePath: "/work/reviewer" },
  ];

  let plugins = [
    {
      id: "dev-workflow@indie",
      version: "1.2.0",
      scope: "user",
      installPath: "/plugins/dev-workflow",
      enabled: true,
      installedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      globalEnabled: true,
      manifest: {
        name: "dev-workflow",
        version: "1.2.0",
        description: "Workflow helper",
        skills: [{ name: "commit", description: "Commit helper" }],
        agents: [],
        mcpServers: [],
        hooks: [],
        lspServers: [],
      },
    },
    {
      id: "review-helper@indie",
      version: "1.0.0",
      scope: "project",
      projectPath: "/work/reviewer",
      installPath: "/work/reviewer/plugins/review-helper",
      enabled: true,
      installedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      globalEnabled: true,
      manifest: {
        name: "review-helper",
        version: "1.0.0",
        description: "Review helper",
        skills: [],
        agents: [],
        mcpServers: [],
        hooks: [],
        lspServers: [],
      },
    },
  ];

  const installBodies: unknown[] = [];
  const uninstallBodies: unknown[] = [];

  server.use(
    http.get("/plugins", () => HttpResponse.json({ plugins })),
    http.get("/roles", () => HttpResponse.json({ roles })),
    http.get("/plugins/marketplace", () => HttpResponse.json({
      available: [
        {
          pluginId: "cool-plugin@mkt",
          name: "cool-plugin",
          description: "A cool plugin",
          marketplaceName: "mkt",
          source: { source: "url", url: "https://example.com" },
        },
      ],
      installed: [{ id: "dev-workflow@indie" }],
    })),
    http.get("/plugins/marketplaces", () => HttpResponse.json({
      sources: [
        {
          name: "claude-plugins-official",
          source: "github",
          repo: "anthropics/claude-plugins-official",
          installLocation: "~/.claude/plugins",
        },
      ],
    })),
    http.post("/plugins/install/:id", async ({ params, request }) => {
      const body = await request.json();
      installBodies.push(body);
      const pluginId = decodeURIComponent(String(params.id));
      const source = plugins.find((plugin) => plugin.id === pluginId);
      if (source && body && typeof body === "object" && "scope" in body && body.scope === "project") {
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
    http.post("/plugins/uninstall/:id", async ({ params, request }) => {
      const pluginId = decodeURIComponent(String(params.id));
      const body = await request.json().catch(() => undefined);
      uninstallBodies.push(body);
      if (body && typeof body === "object" && "scope" in body && body.scope === "project") {
        plugins = plugins.filter((plugin) => !(plugin.id === pluginId && plugin.projectPath === body.cwd));
      } else {
        plugins = plugins.filter((plugin) => plugin.id !== pluginId);
      }
      return HttpResponse.json({ success: true });
    }),
  );

  return { roles, installBodies, uninstallBodies };
}

describe("Plugins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders installed and marketplace tabs with user and project sections", async () => {
    setupPluginState();
    render(<Plugins />);

    expect(screen.getByRole("tab", { name: /Installed/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Marketplace/ })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("User scope")).toBeInTheDocument();
      expect(screen.getByText("Project scope")).toBeInTheDocument();
      expect(screen.getByText("dev-workflow")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Reviewer" })).toBeInTheDocument();
      expect(screen.getByText("review-helper")).toBeInTheDocument();
    });
  });

  it("switches tabs so installed and marketplace content are mutually exclusive", async () => {
    setupPluginState();
    const user = userEvent.setup();
    render(<Plugins />);

    await screen.findByText("User scope");
    await user.click(screen.getByRole("tab", { name: /Marketplace/ }));

    await waitFor(() => {
      expect(screen.queryByText("User scope")).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText("Search available plugins...")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("tab", { name: /Installed/ }));

    await waitFor(() => {
      expect(screen.getByText("User scope")).toBeInTheDocument();
      expect(screen.queryByPlaceholderText("Search available plugins...")).not.toBeInTheDocument();
    });
  });

  it("installs a user-scope plugin to a selected role from the row dropdown", async () => {
    const { roles, installBodies } = setupPluginState();
    const user = userEvent.setup();
    render(<Plugins />);

    await screen.findByText("dev-workflow");
    await user.click(screen.getByRole("button", { name: /Manage dev-workflow/i }));
    await user.click(await screen.findByRole("menuitem", { name: "Engineer" }));

    await waitFor(() => {
      expect(installBodies).toContainEqual({ scope: "project", cwd: roles[0].workspacePath });
      expect(screen.getByRole("button", { name: "1 Role" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Engineer" })).not.toBeInTheDocument();
    });
  });

  it("uninstalls a role plugin from the project section and refreshes the grouped view", async () => {
    const { roles, uninstallBodies } = setupPluginState();
    const user = userEvent.setup();
    render(<Plugins />);

    const reviewerSection = await waitFor(() => {
      const section = screen.getByRole("heading", { name: "Reviewer" }).closest("section");
      if (!section) throw new Error("Reviewer section missing");
      return section;
    });

    await user.click(within(reviewerSection).getByRole("button", { name: "Uninstall" }));

    await waitFor(() => {
      expect(uninstallBodies).toContainEqual({ scope: "project", cwd: roles[1].workspacePath });
      expect(screen.queryByRole("heading", { name: "Reviewer" })).not.toBeInTheDocument();
      expect(screen.queryByText("review-helper")).not.toBeInTheDocument();
    });
  });
});
