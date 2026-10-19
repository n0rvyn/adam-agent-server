import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { render, screen, waitFor, fireEvent } from "../utils/test-utils";
import { TaskDetail } from "@/pages/TaskDetail";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { server } from "../msw/server";

// Mock artifacts API (downloadArtifactBlob used in ArtifactDetail)
import { vi } from "vitest";
vi.mock("@/lib/api/artifacts.ts", () => ({
  deleteArtifact: vi.fn(),
  downloadArtifactBlob: vi.fn(),
  redeliverArtifact: vi.fn(),
  artifactBlobUrl: vi.fn((id: string) => `/artifacts/${id}/blob`),
  listArtifacts: vi.fn(),
  getArtifact: vi.fn(),
}));

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

describe("TaskDetail — Artifacts tab", () => {
  it("shows Overview and Artifacts tabs", async () => {
    renderTaskDetail("task-001");
    await waitFor(() => {
      expect(screen.getByTestId("tab-overview")).toBeInTheDocument();
      expect(screen.getByTestId("tab-artifacts")).toBeInTheDocument();
    });
  });

  it("defaults to Overview tab (overview content visible, artifact list not)", async () => {
    renderTaskDetail("task-001");
    await waitFor(() => {
      expect(screen.getByTestId("tab-overview")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("artifacts-tab-content")).not.toBeInTheDocument();
  });

  it("click Artifacts tab loads /tasks/:id/artifacts and renders ArtifactList with task_id rows", async () => {
    let capturedUrl: string | null = null;
    server.use(
      http.get("/tasks/:id/artifacts", ({ request, params }) => {
        capturedUrl = request.url;
        return HttpResponse.json({
          artifacts: [
            {
              id: "art-tab-1",
              sourceKind: "task_published",
              taskId: params.id,
              kind: "file",
              mime: "audio/mpeg",
              originalFilename: "recording.mp3",
              sizeBytes: 512000,
              createdAt: Date.now() - 3000,
            },
            {
              id: "art-tab-2",
              sourceKind: "task_published",
              taskId: params.id,
              kind: "file",
              mime: "text/plain",
              originalFilename: "notes.txt",
              sizeBytes: 1024,
              createdAt: Date.now() - 1000,
            },
          ],
          total: 2,
        });
      }),
    );

    renderTaskDetail("task-001");

    // Wait for task to load
    await waitFor(() => {
      expect(screen.getByTestId("tab-artifacts")).toBeInTheDocument();
    });

    // Click Artifacts tab
    fireEvent.click(screen.getByTestId("tab-artifacts"));

    // Artifact list should appear with the two rows
    await waitFor(() => {
      expect(screen.getByTestId("artifact-list")).toBeInTheDocument();
    });

    expect(screen.getByTestId("artifact-row-art-tab-1")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-row-art-tab-2")).toBeInTheDocument();
    expect(screen.getByText("recording.mp3")).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();

    // Confirm the fetch URL included the task id
    expect(capturedUrl).toContain("/tasks/task-001/artifacts");
  });

  it("shows empty state when task has no artifacts", async () => {
    server.use(
      http.get("/tasks/:id/artifacts", () => {
        return HttpResponse.json({ artifacts: [], total: 0 });
      }),
    );

    renderTaskDetail("task-001");

    await waitFor(() => {
      expect(screen.getByTestId("tab-artifacts")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("tab-artifacts"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-list-empty")).toBeInTheDocument();
    });
  });

  it("shows error state when artifacts fetch fails", async () => {
    server.use(
      http.get("/tasks/:id/artifacts", () => {
        return HttpResponse.json({ error: "Server error" }, { status: 500 });
      }),
    );

    renderTaskDetail("task-001");

    await waitFor(() => {
      expect(screen.getByTestId("tab-artifacts")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("tab-artifacts"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-list-error")).toBeInTheDocument();
    });
  });
});
