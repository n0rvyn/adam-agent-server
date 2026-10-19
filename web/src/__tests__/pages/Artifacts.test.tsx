import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "../utils/test-utils";

// Mock api module
vi.mock("@/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api.ts")>();
  return {
    ...actual,
    api: vi.fn().mockResolvedValue({ roles: [] }),
  };
});

// Mock artifacts API
vi.mock("@/lib/api/artifacts.ts", () => ({
  listArtifacts: vi.fn(),
  getArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
  redeliverArtifact: vi.fn(),
  downloadArtifactBlob: vi.fn(),
  artifactBlobUrl: vi.fn((id: string) => `/artifacts/${id}/blob`),
}));

import { listArtifacts } from "@/lib/api/artifacts.ts";
import { useArtifactsStore } from "@/store/artifactsSlice.ts";
import { Artifacts } from "@/pages/Artifacts.tsx";
import type { Artifact } from "@/lib/types.ts";

const mockListArtifacts = vi.mocked(listArtifacts);

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "art-1",
    sourceKind: "task_published",
    taskId: "task-1",
    kind: "file",
    mime: "audio/mpeg",
    originalFilename: "podcast.mp3",
    sizeBytes: 5000000,
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useArtifactsStore.setState({
    list: [],
    total: 0,
    filter: { limit: 50, offset: 0 },
    selectedId: null,
    selectedDetail: null,
    loading: false,
    error: null,
  });
});

describe("Artifacts page", () => {
  it("renders empty state when no artifacts", async () => {
    mockListArtifacts.mockResolvedValueOnce({ artifacts: [], total: 0 });
    render(<Artifacts />);
    await waitFor(() => {
      expect(screen.getByTestId("artifact-list-empty")).toBeInTheDocument();
    });
  });

  it("renders 3 artifacts from different source_kinds", async () => {
    const artifacts = [
      makeArtifact({ id: "art-1", sourceKind: "task_published" }),
      makeArtifact({ id: "art-2", sourceKind: "template_step", mime: "image/png", originalFilename: "photo.png" }),
      makeArtifact({ id: "art-3", sourceKind: "chat_sent", mime: "text/plain", originalFilename: "notes.txt" }),
    ];
    mockListArtifacts.mockResolvedValue({ artifacts, total: 3 });
    render(<Artifacts />);
    await waitFor(() => {
      expect(screen.getByTestId("artifact-row-art-1")).toBeInTheDocument();
      expect(screen.getByTestId("artifact-row-art-2")).toBeInTheDocument();
      expect(screen.getByTestId("artifact-row-art-3")).toBeInTheDocument();
    });
  });

  it("click chip Audio calls applyFilter with mime_prefix=audio/", async () => {
    mockListArtifacts.mockResolvedValue({ artifacts: [], total: 0 });
    render(<Artifacts />);
    await waitFor(() => screen.getByTestId("chip-audio"));
    fireEvent.click(screen.getByTestId("chip-audio"));
    await waitFor(() => {
      expect(mockListArtifacts).toHaveBeenCalledWith(
        expect.objectContaining({ mime_prefix: "audio/" }),
      );
    });
  });

  it("click row calls select with artifact id", async () => {
    const artifacts = [makeArtifact({ id: "art-1" })];
    mockListArtifacts.mockResolvedValue({ artifacts, total: 1 });
    const selectSpy = vi.fn();
    useArtifactsStore.setState({ select: selectSpy } as never);
    render(<Artifacts />);
    await waitFor(() => screen.getByTestId("artifact-row-art-1"));
    fireEvent.click(screen.getByTestId("artifact-row-art-1"));
    expect(selectSpy).toHaveBeenCalledWith("art-1");
  });

  it("source_kind dropdown change calls applyFilter with source_kind", async () => {
    mockListArtifacts.mockResolvedValue({ artifacts: [], total: 0 });
    render(<Artifacts />);
    await waitFor(() => screen.getByTestId("advanced-filters-toggle"));
    fireEvent.click(screen.getByTestId("advanced-filters-toggle"));
    const select = screen.getByTestId("filter-source-kind");
    fireEvent.change(select, { target: { value: "template_step" } });
    await waitFor(() => {
      expect(mockListArtifacts).toHaveBeenCalledWith(
        expect.objectContaining({ source_kind: "template_step" }),
      );
    });
  });

  it("delivery_status dropdown change calls applyFilter with delivery_status", async () => {
    mockListArtifacts.mockResolvedValue({ artifacts: [], total: 0 });
    render(<Artifacts />);
    await waitFor(() => screen.getByTestId("advanced-filters-toggle"));
    fireEvent.click(screen.getByTestId("advanced-filters-toggle"));
    const select = screen.getByTestId("filter-delivery-status");
    fireEvent.change(select, { target: { value: "delivered" } });
    await waitFor(() => {
      expect(mockListArtifacts).toHaveBeenCalledWith(
        expect.objectContaining({ delivery_status: "delivered" }),
      );
    });
  });

  it("Advanced filters toggle expands and collapses the panel", async () => {
    mockListArtifacts.mockResolvedValue({ artifacts: [], total: 0 });
    render(<Artifacts />);
    await waitFor(() => screen.getByTestId("advanced-filters-toggle"));

    // Panel should be collapsed initially
    expect(screen.queryByTestId("advanced-filters-panel")).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByTestId("advanced-filters-toggle"));
    expect(screen.getByTestId("advanced-filters-panel")).toBeInTheDocument();

    // Click to collapse
    fireEvent.click(screen.getByTestId("advanced-filters-toggle"));
    expect(screen.queryByTestId("advanced-filters-panel")).not.toBeInTheDocument();
  });

  it("date range 'from' change calls applyFilter with timestamp", async () => {
    mockListArtifacts.mockResolvedValue({ artifacts: [], total: 0 });
    render(<Artifacts />);
    await waitFor(() => screen.getByTestId("advanced-filters-toggle"));
    fireEvent.click(screen.getByTestId("advanced-filters-toggle"));
    const input = screen.getByTestId("filter-from");
    fireEvent.change(input, { target: { value: "2026-01-01" } });
    await waitFor(() => {
      expect(mockListArtifacts).toHaveBeenCalledWith(
        expect.objectContaining({ from: expect.any(Number) }),
      );
    });
  });
});
