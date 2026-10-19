import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../../../server/events/server-bus.js", async () => {
  const { EventEmitter: EE } = await import("node:events");
  return { serverBus: new EE() };
});

import { registerGlobalEvents } from "../../../server/ws/global-events.js";
import { serverBus as mockServerBus } from "../../../server/events/server-bus.js";
import { setAuthKey } from "../../../server/auth-key.js";
import { TEST_API_KEY } from "../../helpers/test-auth.js";

const authedRequest = () => ({
  headers: { "x-api-key": TEST_API_KEY },
  query: {},
});

describe("global-events WebSocket handler", () => {
  let mockFastify: { get: ReturnType<typeof vi.fn> };
  let wsHandler: (socket: Record<string, unknown>, request: unknown) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    setAuthKey(TEST_API_KEY);
    (mockServerBus as unknown as EventEmitter).removeAllListeners();

    mockFastify = {
      get: vi.fn((_path: string, _opts: unknown, handler: typeof wsHandler) => {
        wsHandler = handler;
      }),
    };
  });

  it("registers /events WebSocket route", () => {
    registerGlobalEvents(mockFastify as never);
    expect(mockFastify.get).toHaveBeenCalledWith(
      "/events",
      { websocket: true },
      expect.any(Function),
    );
  });

  it("adds socket to clients on connection", () => {
    registerGlobalEvents(mockFastify as never);

    const mockSocket = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    };

    wsHandler(mockSocket, authedRequest());

    // Verify close and error handlers registered
    expect(mockSocket.on).toHaveBeenCalledWith("close", expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("removes socket on close", () => {
    registerGlobalEvents(mockFastify as never);

    const handlers: Record<string, () => void> = {};
    const mockSocket = {
      on: vi.fn((event: string, handler: () => void) => { handlers[event] = handler; }),
      send: vi.fn(),
      readyState: 1,
    };

    wsHandler(mockSocket, authedRequest());

    // Trigger close
    handlers["close"]();

    // Broadcast should not reach this socket anymore
    (mockServerBus as unknown as EventEmitter).emit("task_status_change", {
      type: "task_status_change",
      taskId: "t-1",
      oldStatus: "pending",
      newStatus: "running",
    });
    expect(mockSocket.send).not.toHaveBeenCalled();
  });

  it("removes socket on error", () => {
    registerGlobalEvents(mockFastify as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handlers: Record<string, (err?: Error) => void> = {};
    const mockSocket = {
      on: vi.fn((event: string, handler: (err?: Error) => void) => { handlers[event] = handler; }),
      send: vi.fn(),
      readyState: 1,
    };

    wsHandler(mockSocket, authedRequest());
    handlers["error"](new Error("ws error"));

    // Broadcast should not reach this socket
    (mockServerBus as unknown as EventEmitter).emit("task_status_change", {
      type: "task_status_change",
      taskId: "t-1",
      oldStatus: "pending",
      newStatus: "running",
    });
    expect(mockSocket.send).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("broadcasts task_status_change events", () => {
    registerGlobalEvents(mockFastify as never);

    const mockSocket = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    };

    wsHandler(mockSocket, authedRequest());

    const event = {
      type: "task_status_change",
      taskId: "t-1",
      oldStatus: "pending",
      newStatus: "running",
    };
    (mockServerBus as unknown as EventEmitter).emit("task_status_change", event);

    expect(mockSocket.send).toHaveBeenCalledWith(JSON.stringify(event));
  });

  it("broadcasts approval_request events", () => {
    registerGlobalEvents(mockFastify as never);

    const mockSocket = { on: vi.fn(), send: vi.fn(), readyState: 1 };
    wsHandler(mockSocket, authedRequest());

    const event = {
      type: "approval_request",
      taskId: "t-1",
      approvalId: "ap-1",
      toolName: "Bash",
      toolInput: {},
      matchedPattern: ".*",
    };
    (mockServerBus as unknown as EventEmitter).emit("approval_request", event);

    expect(mockSocket.send).toHaveBeenCalledWith(JSON.stringify(event));
  });

  it("broadcasts stats_update events", () => {
    registerGlobalEvents(mockFastify as never);

    const mockSocket = { on: vi.fn(), send: vi.fn(), readyState: 1 };
    wsHandler(mockSocket, authedRequest());

    const event = {
      type: "stats_update",
      activeTasks: 1,
      queuedTasks: 2,
      totalCostToday: 0.5,
    };
    (mockServerBus as unknown as EventEmitter).emit("stats_update", event);

    expect(mockSocket.send).toHaveBeenCalledWith(JSON.stringify(event));
  });

  it("broadcasts plan_approval_request events", () => {
    registerGlobalEvents(mockFastify as never);

    const mockSocket = { on: vi.fn(), send: vi.fn(), readyState: 1 };
    wsHandler(mockSocket, authedRequest());

    const event = {
      type: "plan_approval_request",
      taskId: "t-1",
      planId: "plan-1",
      roleId: "agent-1",
      plan: {
        steps: [{ index: 0, description: "Write tests", toolsNeeded: ["Write"], riskLevel: "high", expectedOutput: "Tests pass" }],
        requiredPermissions: {},
        overallRisk: "high",
      },
    };
    (mockServerBus as unknown as EventEmitter).emit("plan_approval_request", event);

    expect(mockSocket.send).toHaveBeenCalledWith(JSON.stringify(event));
  });

  it("broadcasts plan_approval_decision events", () => {
    registerGlobalEvents(mockFastify as never);

    const mockSocket = { on: vi.fn(), send: vi.fn(), readyState: 1 };
    wsHandler(mockSocket, authedRequest());

    const event = {
      type: "plan_approval_decision",
      taskId: "t-1",
      planId: "plan-1",
      decision: "allow",
      approvalType: "once",
    };
    (mockServerBus as unknown as EventEmitter).emit("plan_approval_decision", event);

    expect(mockSocket.send).toHaveBeenCalledWith(JSON.stringify(event));
  });

  it("skips sockets with non-OPEN readyState", () => {
    registerGlobalEvents(mockFastify as never);

    const openSocket = { on: vi.fn(), send: vi.fn(), readyState: 1 };
    const closedSocket = { on: vi.fn(), send: vi.fn(), readyState: 3 };

    wsHandler(openSocket, authedRequest());
    wsHandler(closedSocket, authedRequest());

    (mockServerBus as unknown as EventEmitter).emit("task_status_change", {
      type: "task_status_change",
      taskId: "t-1",
      oldStatus: "pending",
      newStatus: "running",
    });

    expect(openSocket.send).toHaveBeenCalled();
    expect(closedSocket.send).not.toHaveBeenCalled();
  });
});
