import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDispatch, mockRequest } = vi.hoisted(() => ({
  mockDispatch: vi.fn(),
  mockRequest: vi.fn(),
}));

vi.mock("../../../cli/tui/hooks/useTuiState.js", () => ({
  useTuiState: () => ({
    state: { connected: true },
    dispatch: mockDispatch,
  }),
}));

vi.mock("../../../cli/client.js", () => ({
  request: mockRequest,
}));

import { useServerConnection } from "../../../cli/tui/hooks/useServerConnection.js";

describe("useServerConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns connected state and submitPrompt", () => {
    const result = useServerConnection();
    expect(result.connected).toBe(true);
    expect(typeof result.submitPrompt).toBe("function");
  });

  it("submitPrompt dispatches SET_ACTIVE_TASK and TASK_SUBMITTED on success", async () => {
    mockRequest.mockResolvedValue({ taskId: "task-abc" });
    const { submitPrompt } = useServerConnection();
    const taskId = await submitPrompt("test prompt");

    expect(taskId).toBe("task-abc");
    expect(mockRequest).toHaveBeenCalledWith("/tasks", {
      method: "POST",
      body: { prompt: "test prompt" },
    });
    expect(mockDispatch).toHaveBeenCalledWith({ type: "SET_ACTIVE_TASK", taskId: "task-abc" });
    expect(mockDispatch).toHaveBeenCalledWith({ type: "TASK_SUBMITTED" });
  });

  it("submitPrompt returns null on request failure", async () => {
    mockRequest.mockRejectedValue(new Error("Network error"));
    const { submitPrompt } = useServerConnection();
    const taskId = await submitPrompt("test prompt");

    expect(taskId).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
