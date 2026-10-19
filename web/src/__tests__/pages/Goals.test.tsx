import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "../utils/test-utils";
import { Goals } from "@/pages/Goals";
import { useAppStore } from "@/store/useAppStore";
import { mockGoals } from "../fixtures";

describe("Goals", () => {
  beforeEach(() => {
    useAppStore.setState({ goals: mockGoals });
  });

  it("should render page title", () => {
    render(<Goals />);
    expect(screen.getByRole("heading", { level: 1, name: "Goals" })).toBeInTheDocument();
  });

  it("should render New Goal button", () => {
    render(<Goals />);
    expect(screen.getByText("New Goal")).toBeInTheDocument();
  });

  it("should render goal cards", () => {
    render(<Goals />);
    expect(screen.getByText("Complete 50 tasks this week")).toBeInTheDocument();
    expect(screen.getByText("Reduce latency to under 100ms")).toBeInTheDocument();
  });

  it("should show goal status badges", () => {
    render(<Goals />);
    // Both mock goals have "active" status
    expect(screen.getAllByText("active").length).toBeGreaterThanOrEqual(2);
  });

  it("should show progress percentage", () => {
    render(<Goals />);
    // 32/50 = 64%
    expect(screen.getByText("64%")).toBeInTheDocument();
  });

  it("should show goal metadata labels", () => {
    render(<Goals />);
    expect(screen.getAllByText("Role").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Budget").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Deadline").length).toBeGreaterThan(0);
  });

  it("should open create form when New Goal clicked", () => {
    render(<Goals />);
    fireEvent.click(screen.getByText("New Goal"));
    expect(
      screen.getByPlaceholderText("Describe your goal in natural language..."),
    ).toBeInTheDocument();
    expect(screen.getByText("Create")).toBeInTheDocument();
  });

  it("should show empty state when no goals", () => {
    useAppStore.setState({ goals: [] });
    render(<Goals />);
    expect(screen.getByText("No goals")).toBeInTheDocument();
  });
});
