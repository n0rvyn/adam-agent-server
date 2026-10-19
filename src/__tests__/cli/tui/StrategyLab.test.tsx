// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { waitForRender, waitForInputReady } from "../../helpers/tui.js";

vi.mock("../../../cli/client.js", () => ({
  request: vi.fn(),
}));

import { request } from "../../../cli/client.js";
import { StrategyLab } from "../../../cli/tui/components/StrategyLab.js";

const mockRequest = request as ReturnType<typeof vi.fn>;

describe("StrategyLab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows empty state when no strategies", async () => {
    mockRequest.mockResolvedValue({ strategies: [] });
    const { lastFrame } = render(<StrategyLab onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("No strategies yet");
  });

  it("handles null strategies in response", async () => {
    mockRequest.mockResolvedValue({ strategies: null });
    const { lastFrame } = render(<StrategyLab onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("No strategies yet");
  });

  it("shows error state when request fails", async () => {
    mockRequest.mockRejectedValue(new Error("API error"));
    const { lastFrame } = render(<StrategyLab onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("Failed to load strategies");
    expect(lastFrame()).toContain("API error");
  });

  it("displays strategies grouped by role/taskType", async () => {
    const strategies = [
      { id: "s1", role: "dev", taskType: "code", name: "Fast Code", alpha: 8, beta: 2, totalTrials: 10, avgReward: 0.8 },
      { id: "s2", role: "dev", taskType: "code", name: "Slow Code", alpha: 3, beta: 7, totalTrials: 10, avgReward: 0.3 },
      { id: "s3", role: "tester", taskType: "test", name: "Test Strategy", alpha: 5, beta: 5, totalTrials: 10 },
    ];
    mockRequest.mockResolvedValue({ strategies });
    const { lastFrame } = render(<StrategyLab onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;
    expect(frame).toContain("Strategy Lab");
    expect(frame).toContain("dev/code");
    expect(frame).toContain("tester/test");
    expect(frame).toContain("Fast Code");
    expect(frame).toContain("Slow Code");
    expect(frame).toContain("Test Strategy");
    // Fast Code mean: 8/(8+2) = 80%
    expect(frame).toContain("80%");
    // Slow Code mean: 3/(3+7) = 30%
    expect(frame).toContain("30%");
  });

  it("sorts strategies by sampling probability descending", async () => {
    const strategies = [
      { id: "s1", role: "r", taskType: "t", name: "Low", alpha: 2, beta: 8, totalTrials: 10 },
      { id: "s2", role: "r", taskType: "t", name: "High", alpha: 9, beta: 1, totalTrials: 10 },
    ];
    mockRequest.mockResolvedValue({ strategies });
    const { lastFrame } = render(<StrategyLab onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;
    const highIdx = frame.indexOf("High");
    const lowIdx = frame.indexOf("Low");
    expect(highIdx).toBeLessThan(lowIdx); // High should appear first
  });

  it("calls onBack when Escape is pressed", async () => {
    mockRequest.mockResolvedValue({ strategies: [] });
    const onBack = vi.fn();
    const { stdin } = render(<StrategyLab onBack={onBack} />);
    await waitForInputReady();
    stdin.write("\x1B");
    expect(onBack).toHaveBeenCalled();
  });

  it("calls onBack when q is pressed", async () => {
    mockRequest.mockResolvedValue({ strategies: [] });
    const onBack = vi.fn();
    const { stdin } = render(<StrategyLab onBack={onBack} />);
    await waitForInputReady();
    stdin.write("q");
    expect(onBack).toHaveBeenCalled();
  });
});
