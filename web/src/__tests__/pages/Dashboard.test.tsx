import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "../utils/test-utils";
import { Dashboard } from "@/pages/Dashboard";
import { useAppStore } from "@/store/useAppStore";
import { mockTasks, mockGoals, mockReadiness, mockRoles } from "../fixtures";

describe("Dashboard", () => {
  beforeEach(() => {
    // Override fetchRoles to avoid real API calls (MSW handlers don't cover detail endpoints)
    useAppStore.setState({
      tasks: mockTasks,
      goals: mockGoals,
      readiness: mockReadiness,
      stats: { activeTasks: 1, queuedTasks: 2, totalCostToday: 0.19 },
      roles: [],
      executionPool: { active: 2, max: 3, queued: 1 },
      fetchRoles: async () => {
        // Return empty roles without making real API calls
        useAppStore.setState({ roles: [] });
      },
    });
  });

  it("should render page title", () => {
    render(<Dashboard />);
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
  });

  it("should display server status badge", () => {
    render(<Dashboard />);
    expect(screen.getByText("Server Ready")).toBeInTheDocument();
  });

  it("should render stat cards with correct labels", () => {
    render(<Dashboard />);
    expect(screen.getByText("Active Tasks")).toBeInTheDocument();
    expect(screen.getByText("Role Health")).toBeInTheDocument();
    expect(screen.getByText("Cost Today")).toBeInTheDocument();
  });

  it("should render Execution Pool value in PageHeader", () => {
    render(<Dashboard />);
    // executionPool is { active: 2, max: 3, queued: 1 }
    expect(screen.getByText("2/3 | 1 queued")).toBeInTheDocument();
  });

  it("should render goals metric in PageHeader", () => {
    render(<Dashboard />);
    expect(screen.getByText("Goals")).toBeInTheDocument();
  });

  it("should render Failed stat card with danger color", () => {
    render(<Dashboard />);
    // mockTasks contains a failed task
    expect(screen.getByText("Failed")).toBeInTheDocument();
    const failedCard = screen.getByText("Failed").closest(".surface-panel-muted");
    expect(failedCard).not.toBeNull();
  });

  it("should render recent tasks section with View all link", () => {
    render(<Dashboard />);
    expect(screen.getByText("Recent Tasks")).toBeInTheDocument();
    expect(screen.getByText("View all")).toBeInTheDocument();
  });

  it("should render system checks", () => {
    render(<Dashboard />);
    expect(screen.getByText("System Checks")).toBeInTheDocument();
    expect(screen.getByText("database")).toBeInTheDocument();
    expect(screen.getByText("config")).toBeInTheDocument();
  });

  it("should show task status badges in recent tasks table", () => {
    render(<Dashboard />);
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("hero uses surface-critical when a task is failed", () => {
    const now = Date.now();
    useAppStore.setState({
      tasks: [
        { id: "t-fail", status: "failed", prompt: "Broken pipeline", createdAt: now, roleId: null, costUsd: 0 },
        { id: "t-run", status: "running", prompt: "Still executing", createdAt: now - 1000, roleId: null, costUsd: 0 },
      ] as never,
    });
    const { container } = render(<Dashboard />);
    const hero = container.querySelector(".surface-critical");
    expect(hero).not.toBeNull();
    expect(container.querySelector(".surface-accent.text-white")).toBeNull();
    expect(screen.getByRole("link", { name: "Open task" })).toHaveAttribute("href", "/tasks/t-fail");
  });

  it("hero uses surface-accent when a task is running and none failed", () => {
    const now = Date.now();
    useAppStore.setState({
      tasks: [
        { id: "t-run", status: "running", prompt: "In flight", createdAt: now, roleId: null, costUsd: 0 },
        { id: "t-done", status: "completed", prompt: "Done", createdAt: now - 1000, roleId: null, costUsd: 0 },
      ] as never,
    });
    const { container } = render(<Dashboard />);
    expect(container.querySelector(".surface-accent")).not.toBeNull();
    expect(container.querySelector(".surface-critical")).toBeNull();
  });

  it("hero uses surface-panel-muted with idle copy when tasks are empty", () => {
    useAppStore.setState({ tasks: [] as never });
    const { container } = render(<Dashboard />);
    expect(container.querySelector(".surface-panel-muted")).not.toBeNull();
    expect(screen.getByText(/Queue work, review recent runs, or launch an automation\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open work" })).toHaveAttribute("href", "/work");
  });

  it("hero chooses the newest failed task deterministically", () => {
    const now = Date.now();
    useAppStore.setState({
      tasks: [
        { id: "t-old-fail", status: "failed", prompt: "Old failed task", createdAt: now - 2_000, roleId: null, costUsd: 0 },
        { id: "t-new-fail", status: "failed", prompt: "Newest failed task", createdAt: now, roleId: null, costUsd: 0 },
        { id: "t-run", status: "running", prompt: "Running task", createdAt: now - 1_000, roleId: null, costUsd: 0 },
      ] as never,
    });
    render(<Dashboard />);
    expect(screen.getByRole("heading", { name: "Newest failed task" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Old failed task" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open task" })).toHaveAttribute("href", "/tasks/t-new-fail");
  });
});
