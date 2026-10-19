import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "../utils/test-utils";
import { Strategies } from "@/pages/Strategies";
import { useAppStore } from "@/store/useAppStore";
import { mockStrategies } from "../fixtures";

describe("Strategies", () => {
  beforeEach(() => {
    useAppStore.setState({ strategies: mockStrategies });
  });

  it("should render page title", () => {
    render(<Strategies />);
    expect(screen.getByRole("heading", { level: 1, name: "Strategies" })).toBeInTheDocument();
  });

  it("should render strategy table headers", () => {
    render(<Strategies />);
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Task Type")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Trials")).toBeInTheDocument();
    expect(screen.getByText("Avg Reward")).toBeInTheDocument();
  });

  it("should render strategy rows", () => {
    render(<Strategies />);
    expect(screen.getByText("Bug Fix Strategy v1")).toBeInTheDocument();
  });

  it("should group strategies by roleId", () => {
    render(<Strategies />);
    expect(screen.getByText("role-001")).toBeInTheDocument();
    expect(screen.getByText("1 strategies")).toBeInTheDocument();
  });

  it("should show strategy metrics", () => {
    render(<Strategies />);
    expect(screen.getByText("1.50")).toBeInTheDocument(); // alpha
    expect(screen.getByText("2.00")).toBeInTheDocument(); // beta
    expect(screen.getByText("100")).toBeInTheDocument(); // trials
    expect(screen.getByText("0.850")).toBeInTheDocument(); // avgReward
  });

  it("should show empty state when no strategies", () => {
    useAppStore.setState({ strategies: [] });
    render(<Strategies />);
    expect(screen.getByText("No strategies")).toBeInTheDocument();
  });
});
