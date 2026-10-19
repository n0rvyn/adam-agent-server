import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRequest } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
}));

vi.mock("../../../cli/client.js", () => ({
  request: mockRequest,
}));

import { listTasksHandler, showTaskHandler, cancelTaskHandler } from "../../../cli/commands/tasks.js";

describe("tasks command", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exit = vi.fn() as never;
  });

  describe("listTasksHandler", () => {
    it("shows empty message when no tasks", async () => {
      mockRequest.mockResolvedValueOnce({ tasks: [] });
      await listTasksHandler({});
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No tasks found"));
    });

    it("displays tasks with all statuses", async () => {
      mockRequest.mockResolvedValueOnce({
        tasks: [
          { id: "id-12345678", status: "completed", prompt: "do something", createdAt: Date.now(), totalDurationMs: 5000, costUsd: 0.0123 },
          { id: "id-87654321", status: "running", prompt: "still running", createdAt: Date.now() },
          { id: "id-aaaabbbb", status: "failed", prompt: "broke", createdAt: Date.now(), totalDurationMs: 500 },
        ],
      });

      await listTasksHandler({});

      // Header line
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("ID"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("STATUS"));
    });

    it("passes status filter to API", async () => {
      mockRequest.mockResolvedValueOnce({ tasks: [] });
      await listTasksHandler({ status: "pending" });
      expect(mockRequest).toHaveBeenCalledWith("/tasks?status=pending");
    });

    it("passes limit parameter to API", async () => {
      mockRequest.mockResolvedValueOnce({ tasks: [] });
      await listTasksHandler({ limit: "5" });
      expect(mockRequest).toHaveBeenCalledWith("/tasks?limit=5");
    });

    it("passes both status and limit", async () => {
      mockRequest.mockResolvedValueOnce({ tasks: [] });
      await listTasksHandler({ status: "running", limit: "10" });
      expect(mockRequest).toHaveBeenCalledWith(expect.stringContaining("status=running"));
      expect(mockRequest).toHaveBeenCalledWith(expect.stringContaining("limit=10"));
    });

    it("handles no query params (no ? in URL)", async () => {
      mockRequest.mockResolvedValueOnce({ tasks: [] });
      await listTasksHandler({});
      expect(mockRequest).toHaveBeenCalledWith("/tasks");
    });

    it("handles API error", async () => {
      mockRequest.mockRejectedValueOnce(new Error("fetch failed"));
      await listTasksHandler({});
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("fetch failed"));
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it("shows dash for missing duration and cost", async () => {
      mockRequest.mockResolvedValueOnce({
        tasks: [
          { id: "id-12345678", status: "pending", prompt: "test", createdAt: Date.now() },
        ],
      });

      await listTasksHandler({});

      const calls = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const taskLine = calls.find((c: string) => c.includes("id-12345"));
      expect(taskLine).toContain("—");
    });

    it("truncates long prompts", async () => {
      const longPrompt = "a".repeat(100);
      mockRequest.mockResolvedValueOnce({
        tasks: [
          { id: "id-12345678", status: "pending", prompt: longPrompt, createdAt: Date.now() },
        ],
      });

      await listTasksHandler({});

      const calls = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const taskLine = calls.find((c: string) => c.includes("id-12345"));
      expect(taskLine).toContain("...");
    });

    it("formats duration correctly (ms, seconds, minutes)", async () => {
      mockRequest.mockResolvedValueOnce({
        tasks: [
          { id: "id-11111111", status: "completed", prompt: "t1", createdAt: Date.now(), totalDurationMs: 500 },
          { id: "id-22222222", status: "completed", prompt: "t2", createdAt: Date.now(), totalDurationMs: 5000 },
          { id: "id-33333333", status: "completed", prompt: "t3", createdAt: Date.now(), totalDurationMs: 125000 },
        ],
      });

      await listTasksHandler({});

      const calls = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(calls.some((c: string) => c.includes("500ms"))).toBe(true);
      expect(calls.some((c: string) => c.includes("5s"))).toBe(true);
      expect(calls.some((c: string) => c.includes("2m 5s"))).toBe(true);
    });

    it("handles unknown status with white color", async () => {
      mockRequest.mockResolvedValueOnce({
        tasks: [
          { id: "id-12345678", status: "mystery", prompt: "test", createdAt: Date.now() },
        ],
      });

      await listTasksHandler({});
      // Should not throw
    });
  });

  describe("showTaskHandler", () => {
    it("displays task with all fields", async () => {
      mockRequest.mockResolvedValueOnce({
        task: {
          id: "task-full",
          status: "completed",
          prompt: "do something",
          createdAt: Date.now(),
          startedAt: Date.now() - 5000,
          completedAt: Date.now(),
          totalDurationMs: 5000,
          costUsd: 0.0234,
          result: "done",
          error: undefined,
        },
      });

      await showTaskHandler("task-full");

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Task Details"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("task-full"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("do something"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("$0.0234"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("done"));
    });

    it("displays task with minimal fields", async () => {
      mockRequest.mockResolvedValueOnce({
        task: {
          id: "task-min",
          status: "pending",
          prompt: "test",
          createdAt: Date.now(),
        },
      });

      await showTaskHandler("task-min");

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("task-min"));
    });

    it("shows error field when present", async () => {
      mockRequest.mockResolvedValueOnce({
        task: {
          id: "task-err",
          status: "failed",
          prompt: "test",
          createdAt: Date.now(),
          error: "something broke",
        },
      });

      await showTaskHandler("task-err");

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("something broke"));
    });

    it("handles API error", async () => {
      mockRequest.mockRejectedValueOnce(new Error("not found"));
      await showTaskHandler("bad-id");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("not found"));
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe("cancelTaskHandler", () => {
    it("cancels task successfully", async () => {
      mockRequest.mockResolvedValueOnce({});
      await cancelTaskHandler("task-123");
      expect(consoleSpy).toHaveBeenCalledWith("Task task-123 cancelled");
      expect(mockRequest).toHaveBeenCalledWith("/tasks/task-123/cancel", { method: "POST" });
    });

    it("handles cancel error", async () => {
      mockRequest.mockRejectedValueOnce(new Error("cannot cancel"));
      await cancelTaskHandler("task-123");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("cannot cancel"));
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });
});
