import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "../utils/test-utils";
import { Tasks } from "@/pages/Tasks";
import { TaskDetail } from "@/pages/TaskDetail";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";
import { server } from "../msw/server";
import { http, HttpResponse } from "msw";

describe("Error Handling", () => {
  describe("API Error States", () => {
    it("should show empty state when tasks fetch returns empty", () => {
      useAppStore.setState({ tasks: [] });
      render(<Tasks />);
      expect(screen.getByText("No tasks found")).toBeInTheDocument();
    });

    it("should show error state in TaskDetail when API returns 404", async () => {
      server.use(
        http.get("/tasks/:id", () => {
          return HttpResponse.json(
            { code: "NOT_FOUND", message: "Not Found" },
            { status: 404 },
          );
        }),
      );

      render(
        <MemoryRouter initialEntries={["/tasks/nonexistent-id"]}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskDetail />} />
          </Routes>
        </MemoryRouter>,
        { withRouter: false },
      );

      await waitFor(() => {
        expect(screen.getByText("Not Found")).toBeInTheDocument();
      });
    });

    it("should show error state in TaskDetail when API returns 500", async () => {
      server.use(
        http.get("/tasks/:id", () => {
          return HttpResponse.json(
            { code: "INTERNAL_ERROR", message: "Internal Server Error" },
            { status: 500 },
          );
        }),
      );

      render(
        <MemoryRouter initialEntries={["/tasks/task-001"]}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskDetail />} />
          </Routes>
        </MemoryRouter>,
        { withRouter: false },
      );

      await waitFor(() => {
        expect(screen.getByText("Internal Server Error")).toBeInTheDocument();
      });
    });
  });

  describe("WebSocket Connection State", () => {
    it("should reflect disconnected state in store", () => {
      useAppStore.setState({ wsConnected: false });
      expect(useAppStore.getState().wsConnected).toBe(false);
    });

    it("should reflect connected state in store", () => {
      useAppStore.setState({ wsConnected: true });
      expect(useAppStore.getState().wsConnected).toBe(true);
    });

    it("should have connectWebSocket action", () => {
      expect(useAppStore.getState().connectWebSocket).toBeDefined();
    });

    it("should have disconnectWebSocket action", () => {
      expect(useAppStore.getState().disconnectWebSocket).toBeDefined();
    });
  });

  describe("Empty States", () => {
    it("should show empty state for tasks", () => {
      useAppStore.setState({ tasks: [] });
      render(<Tasks />);
      expect(screen.getByText("No tasks found")).toBeInTheDocument();
    });
  });
});
