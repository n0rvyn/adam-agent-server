import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "../utils/test-utils";
import { Work } from "@/pages/Work";
import { useAppStore } from "@/store/useAppStore";
import { mockTemplates, mockTasks, mockGoals } from "../fixtures";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe("Work", () => {
  beforeEach(() => {
    useAppStore.setState({
      tasks: mockTasks,
      templates: mockTemplates,
      goals: mockGoals,
      fetchTasks: vi.fn().mockResolvedValue(undefined),
      fetchTemplates: vi.fn().mockResolvedValue(undefined),
      fetchGoals: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("renders page title", () => {
    render(<Work />);
    expect(screen.getByText("Work")).toBeInTheDocument();
  });

  it("renders all three tab triggers", () => {
    render(<Work />);
    expect(screen.getByRole("tab", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Automations" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Goals" })).toBeInTheDocument();
  });

  it("prefetches tasks, templates, and goals for the header rail", () => {
    const fetchTasks = vi.fn().mockResolvedValue(undefined);
    const fetchTemplates = vi.fn().mockResolvedValue(undefined);
    const fetchGoals = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      fetchTasks,
      fetchTemplates,
      fetchGoals,
    });

    render(<Work />);

    expect(fetchTasks).toHaveBeenCalled();
    expect(fetchTemplates).toHaveBeenCalled();
    expect(fetchGoals).toHaveBeenCalled();
  });

  it("defaults to Tasks tab", () => {
    render(<Work />);
    const tasksTab = screen.getByRole("tab", { name: "Tasks" });
    expect(tasksTab).toHaveAttribute("data-state", "active");
  });

  it("renders Automations tab trigger", () => {
    render(<Work />);
    const tab = screen.getByRole("tab", { name: "Automations" });
    expect(tab).toBeInTheDocument();
    // Radix Tabs use data-state for active/inactive
    expect(tab).toHaveAttribute("data-state");
  });

  it("renders Goals tab trigger", () => {
    render(<Work />);
    const tab = screen.getByRole("tab", { name: "Goals" });
    expect(tab).toBeInTheDocument();
    expect(tab).toHaveAttribute("data-state");
  });
});
