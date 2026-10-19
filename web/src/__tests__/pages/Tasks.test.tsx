import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "../utils/test-utils";
import { Tasks } from "@/pages/Tasks";
import { useAppStore } from "@/store/useAppStore";
import { mockTasks } from "../fixtures";

describe("Tasks", () => {
  beforeEach(() => {
    useAppStore.setState({ tasks: mockTasks });
  });

  it("should render page title", () => {
    render(<Tasks />);
    expect(screen.getByText("Tasks")).toBeInTheDocument();
  });

  it("should render New Task button", () => {
    render(<Tasks />);
    expect(screen.getByText("New Task")).toBeInTheDocument();
  });

  it("should show status filter buttons", () => {
    render(<Tasks />);
    expect(screen.getByText("All")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("should render task table headers", () => {
    render(<Tasks />);
    expect(screen.getByText("ID")).toBeInTheDocument();
    expect(screen.getByText("Prompt")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Role")).toBeInTheDocument();
  });

  it("should show task rows with truncated IDs", () => {
    render(<Tasks />);
    // IDs are sliced to 8 chars: "task-001" -> "task-001"
    expect(screen.getByText("task-001")).toBeInTheDocument();
    expect(screen.getByText("task-003")).toBeInTheDocument();
  });

  it("should open create form when New Task clicked", () => {
    render(<Tasks />);
    fireEvent.click(screen.getByText("New Task"));
    expect(screen.getByPlaceholderText("Enter task prompt...")).toBeInTheDocument();
    expect(screen.getByText("Create")).toBeInTheDocument();
  });

  it("should show empty state when no tasks", () => {
    useAppStore.setState({ tasks: [] });
    render(<Tasks />);
    expect(screen.getByText("No tasks found")).toBeInTheDocument();
  });

  it("should filter tasks when status filter clicked", async () => {
    render(<Tasks />);
    // Initially shows all 5 tasks
    expect(screen.getByText("task-001")).toBeInTheDocument();

    // Click "Running" filter — MSW returns only running tasks
    fireEvent.click(screen.getByText("Running"));

    // After fetch completes, only running task should be shown
    await waitFor(() => {
      const tasks = useAppStore.getState().tasks;
      expect(tasks.every((t) => t.status === "running")).toBe(true);
    });
  });
});
