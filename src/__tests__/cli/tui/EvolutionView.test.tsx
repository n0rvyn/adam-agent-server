// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { waitForRender, waitForInputReady } from "../../helpers/tui.js";

vi.mock("../../../cli/client.js", () => ({
  request: vi.fn(),
}));

import { request } from "../../../cli/client.js";
import { EvolutionView } from "../../../cli/tui/components/EvolutionView.js";

const mockRequest = request as ReturnType<typeof vi.fn>;

describe("EvolutionView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state initially", () => {
    mockRequest.mockImplementation(() => new Promise(() => {}));
    const { lastFrame } = render(<EvolutionView onBack={vi.fn()} />);
    expect(lastFrame()).toContain("Loading evolution log...");
  });

  it("shows error state when request fails", async () => {
    mockRequest.mockRejectedValue(new Error("Server error"));
    const { lastFrame } = render(<EvolutionView onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("Server error");
    expect(lastFrame()).toContain("Press Esc to go back");
  });

  it("shows empty state when no records", async () => {
    mockRequest.mockResolvedValue([]);
    const { lastFrame } = render(<EvolutionView onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("No evolution records yet");
  });

  it("displays evolution records with diff", async () => {
    const records = [
      {
        id: "evo-1", timestamp: Date.now(),
        diff: "+added rule\n-removed rule\n context line",
        triggerTaskId: "task-abc-12345678",
      },
    ];
    mockRequest.mockResolvedValue(records);
    const { lastFrame } = render(<EvolutionView onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;
    expect(frame).toContain("Evolution Audit Log (1 records)");
    expect(frame).toContain("+added rule");
    expect(frame).toContain("-removed rule");
    expect(frame).toContain("context line");
    expect(frame).toContain("Task: task-abc");
  });

  it("displays record without triggerTaskId", async () => {
    const records = [
      { id: "evo-2", timestamp: Date.now(), diff: "+new rule" },
    ];
    mockRequest.mockResolvedValue(records);
    const { lastFrame } = render(<EvolutionView onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).not.toContain("Task:");
    expect(lastFrame()).toContain("+new rule");
  });

  it("calls onBack when Escape is pressed", async () => {
    mockRequest.mockResolvedValue([]);
    const onBack = vi.fn();
    const { stdin } = render(<EvolutionView onBack={onBack} />);
    await waitForInputReady();
    stdin.write("\x1B");
    expect(onBack).toHaveBeenCalled();
  });

  it("calls onBack when q is pressed", async () => {
    mockRequest.mockResolvedValue([]);
    const onBack = vi.fn();
    const { stdin } = render(<EvolutionView onBack={onBack} />);
    await waitForInputReady();
    stdin.write("q");
    expect(onBack).toHaveBeenCalled();
  });
});
