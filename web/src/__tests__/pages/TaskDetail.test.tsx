import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor } from "../utils/test-utils";
import { TaskDetail } from "@/pages/TaskDetail";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { server } from "../msw/server";

function renderTaskDetail(taskId: string) {
  return render(
    <MemoryRouter initialEntries={[`/tasks/${taskId}`]}>
      <Routes>
        <Route path="/tasks/:id" element={<TaskDetail />} />
      </Routes>
    </MemoryRouter>,
    { withRouter: false },
  );
}

describe("TaskDetail", () => {
  it("should render loading state initially then show task data", async () => {
    renderTaskDetail("task-001");
    // Initially shows loading
    expect(screen.getByText("Loading...")).toBeInTheDocument();

    // After fetch completes, shows task data
    expect(await screen.findByText("running", undefined, { timeout: 15000 })).toBeInTheDocument();
  });

  it("should show back link", async () => {
    renderTaskDetail("task-001");
    // Back link should always be visible
    expect(screen.getByText("Back to Tasks")).toBeInTheDocument();
  });

  it("should display task prompt", async () => {
    renderTaskDetail("task-001");
    expect(
      await screen.findByText("Implement user authentication feature", undefined, { timeout: 15000 }),
    ).toBeInTheDocument();
  });

  it("should show metadata cards", async () => {
    renderTaskDetail("task-001");
    await waitFor(() => {
      expect(screen.getByText("Created")).toBeInTheDocument();
      expect(screen.getByText("Duration")).toBeInTheDocument();
      expect(screen.getByText("Cost")).toBeInTheDocument();
      expect(screen.getByText("Turns")).toBeInTheDocument();
    });
  });

  it("should show token usage section", async () => {
    renderTaskDetail("task-001");
    await waitFor(() => {
      expect(screen.getByText("Token Usage")).toBeInTheDocument();
      expect(screen.getByText("Input:")).toBeInTheDocument();
      expect(screen.getByText("Output:")).toBeInTheDocument();
    });
  });

  it("should show cancel button for running tasks", async () => {
    renderTaskDetail("task-001");
    await waitFor(() => {
      expect(screen.getByText("Cancel Task")).toBeInTheDocument();
    });
  });

  it("should show error for non-existent task", async () => {
    renderTaskDetail("nonexistent-id");
    await waitFor(() => {
      // MSW returns 404 -> ApiError -> error state
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
  });

  it("shows Plugin Issue badge for plugin-related errors", async () => {
    server.use(
      http.get("/tasks/:id", () => {
        return HttpResponse.json({
          task: {
            id: "task-plugin-err",
            status: "failed",
            prompt: "Run plugin task",
            error: "Error: failed to load plugin at /path/to/broken-plugin\nStack trace here",
            createdAt: Date.now(),
          },
        });
      }),
    );

    renderTaskDetail("task-plugin-err");
    await waitFor(() => {
      expect(screen.getByText("Plugin Issue")).toBeInTheDocument();
      expect(screen.getByText("Error")).toBeInTheDocument();
    });
  });

  it("does not show Plugin Issue badge for non-plugin errors", async () => {
    server.use(
      http.get("/tasks/:id", () => {
        return HttpResponse.json({
          task: {
            id: "task-normal-err",
            status: "failed",
            prompt: "Normal task",
            error: "TypeError: Cannot read property 'foo' of undefined",
            createdAt: Date.now(),
          },
        });
      }),
    );

    renderTaskDetail("task-normal-err");
    await waitFor(() => {
      expect(screen.getByText("Error")).toBeInTheDocument();
    });
    expect(screen.queryByText("Plugin Issue")).not.toBeInTheDocument();
  });

  it("should show automation link when task has templateId", async () => {
    server.use(
      http.get("/tasks/:id", () => {
        return HttpResponse.json({
          task: {
            id: "task-linked",
            status: "completed",
            prompt: "Linked task",
            templateId: "tmpl-abc",
            createdAt: Date.now(),
          },
        });
      }),
    );

    renderTaskDetail("task-linked");
    await waitFor(() => {
      expect(screen.getByText(/View in Automations/)).toBeInTheDocument();
    });
  });
});
