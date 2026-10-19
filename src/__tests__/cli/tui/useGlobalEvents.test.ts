import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDispatch = vi.fn();

const { mockConnect, mockOn, mockClose } = vi.hoisted(() => ({
  mockConnect: vi.fn().mockResolvedValue(undefined),
  mockOn: vi.fn(),
  mockClose: vi.fn(),
}));

vi.mock("../../../cli/tui/hooks/useTuiState.js", () => ({
  useTuiState: () => ({ state: {}, dispatch: mockDispatch }),
}));

vi.mock("../../../cli/client.js", () => ({
  EventSocket: vi.fn(function () {
    return { connect: mockConnect, on: mockOn, close: mockClose };
  }),
}));

// Mock React hooks to capture behavior without DOM
let effectCallbacks: Array<() => void | (() => void)> = [];

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (cb: () => void | (() => void)) => { effectCallbacks.push(cb); },
    useRef: (initial: unknown) => ({ current: initial }),
  };
});

import { useGlobalEvents } from "../../../cli/tui/hooks/useGlobalEvents.js";

describe("useGlobalEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    effectCallbacks = [];
  });

  it("creates EventSocket and connects", () => {
    useGlobalEvents();
    // Run the effect
    effectCallbacks.forEach((cb) => cb());
    expect(mockConnect).toHaveBeenCalled();
  });

  it("registers handlers for all event types", () => {
    useGlobalEvents();
    effectCallbacks.forEach((cb) => cb());
    const eventNames = mockOn.mock.calls.map((c: unknown[]) => c[0]);
    expect(eventNames).toContain("task_status_change");
    expect(eventNames).toContain("approval_request");
    expect(eventNames).toContain("stats_update");
  });

  it("dispatches SET_CONNECTED on successful connect", async () => {
    mockConnect.mockResolvedValue(undefined);
    useGlobalEvents();
    effectCallbacks.forEach((cb) => cb());
    // Wait for connect promise to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_CONNECTED", connected: true }),
    );
  });

  it("dispatches SET_CONNECTED false on connect failure", async () => {
    mockConnect.mockRejectedValue(new Error("fail"));
    useGlobalEvents();
    effectCallbacks.forEach((cb) => cb());
    await new Promise((r) => setTimeout(r, 10));
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_CONNECTED", connected: false }),
    );
  });

  it("dispatches UPDATE_STATS when stats_update event fires", () => {
    useGlobalEvents();
    effectCallbacks.forEach((cb) => cb());
    // Find the stats_update handler
    const statsCall = mockOn.mock.calls.find((c: unknown[]) => c[0] === "stats_update");
    const handler = statsCall![1] as (data: unknown) => void;
    handler({ activeTasks: 2, queuedTasks: 1, idleWorkers: 3, totalCostToday: 0.5 });
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "UPDATE_STATS", activeTasks: 2, queuedTasks: 1, costToday: 0.5 }),
    );
  });

  it("dispatches SET_PENDING_APPROVAL when approval_request event fires", () => {
    useGlobalEvents();
    effectCallbacks.forEach((cb) => cb());
    const approvalCall = mockOn.mock.calls.find((c: unknown[]) => c[0] === "approval_request");
    const handler = approvalCall![1] as (data: unknown) => void;
    handler({ taskId: "t1", approvalId: "a1", toolName: "Bash", toolInput: {}, matchedPattern: ".*" });
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_PENDING_APPROVAL" }),
    );
  });

  it("dispatches SET_PENDING_PLAN_APPROVAL when plan_approval_request event fires", () => {
    useGlobalEvents();
    effectCallbacks.forEach((cb) => cb());
    const planCall = mockOn.mock.calls.find((c: unknown[]) => c[0] === "plan_approval_request");
    expect(planCall).toBeDefined();
    const handler = planCall![1] as (data: unknown) => void;
    handler({
      taskId: "t1",
      planId: "p1",
      roleId: "a1",
      plan: { steps: [], requiredPermissions: {}, overallRisk: "high" },
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_PENDING_PLAN_APPROVAL" }),
    );
  });

  it("dispatches SET_PENDING_PLAN_APPROVAL null when plan_approval_decision event fires", () => {
    useGlobalEvents();
    effectCallbacks.forEach((cb) => cb());
    const decisionCall = mockOn.mock.calls.find((c: unknown[]) => c[0] === "plan_approval_decision");
    expect(decisionCall).toBeDefined();
    const handler = decisionCall![1] as (data: unknown) => void;
    handler({ planId: "p1" });
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SET_PENDING_PLAN_APPROVAL", approval: null }),
    );
  });

  it("cleanup closes socket", () => {
    useGlobalEvents();
    const cleanups = effectCallbacks.map((cb) => cb()).filter(Boolean);
    // Run cleanup
    cleanups.forEach((cleanup) => (cleanup as () => void)());
    expect(mockClose).toHaveBeenCalled();
  });
});
