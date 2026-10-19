import { describe, it, expect, vi } from "vitest";
import { tuiReducer, type TuiState } from "../../../cli/tui/hooks/useTuiState.js";

// Mock existsSync to simulate missing port file (server not running)
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (typeof path === "string" && path.endsWith("adam.port")) return false;
      return actual.existsSync(path);
    }),
  };
});

const initialState: TuiState = {
  connected: false,
  serverInfo: null,
  activeTasks: 0,
  queuedTasks: 0,
  costToday: 0,
  activeTaskId: null,
  activeTaskSubmitted: false,
  pendingApproval: null,
  pendingPlanApproval: null,
  planTimeoutNotice: null,
  serverUnreachable: false,
  view: "chat",
  selectedTaskId: null,
  configVersion: 0,
  session: null,
  version: null,
};

describe("Edge case state management", () => {
  it("sets serverUnreachable to true", () => {
    const state = tuiReducer(initialState, {
      type: "SET_SERVER_UNREACHABLE",
      unreachable: true,
    });
    expect(state.serverUnreachable).toBe(true);
  });

  it("clears serverUnreachable on reconnect", () => {
    const unreachable = { ...initialState, serverUnreachable: true };
    const state = tuiReducer(unreachable, {
      type: "SET_SERVER_UNREACHABLE",
      unreachable: false,
    });
    expect(state.serverUnreachable).toBe(false);
  });

  it("handles disconnection + reconnection cycle", () => {
    let state = tuiReducer(initialState, { type: "SET_CONNECTED", connected: true });
    expect(state.connected).toBe(true);

    state = tuiReducer(state, { type: "SET_CONNECTED", connected: false });
    expect(state.connected).toBe(false);

    state = tuiReducer(state, { type: "SET_SERVER_UNREACHABLE", unreachable: true });
    expect(state.serverUnreachable).toBe(true);

    // Reconnect
    state = tuiReducer(state, { type: "SET_CONNECTED", connected: true });
    state = tuiReducer(state, { type: "SET_SERVER_UNREACHABLE", unreachable: false });
    expect(state.connected).toBe(true);
    expect(state.serverUnreachable).toBe(false);
  });

  it("handles empty initial state gracefully", () => {
    expect(initialState.activeTasks).toBe(0);
    expect(initialState.activeTaskId).toBeNull();
    expect(initialState.pendingApproval).toBeNull();
    expect(initialState.serverUnreachable).toBe(false);
  });
});

describe("Daemon edge cases", () => {
  it("getDaemonStatus handles missing files", async () => {
    const { getDaemonStatus } = await import("../../../cli/daemon.js");
    const status = getDaemonStatus();
    // In test env, no daemon running
    expect(status).toHaveProperty("running");
    expect(status).toHaveProperty("pid");
    expect(status).toHaveProperty("port");
  });
});

describe("Client error handling", () => {
  it("request throws on server not running", async () => {
    const { request } = await import("../../../cli/client.js");
    await expect(request("/healthz")).rejects.toThrow();
  });

  it("EventSocket throws on construction without port file", async () => {
    const { EventSocket } = await import("../../../cli/client.js");
    expect(() => new EventSocket()).toThrow("Server not running");
  });
});
