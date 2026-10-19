import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { App } from "@/App";
import { useAppStore } from "@/store/useAppStore";
import { useChatStore } from "@/store/useChatStore";
import { mockTasks, mockGoals, mockReadiness } from "../fixtures";

const ROUTE_RENDER_TIMEOUT_MS = 15000;

// Each entry: route path and a unique text visible on that page (used for smoke check)
const smokeTests = [
  { path: "/", label: "Adam" },
  { path: "/work", label: "Tasks" },
  { path: "/plugins", label: "Plugins" },
  { path: "/roles", label: "Roles" },
  { path: "/strategies", label: "Strategies" },
  { path: "/channels", label: "Channels" },
  { path: "/goals", label: "Goals" },
  { path: "/memories", label: "Memories" },
  { path: "/evolution", label: "Evolution Audit" },
  { path: "/logs", label: "Logs" },
  { path: "/settings", label: "Settings" },
  { path: "/chat", label: "Sessions" },
];

describe("Sidebar smoke tests — all pages render without crash", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    useAppStore.setState({
      tasks: mockTasks,
      goals: mockGoals,
      readiness: mockReadiness,
      stats: { activeTasks: 1, queuedTasks: 2, totalCostToday: 0.19 },
      roles: [],
      strategies: [],
      logs: [],
      executionPool: { active: 0, max: 3, queued: 0 },
      configVersion: 0,
      fetchRoles: async () => { /* noop */ },
      fetchTasks: async () => { /* noop */ },
      fetchGoals: async () => { /* noop */ },
      fetchStrategies: async () => { /* noop */ },
      fetchReadiness: async () => { /* noop */ },
    });
  });

  for (const { path, label } of smokeTests) {
    it(`renders ${label} page at ${path} without crashing`, async () => {
      if (path === "/chat") {
        useChatStore.setState({
          sessions: [],
          activeSessionId: null,
          messages: [],
          loading: false,
          sending: false,
          fetchSessions: async () => { /* noop */ },
          sendMessage: async () => { /* noop */ },
          createSession: async () => { /* noop */ },
          archiveSession: async () => { /* noop */ },
          restoreSession: async () => { /* noop */ },
          deleteSession: async () => { /* noop */ },
          setActiveSession: () => { /* noop */ },
        });
      }

      const router = createMemoryRouter(
        [{ path: "*", element: <App /> }],
        { initialEntries: [path] },
      );
      render(<RouterProvider router={router} />);

      await waitFor(
        () => {
          expect(screen.getAllByText(label).length).toBeGreaterThan(0);
        },
        { timeout: ROUTE_RENDER_TIMEOUT_MS },
      );
    });
  }
});
