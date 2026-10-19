// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { waitForRender, waitForInputReady } from "../../helpers/tui.js";

vi.mock("../../../cli/client.js", () => ({
  request: vi.fn(),
}));

import { request } from "../../../cli/client.js";
import { TaskList } from "../../../cli/tui/components/TaskList.js";

const mockRequest = request as ReturnType<typeof vi.fn>;

describe("TaskList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state initially", () => {
    mockRequest.mockImplementation(() => new Promise(() => {}));
    const { lastFrame } = render(<TaskList onBack={vi.fn()} />);
    expect(lastFrame()).toContain("Loading tasks...");
  });

  it("shows empty state when no tasks", async () => {
    mockRequest.mockResolvedValue({ tasks: [] });
    const { lastFrame } = render(<TaskList onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("No tasks found");
  });

  it("displays task table with data", async () => {
    const tasks = [
      { id: "task-001-abcdef", status: "completed", prompt: "Write tests", createdAt: Date.now(), totalDurationMs: 5000, costUsd: 0.01 },
      { id: "task-002-abcdef", status: "running", prompt: "Deploy app", createdAt: Date.now() },
    ];
    mockRequest.mockResolvedValue({ tasks });
    const { lastFrame } = render(<TaskList onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;
    expect(frame).toContain("task-001");
    expect(frame).toContain("COMPLETED");
    expect(frame).toContain("Write tests");
    expect(frame).toContain("5s");
    expect(frame).toContain("$0.0100");
    expect(frame).toContain("task-002");
    expect(frame).toContain("RUNNING");
  });

  it("shows dash for missing duration and cost", async () => {
    const tasks = [
      { id: "task-003-abcdef", status: "pending", prompt: "Wait", createdAt: Date.now() },
    ];
    mockRequest.mockResolvedValue({ tasks });
    const { lastFrame } = render(<TaskList onBack={vi.fn()} />);
    await waitForRender();
    // Duration and cost should show "—" when undefined
    expect(lastFrame()).toContain("—");
  });

  it("handles request error gracefully", async () => {
    mockRequest.mockRejectedValue(new Error("Network error"));
    const { lastFrame } = render(<TaskList onBack={vi.fn()} />);
    await waitForRender();
    // On error, loading becomes false and tasks is empty
    expect(lastFrame()).toContain("No tasks found");
  });

  it("calls onBack when Escape is pressed", async () => {
    mockRequest.mockResolvedValue({ tasks: [] });
    const onBack = vi.fn();
    const { stdin } = render(<TaskList onBack={onBack} />);
    await waitForInputReady();
    stdin.write("\x1B");
    expect(onBack).toHaveBeenCalled();
  });

  it("calls onBack when q is pressed", async () => {
    mockRequest.mockResolvedValue({ tasks: [] });
    const onBack = vi.fn();
    const { stdin } = render(<TaskList onBack={onBack} />);
    await waitForInputReady();
    stdin.write("q");
    expect(onBack).toHaveBeenCalled();
  });

  it("truncates long prompts", async () => {
    const tasks = [
      { id: "task-004-abcdef", status: "running", prompt: "A".repeat(120), createdAt: Date.now() },
    ];
    mockRequest.mockResolvedValue({ tasks });
    const { lastFrame } = render(<TaskList onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("...");
  });

  it("uses fallback color for unknown status", async () => {
    const tasks = [
      { id: "task-005-abcdef", status: "unknown_status", prompt: "Test", createdAt: Date.now() },
    ];
    mockRequest.mockResolvedValue({ tasks });
    const { lastFrame } = render(<TaskList onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("UNKNOWN_STATUS");
  });

  it("shows preview guidance for the selected task", async () => {
    mockRequest.mockResolvedValue({ tasks: [{ id: "t1", status: "running", prompt: "test", createdAt: Date.now() }] });
    const { lastFrame } = render(<TaskList onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;
    expect(frame).toContain("Preview");
    expect(frame).toContain("Enter opens full detail");
  });

  it("shows selection indicator", async () => {
    mockRequest.mockResolvedValue({ tasks: [{ id: "t1", status: "running", prompt: "test", createdAt: Date.now() }] });
    const { lastFrame } = render(<TaskList onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("❯ ");
  });

  it("enters filter mode when f is pressed", async () => {
    mockRequest.mockResolvedValue({ tasks: [{ id: "t1", status: "running", prompt: "test", createdAt: Date.now() }] });
    const { lastFrame, stdin } = render(<TaskList onBack={vi.fn()} />);
    await waitForInputReady();
    stdin.write("f");
    await waitForRender();
    const frame = lastFrame()!;
    expect(frame).toContain("Filter by status");
    expect(frame).toContain("all");
    expect(frame).toContain("running");
    expect(frame).toContain("completed");
  });

  it("shows cancel confirmation when x is pressed on cancellable task", async () => {
    mockRequest.mockResolvedValue({ tasks: [{ id: "t1", status: "running", prompt: "test", createdAt: Date.now() }] });
    const { lastFrame, stdin } = render(<TaskList onBack={vi.fn()} />);
    await waitForInputReady();
    stdin.write("x");
    await waitForRender();
    expect(lastFrame()).toContain("Cancel task");
    expect(lastFrame()).toContain("(y/n)");
  });

  it("shows message when trying to cancel non-cancellable task", async () => {
    mockRequest.mockResolvedValue({ tasks: [{ id: "t1", status: "completed", prompt: "test", createdAt: Date.now() }] });
    const { lastFrame, stdin } = render(<TaskList onBack={vi.fn()} />);
    await waitForInputReady();
    stdin.write("x");
    await waitForRender();
    expect(lastFrame()).toContain("Cannot cancel task in status");
  });

  it("enters detail view when Enter is pressed", async () => {
    const taskData = {
      id: "task-detail-123", status: "completed", prompt: "Write tests for everything",
      createdAt: Date.now() - 60000, completedAt: Date.now(), totalDurationMs: 5000,
      costUsd: 0.05, numTurns: 3, tokenUsage: { input: 1000, output: 500 },
    };
    mockRequest
      .mockResolvedValueOnce({ tasks: [taskData] })
      .mockResolvedValueOnce({ task: taskData })
      .mockResolvedValueOnce({ plans: [] })
      .mockResolvedValueOnce({ logs: [] });
    const { lastFrame, stdin } = render(<TaskList onBack={vi.fn()} />);
    await waitForInputReady();
    stdin.write("\r");
    await waitForRender();
    const frame = lastFrame()!;
    expect(frame).toContain("Task task-det");
    expect(frame).toContain("COMPLETED");
    expect(frame).toContain("Write tests for everything");
  });

  it("shows page info", async () => {
    mockRequest.mockResolvedValue({ tasks: [{ id: "t1", status: "running", prompt: "test", createdAt: Date.now() }] });
    const { lastFrame } = render(<TaskList onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("Page 1/1");
  });
});
