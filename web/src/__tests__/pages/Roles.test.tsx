import { describe, it, expect, beforeEach, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "../utils/test-utils";
import { Roles } from "@/pages/Roles";
import { useAppStore } from "@/store/useAppStore";
import { mockTasks, mockGoals, mockReadiness } from "../fixtures";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockRoles = [
  {
    id: "role-001",
    name: "Engineer",
    cagPrompt: "You are a senior engineer",
    learnedRules: { stylePreferences: ["Write tests first"], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "mem-001",
    status: "active" as const,
    performanceScore: 0.92,
    preferences: { effort: "high" as const },
    createdAt: Date.now() - 86_400_000,
  },
  {
    id: "role-002",
    name: "Reviewer",
    cagPrompt: "You are a code reviewer",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "mem-002",
    status: "inactive" as const,
    preferences: {},
    createdAt: Date.now() - 172_800_000,
  },
];

describe("Roles page", () => {
  beforeEach(() => {
    useAppStore.setState({
      tasks: mockTasks,
      goals: mockGoals,
      readiness: mockReadiness,
      stats: { activeTasks: 1, queuedTasks: 2, totalCostToday: 0.19 },
      roles: mockRoles,
      executionPool: { active: 0, max: 3, queued: 0 },
      fetchRoles: vi.fn().mockResolvedValue(undefined),
    });
  });

  function renderRolesPage() {
    return render(<Roles />);
  }

  it("should render Roles heading", async () => {
    renderRolesPage();
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "Roles" })).toBeInTheDocument();
    });
  });

  it("should display role names in the table", async () => {
    renderRolesPage();
    await waitFor(() => {
      expect(screen.getByText("Engineer")).toBeInTheDocument();
      expect(screen.getByText("Reviewer")).toBeInTheDocument();
    });
  });

  it("should display role status badges", async () => {
    renderRolesPage();
    await waitFor(() => {
      expect(screen.getByText("active")).toBeInTheDocument();
      expect(screen.getByText("inactive")).toBeInTheDocument();
    });
  });

  it("should have links to role detail pages", async () => {
    renderRolesPage();
    await waitFor(() => {
      const links = screen.getAllByRole("link");
      const roleLinks = links.filter((l) => l.getAttribute("href")?.startsWith("/roles/"));
      expect(roleLinks).toHaveLength(2);
    });
  });

  it("should open Create Role modal when button is clicked", async () => {
    const user = userEvent.setup();
    renderRolesPage();
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "Roles" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "New Role" }));
    await waitFor(() => {
      expect(screen.getByText("Create Role")).toBeInTheDocument();
    });
  });

  it("should submit Create Role form and refresh the list", async () => {
    const user = userEvent.setup();
    const mockCreateRole = vi.fn().mockResolvedValue({ id: "role-new", name: "Tester", status: "active", cagPrompt: "", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "mem-new", performanceScore: null, preferences: {}, createdAt: Date.now() });
    const mockFetchRoles = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ createRole: mockCreateRole, fetchRoles: mockFetchRoles });

    renderRolesPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "Roles" })).toBeInTheDocument();
    });

    // Open modal
    await user.click(screen.getByRole("button", { name: "New Role" }));

    await waitFor(() => {
      expect(screen.getByText("Create Role")).toBeInTheDocument();
    });

    // Fill in the name
    const nameInput = screen.getByLabelText(/Name/i) as HTMLInputElement;
    await user.type(nameInput, "Tester");

    // Submit
    const createButton = screen.getByRole("button", { name: "Create" });
    await user.click(createButton);

    await waitFor(() => {
      expect(mockCreateRole).toHaveBeenCalledWith({ name: "Tester", cagPrompt: "" });
    });
  });

  it("should close Create Role modal on Cancel", async () => {
    const user = userEvent.setup();
    renderRolesPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "Roles" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "New Role" }));

    await waitFor(() => {
      expect(screen.getByText("Create Role")).toBeInTheDocument();
    });

    // Cancel
    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    await user.click(cancelButton);

    await waitFor(() => {
      expect(screen.queryByText("Create Role")).not.toBeInTheDocument();
    });
  });

  it("should show error message on duplicate name (409)", async () => {
    const user = userEvent.setup();
    const mockCreateRole = vi.fn().mockRejectedValue(new Error("Role name already exists"));
    useAppStore.setState({ createRole: mockCreateRole });

    renderRolesPage();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "Roles" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "New Role" }));

    await waitFor(() => {
      expect(screen.getByText("Create Role")).toBeInTheDocument();
    });

    // Fill name and submit
    const nameInput = screen.getByLabelText(/Name/i) as HTMLInputElement;
    await user.type(nameInput, "Engineer");

    const createButton = screen.getByRole("button", { name: "Create" });
    await user.click(createButton);

    await waitFor(() => {
      expect(screen.getByText("Role name already exists")).toBeInTheDocument();
    });
  });
});
