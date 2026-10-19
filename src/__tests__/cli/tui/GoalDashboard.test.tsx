// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { waitForRender, waitForInputReady } from "../../helpers/tui.js";

vi.mock("../../../cli/client.js", () => ({
  request: vi.fn(),
}));

import { request } from "../../../cli/client.js";
import { GoalDashboard } from "../../../cli/tui/components/GoalDashboard.js";

const mockRequest = request as ReturnType<typeof vi.fn>;

describe("GoalDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows empty state when no goals", async () => {
    mockRequest.mockResolvedValue({ goals: [] });
    const { lastFrame } = render(<GoalDashboard onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("No goals found");
  });

  it("shows error state when request fails", async () => {
    mockRequest.mockRejectedValue(new Error("Network error"));
    const { lastFrame } = render(<GoalDashboard onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("Failed to load goals");
    expect(lastFrame()).toContain("Network error");
  });

  it("displays goal cards with progress", async () => {
    const goals = [{
      id: "goal-001-abcdef", name: "Improve Coverage", status: "executing",
      role: "tester", metricType: "percent", targetValue: 90, currentValue: 60,
      deadline: Date.now() + 86400000 * 5, budgetUsd: 10,
    }];
    mockRequest.mockResolvedValue({ goals });
    const { lastFrame } = render(<GoalDashboard onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;
    expect(frame).toContain("Improve Coverage");
    expect(frame).toContain("tester");
    expect(frame).toContain("executing");
    expect(frame).toContain("67%"); // 60/90 ≈ 67%
    expect(frame).toContain("60/90 percent");
    expect(frame).toContain("goal-001");
    expect(frame).toContain("Goal Dashboard (1)");
  });

  it("shows 100% progress when target reached", async () => {
    const goals = [{
      id: "g2", name: "Done Goal", status: "completed",
      role: "dev", metricType: "count", targetValue: 10, currentValue: 10,
      deadline: Date.now(), budgetUsd: 5,
    }];
    mockRequest.mockResolvedValue({ goals });
    const { lastFrame } = render(<GoalDashboard onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("100%");
  });

  it("handles zero targetValue without division error", async () => {
    const goals = [{
      id: "g3", name: "Zero Goal", status: "pending",
      role: "x", metricType: "y", targetValue: 0, currentValue: 0,
      deadline: Date.now() + 86400000, budgetUsd: 0,
    }];
    mockRequest.mockResolvedValue({ goals });
    const { lastFrame } = render(<GoalDashboard onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("0%");
  });

  it("shows < 1d for deadline within 24 hours", async () => {
    const goals = [{
      id: "g4", name: "Urgent", status: "executing",
      role: "dev", metricType: "x", targetValue: 10, currentValue: 5,
      deadline: Date.now() + 3600000, budgetUsd: 1,
    }];
    mockRequest.mockResolvedValue({ goals });
    const { lastFrame } = render(<GoalDashboard onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("< 1d");
  });

  it("calls onBack when Escape is pressed", async () => {
    mockRequest.mockResolvedValue({ goals: [] });
    const onBack = vi.fn();
    const { stdin } = render(<GoalDashboard onBack={onBack} />);
    await waitForInputReady();
    stdin.write("\x1B");
    expect(onBack).toHaveBeenCalled();
  });

  it("calls onBack when q is pressed", async () => {
    mockRequest.mockResolvedValue({ goals: [] });
    const onBack = vi.fn();
    const { stdin } = render(<GoalDashboard onBack={onBack} />);
    await waitForInputReady();
    stdin.write("q");
    expect(onBack).toHaveBeenCalled();
  });

  it("shows keyboard hints including create", async () => {
    mockRequest.mockResolvedValue({ goals: [] });
    const { lastFrame } = render(<GoalDashboard onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("c:create");
  });

  it("enters create mode when c is pressed", async () => {
    mockRequest.mockResolvedValue({ goals: [] });
    const { lastFrame, stdin } = render(<GoalDashboard onBack={vi.fn()} />);
    await waitForInputReady();
    stdin.write("c");
    await waitForRender();
    expect(lastFrame()).toContain("Create Goal");
    expect(lastFrame()).toContain("SMART goal");
  });

  it("exits create mode on Escape", async () => {
    mockRequest.mockResolvedValue({ goals: [] });
    const { lastFrame, stdin } = render(<GoalDashboard onBack={vi.fn()} />);
    await waitForInputReady();
    stdin.write("c");
    await waitForRender();
    expect(lastFrame()).toContain("Create Goal");
    stdin.write("\x1B");
    await waitForRender();
    // Should be back to list mode showing empty state
    expect(lastFrame()).not.toContain("Create Goal");
  });
});
