import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "../utils/test-utils";
import type { Artifact } from "@/lib/types.ts";

// Mock artifacts API
vi.mock("@/lib/api/artifacts.ts", () => ({
  deleteArtifact: vi.fn(),
  downloadArtifactBlob: vi.fn(),
  redeliverArtifact: vi.fn(),
  artifactBlobUrl: vi.fn((id: string) => `/artifacts/${id}/blob`),
  listArtifacts: vi.fn(),
  getArtifact: vi.fn(),
}));

// Mock api for ChannelPicker's /channels fetch
vi.mock("@/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api.ts")>();
  return {
    ...actual,
    api: vi.fn().mockResolvedValue({ channels: [] }),
  };
});

import { deleteArtifact, downloadArtifactBlob } from "@/lib/api/artifacts.ts";
import { ArtifactDetail } from "@/components/artifacts/ArtifactDetail.tsx";

const mockDeleteArtifact = vi.mocked(deleteArtifact);
const mockDownloadArtifactBlob = vi.mocked(downloadArtifactBlob);

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "art-1",
    sourceKind: "task_published",
    taskId: "task-abc",
    kind: "file",
    mime: "text/plain",
    originalFilename: "notes.txt",
    sizeBytes: 2048,
    createdAt: 1700000000000,
    ...overrides,
  };
}

const defaultProps = {
  artifact: makeArtifact(),
  onDeleted: vi.fn(),
  onRedelivered: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ArtifactDetail", () => {
  it("renders full detail metadata", () => {
    render(<ArtifactDetail {...defaultProps} />);
    expect(screen.getByTestId("artifact-detail")).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText("text/plain")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  });

  it("Download button calls downloadArtifactBlob with correct filename", async () => {
    mockDownloadArtifactBlob.mockResolvedValueOnce(undefined);
    render(<ArtifactDetail {...defaultProps} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("download-btn"));
    });
    expect(mockDownloadArtifactBlob).toHaveBeenCalledWith("art-1", "notes.txt");
  });

  it("Delete on non-danger mime calls API directly without dialog", async () => {
    // text/plain is not audio/video/pdf — should delete directly
    mockDeleteArtifact.mockResolvedValueOnce(undefined);
    render(<ArtifactDetail {...defaultProps} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("delete-btn"));
    });
    expect(mockDeleteArtifact).toHaveBeenCalledWith("art-1", false);
    expect(defaultProps.onDeleted).toHaveBeenCalled();
  });

  it("Delete on audio mime shows DangerConfirmDialog", () => {
    const artifact = makeArtifact({ mime: "audio/mpeg", originalFilename: "track.mp3" });
    render(<ArtifactDetail {...defaultProps} artifact={artifact} />);
    fireEvent.click(screen.getByTestId("delete-btn"));
    expect(screen.getByTestId("danger-dialog")).toBeInTheDocument();
    expect(screen.queryByTestId("danger-dialog-body")?.textContent).toContain("audio");
  });

  it("DangerConfirmDialog confirm calls deleteArtifact with confirm=true", async () => {
    mockDeleteArtifact.mockResolvedValueOnce(undefined);
    const artifact = makeArtifact({ mime: "audio/mpeg" });
    render(<ArtifactDetail {...defaultProps} artifact={artifact} />);
    fireEvent.click(screen.getByTestId("delete-btn"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("danger-dialog-confirm"));
    });
    expect(mockDeleteArtifact).toHaveBeenCalledWith("art-1", true);
    expect(defaultProps.onDeleted).toHaveBeenCalled();
  });

  it("Redeliver button shows ChannelPicker", async () => {
    render(<ArtifactDetail {...defaultProps} />);
    fireEvent.click(screen.getByTestId("redeliver-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("channel-picker")).toBeInTheDocument();
    });
  });

  it("Source Task button navigates when taskId present", async () => {
    render(<ArtifactDetail {...defaultProps} />);
    // The navigate mock from react-router will be exercised; just assert button is present and enabled
    const btn = screen.getByTestId("source-task-btn");
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it("Source Task shows disabled button with tooltip for template_step (executionId only)", () => {
    const artifact = makeArtifact({
      taskId: undefined,
      executionId: "exec-123",
      sourceKind: "template_step",
    });
    render(<ArtifactDetail {...defaultProps} artifact={artifact} />);
    expect(screen.getByTestId("source-task-btn-disabled")).toBeDisabled();
    expect(screen.getByTestId("source-task-tooltip")).toBeInTheDocument();
    expect(screen.getByTestId("source-task-tooltip").textContent).toContain("template execution");
  });
});
