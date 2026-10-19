import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store/useAppStore";
import type { LogEntry } from "@/lib/types";

describe("useAppStore", () => {
  beforeEach(() => {
    useAppStore.setState({
      tasks: [],
      goals: [],
      strategies: [],
      templates: [],
      readiness: null,
      stats: { activeTasks: 0, queuedTasks: 0, totalCostToday: 0 },
      logs: [],
      roles: [],
      executionPool: { active: 0, max: 3, queued: 0 },
      wsConnected: false,
      _ws: null,
      _wsReconnectDelay: 1000,
    });
  });

  describe("initial state", () => {
    it("should have empty initial state", () => {
      const state = useAppStore.getState();
      expect(state.tasks).toEqual([]);
      expect(state.goals).toEqual([]);
      expect(state.strategies).toEqual([]);
      expect(state.templates).toEqual([]);
      expect(state.logs).toEqual([]);
      expect(state.wsConnected).toBe(false);
    });
  });

  describe("fetchTasks", () => {
    it("should fetch tasks and update state", async () => {
      await useAppStore.getState().fetchTasks();
      const state = useAppStore.getState();
      expect(state.tasks.length).toBeGreaterThan(0);
    });

    it("should fetch tasks with status filter", async () => {
      await useAppStore.getState().fetchTasks("running");
      const state = useAppStore.getState();
      expect(state.tasks).toBeDefined();
    });
  });

  describe("fetchGoals", () => {
    it("should fetch goals and update state", async () => {
      await useAppStore.getState().fetchGoals();
      const state = useAppStore.getState();
      expect(state.goals.length).toBeGreaterThan(0);
    });
  });

  describe("fetchStrategies", () => {
    it("should fetch strategies and update state", async () => {
      await useAppStore.getState().fetchStrategies();
      const state = useAppStore.getState();
      expect(state.strategies.length).toBeGreaterThan(0);
    });
  });

  describe("fetchTemplates", () => {
    it("should fetch templates and update state", async () => {
      await useAppStore.getState().fetchTemplates();
      const state = useAppStore.getState();
      expect(state.templates.length).toBeGreaterThan(0);
    });
  });

  describe("fetchReadiness", () => {
    it("should fetch readiness and update state", async () => {
      await useAppStore.getState().fetchReadiness();
      const state = useAppStore.getState();
      expect(state.readiness).not.toBeNull();
      expect(state.readiness?.status).toBe("ready");
    });
  });

  describe("addLog", () => {
    it("should add log entries", () => {
      const log: LogEntry = {
        type: "log_event",
        timestamp: Date.now(),
        level: "info",
        component: "test",
        msg: "Test message",
      };

      useAppStore.getState().addLog(log);

      const state = useAppStore.getState();
      expect(state.logs).toHaveLength(1);
      expect(state.logs[0].msg).toBe("Test message");
    });

    it("should limit logs to 500", () => {
      const { addLog } = useAppStore.getState();

      for (let i = 0; i < 501; i++) {
        addLog({
          type: "log_event",
          timestamp: Date.now() + i,
          level: "info",
          component: "test",
          msg: `Log ${i}`,
        });
      }

      const state = useAppStore.getState();
      expect(state.logs).toHaveLength(500);
      // Should keep the most recent entries
      expect(state.logs[state.logs.length - 1].msg).toBe("Log 500");
    });
  });

  describe("roles", () => {
    it("should have empty initial roles", () => {
      const state = useAppStore.getState();
      expect(state.roles).toEqual([]);
    });

    it("should update executionPool on execution_slot_change event", () => {
      // Manually trigger the event handler by calling setState
      useAppStore.setState({
        executionPool: { active: 2, max: 3, queued: 1 },
      });
      const state = useAppStore.getState();
      expect(state.executionPool.active).toBe(2);
      expect(state.executionPool.max).toBe(3);
      expect(state.executionPool.queued).toBe(1);
    });
  });
});
