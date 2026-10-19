import { describe, it, expect } from "vitest";

describe("TUI views", () => {
  it("exports TaskList component", async () => {
    const mod = await import("../../../cli/tui/components/TaskList.js");
    expect(typeof mod.TaskList).toBe("function");
  });

  it("exports ConfigView component", async () => {
    const mod = await import("../../../cli/tui/components/ConfigView.js");
    expect(typeof mod.ConfigView).toBe("function");
  });

  it("exports EvolutionView component", async () => {
    const mod = await import("../../../cli/tui/components/EvolutionView.js");
    expect(typeof mod.EvolutionView).toBe("function");
  });
});

describe("View switching state", () => {
  it("supports all view types", async () => {
    const { tuiReducer } = await import("../../../cli/tui/hooks/useTuiState.js");
    const initial = {
      connected: false, serverInfo: null,
      activeTasks: 0, queuedTasks: 0, costToday: 0,
      activeTaskId: null, activeTaskSubmitted: false,
      pendingApproval: null, pendingPlanApproval: null, planTimeoutNotice: null, serverUnreachable: false, view: "chat" as const, selectedTaskId: null, configVersion: 0, session: null, version: null,
    };

    const views = ["work", "config", "evolution", "chat"] as const;
    for (const view of views) {
      const state = tuiReducer(initial, { type: "SET_VIEW", view });
      expect(state.view).toBe(view);
    }
  });
});
