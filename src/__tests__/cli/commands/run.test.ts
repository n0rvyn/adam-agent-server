import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Hoisted mocks ---

const {
  mockRequest,
  mockStreamConnect,
  mockStreamOn,
  mockStreamClose,
  mockRlQuestion,
  mockRlClose,
} = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockStreamConnect: vi.fn().mockResolvedValue(undefined),
  mockStreamOn: vi.fn(),
  mockStreamClose: vi.fn(),
  mockRlQuestion: vi.fn(),
  mockRlClose: vi.fn(),
}));

vi.mock("../../../cli/client.js", () => ({
  request: mockRequest,
  TaskStreamSocket: vi.fn(function () {
    return {
      connect: mockStreamConnect,
      on: mockStreamOn,
      close: mockStreamClose,
    };
  }),
}));

vi.mock("readline", () => ({
  createInterface: vi.fn(() => ({
    question: mockRlQuestion,
    close: mockRlClose,
  })),
}));

import { runCommand } from "../../../cli/commands/run.js";

describe("run command", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let processOnSpy: ReturnType<typeof vi.spyOn>;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    processOnSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    originalExit = process.exit;
    process.exit = vi.fn() as never;

    // Default: task submission succeeds
    mockRequest.mockResolvedValue({ taskId: "task-abc123" });

    // Setup stream.on to capture event handlers
    mockStreamOn.mockImplementation(() => {});
  });

  afterEach(() => {
    process.exit = originalExit;
    consoleSpy.mockRestore();
    errorSpy.mockRestore();
    stdoutSpy.mockRestore();
    processOnSpy.mockRestore();
  });

  /** Helper: trigger a stream event by finding its handler from mockStreamOn calls */
  function triggerStreamEvent(eventName: string, data: unknown) {
    const call = mockStreamOn.mock.calls.find((c) => c[0] === eventName);
    if (call) call[1](data);
  }

  /** Helper: run command and trigger complete to resolve the promise */
  async function runAndComplete(prompt: string, options: Record<string, unknown> = {}) {
    // Make stream.on store handlers so we can trigger them
    const handlers: Record<string, (data: unknown) => void> = {};
    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    // Setup final task status check
    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" }) // POST /tasks
      .mockResolvedValueOnce({ task: { status: "completed" } }); // GET /tasks/:id

    const promise = runCommand(prompt, options as never);

    // Let the async setup complete
    await new Promise((r) => setTimeout(r, 10));

    // Trigger complete event
    if (handlers["complete"]) {
      handlers["complete"]({ result: "done", costUsd: 0.01, numTurns: 3 });
    }

    await promise;
    return handlers;
  }

  it("submits task with prompt", async () => {
    await runAndComplete("test prompt");

    expect(mockRequest).toHaveBeenCalledWith("/tasks", {
      method: "POST",
      body: { prompt: "test prompt", config: undefined },
    });
  });

  it("submits task with all options", async () => {
    await runAndComplete("test", {
      model: "claude-sonnet-4-20250514",
      timeout: 30,
      budget: 1.5,
      workspace: "/tmp",
    });

    expect(mockRequest).toHaveBeenCalledWith("/tasks", {
      method: "POST",
      body: {
        prompt: "test",
        config: {
          model: "claude-sonnet-4-20250514",
          timeout: 30,
          maxBudgetUsd: 1.5,
          workspacePath: "/tmp",
        },
      },
    });
  });

  it("logs task ID on submission", async () => {
    await runAndComplete("test");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("task-abc123"));
  });

  it("logs JSON on submission with --json", async () => {
    await runAndComplete("test", { json: true });
    expect(consoleSpy).toHaveBeenCalledWith(
      JSON.stringify({ taskId: "task-abc123", status: "submitted" }),
    );
  });

  it("handles reasoning events", async () => {
    const handlers = await runAndComplete("test");
    // Reasoning was set up before complete
  });

  it("handles reasoning in non-json mode", async () => {
    const handlers: Record<string, (data: unknown) => void> = {};
    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValueOnce({ task: { status: "completed" } });

    const promise = runCommand("test", {} as never);
    await new Promise((r) => setTimeout(r, 10));

    handlers["reasoning"]({ content: "thinking..." });
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("thinking..."));

    handlers["complete"]({});
    await promise;
  });

  it("handles tool_call events", async () => {
    const handlers: Record<string, (data: unknown) => void> = {};
    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValueOnce({ task: { status: "completed" } });

    const promise = runCommand("test", {} as never);
    await new Promise((r) => setTimeout(r, 10));

    handlers["tool_call"]({ toolName: "Read", input: { path: "/file" } });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Read"));

    handlers["complete"]({});
    await promise;
  });

  it("handles tool_result with short content", async () => {
    const handlers: Record<string, (data: unknown) => void> = {};
    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValueOnce({ task: { status: "completed" } });

    const promise = runCommand("test", {} as never);
    await new Promise((r) => setTimeout(r, 10));

    handlers["tool_result"]({ content: "line1\nline2" });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("line1\nline2"));

    handlers["complete"]({});
    await promise;
  });

  it("handles tool_result with long content (truncated)", async () => {
    const handlers: Record<string, (data: unknown) => void> = {};
    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValueOnce({ task: { status: "completed" } });

    const promise = runCommand("test", {} as never);
    await new Promise((r) => setTimeout(r, 10));

    const longContent = "line\n".repeat(10);
    handlers["tool_result"]({ content: longContent });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("truncated"));

    handlers["complete"]({});
    await promise;
  });

  it("handles error events", async () => {
    const handlers: Record<string, (data: unknown) => void> = {};
    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValueOnce({ task: { status: "completed" } });

    const promise = runCommand("test", {} as never);
    await new Promise((r) => setTimeout(r, 10));

    handlers["error"]({ error: "something failed" });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("something failed"));

    handlers["complete"]({});
    await promise;
  });

  it("handles approval_needed with --no-approval (auto-approve)", async () => {
    const handlers: Record<string, (data: unknown) => void> = {};
    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValue({}); // approve + final status

    const promise = runCommand("test", { approval: false } as never);
    await new Promise((r) => setTimeout(r, 10));

    handlers["approval_needed"]({ approvalId: "ap-1", toolName: "Bash" });

    expect(mockRequest).toHaveBeenCalledWith(
      "/tasks/task-abc123/approve",
      expect.objectContaining({ method: "POST" }),
    );

    handlers["complete"]({});
    await promise;
  });

  it("handles approval_needed in JSON mode (auto-approve)", async () => {
    const handlers: Record<string, (data: unknown) => void> = {};
    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValue({}); // approve + final status

    const promise = runCommand("test", { json: true } as never);
    await new Promise((r) => setTimeout(r, 10));

    handlers["approval_needed"]({ approvalId: "ap-1", toolName: "Bash" });

    expect(mockRequest).toHaveBeenCalledWith(
      "/tasks/task-abc123/approve",
      expect.objectContaining({ method: "POST" }),
    );

    handlers["complete"]({});
    await promise;
  });

  it("handles approval_needed with interactive approve", async () => {
    const handlers: Record<string, (data: unknown) => void> = {};
    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    // Auto-answer "a" for approve
    mockRlQuestion.mockImplementation((_prompt: string, cb: (answer: string) => void) => {
      cb("a");
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValue({});

    const promise = runCommand("test", {} as never);
    await new Promise((r) => setTimeout(r, 10));

    handlers["approval_needed"]({
      approvalId: "ap-1",
      toolName: "Bash",
      matchedPattern: "rm *",
      toolInput: { command: "rm -rf /tmp" },
    });

    expect(mockRequest).toHaveBeenCalledWith(
      "/tasks/task-abc123/approve",
      expect.objectContaining({ method: "POST" }),
    );

    handlers["complete"]({});
    await promise;
  });

  it("handles approval_needed with interactive reject", async () => {
    const handlers: Record<string, (data: unknown) => void> = {};
    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    mockRlQuestion.mockImplementation((_prompt: string, cb: (answer: string) => void) => {
      cb("r");
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValue({});

    const promise = runCommand("test", {} as never);
    await new Promise((r) => setTimeout(r, 10));

    handlers["approval_needed"]({ approvalId: "ap-1", toolName: "Bash" });

    expect(mockRequest).toHaveBeenCalledWith(
      "/tasks/task-abc123/reject",
      expect.objectContaining({ method: "POST" }),
    );

    handlers["complete"]({});
    await promise;
  });

  it("handles complete event in JSON mode", async () => {
    const handlers: Record<string, (data: unknown) => void> = {};
    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValueOnce({ task: { status: "completed" } });

    const promise = runCommand("test", { json: true } as never);
    await new Promise((r) => setTimeout(r, 10));

    handlers["complete"]({ result: "done" });
    await promise;

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"status":"completed"'),
    );
  });

  it("handles complete event with cost and turns", async () => {
    const handlers: Record<string, (data: unknown) => void> = {};
    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValueOnce({ task: { status: "completed" } });

    const promise = runCommand("test", {} as never);
    await new Promise((r) => setTimeout(r, 10));

    handlers["complete"]({ costUsd: 0.1234, numTurns: 5 });
    await promise;

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("$0.1234"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Turns: 5"));
  });

  it("handles wildcard * event", async () => {
    const handlers: Record<string, (data: unknown) => void> = {};
    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValueOnce({ task: { status: "completed" } });

    const promise = runCommand("test", {} as never);
    await new Promise((r) => setTimeout(r, 10));

    // * handler should exist and not throw
    if (handlers["*"]) handlers["*"]({ type: "complete" });

    handlers["complete"]({});
    await promise;
  });

  it("exits with 1 when task status is failed", async () => {
    const handlers: Record<string, (data: unknown) => void> = {};
    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValueOnce({ task: { status: "failed" } });

    const promise = runCommand("test", {} as never);
    await new Promise((r) => setTimeout(r, 10));

    handlers["complete"]({});
    await promise;

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("exits with 1 when task status is cancelled", async () => {
    const handlers: Record<string, (data: unknown) => void> = {};
    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValueOnce({ task: { status: "cancelled" } });

    const promise = runCommand("test", {} as never);
    await new Promise((r) => setTimeout(r, 10));

    handlers["complete"]({});
    await promise;

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("handles submission error in text mode", async () => {
    mockRequest.mockRejectedValueOnce(new Error("connection refused"));

    await runCommand("test", {} as never);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("connection refused"));
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("handles submission error in JSON mode", async () => {
    mockRequest.mockRejectedValueOnce(new Error("connection refused"));

    await runCommand("test", { json: true } as never);

    expect(consoleSpy).toHaveBeenCalledWith(
      JSON.stringify({ error: "connection refused" }),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("registers SIGINT handler", async () => {
    await runAndComplete("test");
    expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
  });

  it("SIGINT handler cancels task and exits", async () => {
    const handlers: Record<string, (data: unknown) => void> = {};
    const sigintHandlers: (() => void)[] = [];

    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    processOnSpy.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "SIGINT") sigintHandlers.push(handler as () => void);
      return process;
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValue({});

    const promise = runCommand("test", {} as never);
    await new Promise((r) => setTimeout(r, 10));

    // Trigger SIGINT handler
    expect(sigintHandlers.length).toBeGreaterThan(0);
    sigintHandlers[0]();

    expect(mockRequest).toHaveBeenCalledWith(
      "/tasks/task-abc123/cancel",
      { method: "POST" },
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("cancelled"));
    expect(process.exit).toHaveBeenCalledWith(130);

    // Complete to resolve the promise
    if (handlers["complete"]) handlers["complete"]({});
    await promise.catch(() => {});
  });

  it("SIGINT handler skips log in JSON mode", async () => {
    const sigintHandlers: (() => void)[] = [];

    mockStreamOn.mockImplementation(() => {});
    processOnSpy.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "SIGINT") sigintHandlers.push(handler as () => void);
      return process;
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValue({});

    runCommand("test", { json: true } as never);
    await new Promise((r) => setTimeout(r, 10));

    sigintHandlers[0]();
    // In JSON mode, no "Task cancelled." message
    const cancelCalls = consoleSpy.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("cancelled"),
    );
    expect(cancelCalls).toHaveLength(0);
    expect(process.exit).toHaveBeenCalledWith(130);
  });

  it("handles events with missing fields gracefully", async () => {
    const handlers: Record<string, (data: unknown) => void> = {};
    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValueOnce({ task: { status: "completed" } });

    const promise = runCommand("test", {} as never);
    await new Promise((r) => setTimeout(r, 10));

    // Events with undefined fields
    handlers["reasoning"]({});
    handlers["tool_call"]({});
    handlers["tool_result"]({});
    handlers["error"]({});

    handlers["complete"]({});
    await promise;
  });

  it("handles JSON mode events (collected in events array)", async () => {
    const handlers: Record<string, (data: unknown) => void> = {};
    mockStreamOn.mockImplementation((event: string, handler: (data: unknown) => void) => {
      handlers[event] = handler;
    });

    mockRequest
      .mockResolvedValueOnce({ taskId: "task-abc123" })
      .mockResolvedValueOnce({ task: { status: "completed" } });

    const promise = runCommand("test", { json: true } as never);
    await new Promise((r) => setTimeout(r, 10));

    handlers["reasoning"]({ content: "think" });
    handlers["tool_call"]({ toolName: "Read" });
    handlers["tool_result"]({ content: "result" });
    handlers["error"]({ error: "oops" });

    handlers["complete"]({ result: "done" });
    await promise;

    // JSON output should include all events
    const jsonCall = consoleSpy.mock.calls.find((c: unknown[]) => {
      const str = String(c[0]);
      return str.includes('"events"');
    });
    expect(jsonCall).toBeDefined();
  });
});
