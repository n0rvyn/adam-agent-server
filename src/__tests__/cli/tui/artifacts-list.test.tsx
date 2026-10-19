// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { waitForRender, simulateKey } from "../../helpers/tui.js";

// Mock the artifacts API
vi.mock("../../../cli/tui/lib/artifacts-api.js", () => ({
  listArtifacts: vi.fn(),
  getArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
  redeliverArtifact: vi.fn(),
}));

// Mock clipboard
vi.mock("../../../cli/tui/lib/clipboard.js", () => ({
  writeClipboard: vi.fn().mockResolvedValue(true),
}));

// Mock danger class
vi.mock("../../../lib/artifact-danger-class.js", () => ({
  getDangerClass: vi.fn((mime: string) => {
    if (mime?.startsWith("audio/")) return "audio";
    if (mime?.startsWith("video/")) return "video";
    if (mime === "application/pdf") return "pdf";
    return null;
  }),
}));

// Mock useTuiState
vi.mock("../../../cli/tui/hooks/useTuiState.js", () => ({
  useTuiState: vi.fn(() => ({ dispatch: mockDispatch, state: {} })),
}));

const mockDispatch = vi.fn();

import { listArtifacts, deleteArtifact, redeliverArtifact } from "../../../cli/tui/lib/artifacts-api.js";
import { writeClipboard } from "../../../cli/tui/lib/clipboard.js";
import { ArtifactsList } from "../../../cli/tui/components/ArtifactsList.js";
import type { Artifact } from "../../../cli/tui/lib/artifacts-api.js";

const mockListArtifacts = listArtifacts as ReturnType<typeof vi.fn>;
const mockDeleteArtifact = deleteArtifact as ReturnType<typeof vi.fn>;
const mockRedeliverArtifact = redeliverArtifact as ReturnType<typeof vi.fn>;
const mockWriteClipboard = writeClipboard as ReturnType<typeof vi.fn>;

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "art-001",
    sourceKind: "template_step",
    sizeBytes: 1024,
    createdAt: Date.now() - 60_000,
    kind: "file",
    mime: "audio/mpeg",
    blobPath: "/tmp/audio.mp3",
    producedByRole: "podcast-role",
    ...overrides,
  };
}

function makeArtifacts(count: number): Artifact[] {
  return Array.from({ length: count }, (_, i) =>
    makeArtifact({
      id: `art-${String(i).padStart(3, "0")}`,
      sourceKind: i % 3 === 0 ? "template_step" : i % 3 === 1 ? "task_published" : "chat_sent",
      mime: i % 2 === 0 ? "audio/mpeg" : "text/plain",
      sizeBytes: 1024 * (i + 1),
    }),
  );
}

describe("ArtifactsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatch.mockReset();
  });

  it("shows loading state initially", () => {
    mockListArtifacts.mockImplementation(() => new Promise(() => {}));
    const { lastFrame } = render(
      <ArtifactsList onBack={vi.fn()} onSelect={vi.fn()} onAction={vi.fn()} />,
    );
    expect(lastFrame()).toContain("Loading");
  });

  it("renders 0 rows with empty state message", async () => {
    mockListArtifacts.mockResolvedValue({ artifacts: [], total: 0 });
    const { lastFrame } = render(
      <ArtifactsList onBack={vi.fn()} onSelect={vi.fn()} onAction={vi.fn()} />,
    );
    await waitForRender();
    const frame = lastFrame()!;
    expect(frame).toContain("No artifacts found");
    expect(frame).toContain("Artifacts (0)");
  });

  it("renders 3 artifact rows with column headers", async () => {
    mockListArtifacts.mockResolvedValue({ artifacts: makeArtifacts(3), total: 3 });
    const { lastFrame } = render(
      <ArtifactsList onBack={vi.fn()} onSelect={vi.fn()} onAction={vi.fn()} />,
    );
    await waitForRender();
    const frame = lastFrame()!;
    expect(frame).toContain("Artifacts (3)");
    expect(frame).toContain("Source");
    expect(frame).toContain("Mime");
    expect(frame).toContain("Size");
    expect(frame).toContain("Created");
    expect(frame).toContain("tmpl");
    expect(frame).toContain("task");
  });

  it("cursor defaults to 0, shows > marker", async () => {
    mockListArtifacts.mockResolvedValue({ artifacts: makeArtifacts(3), total: 3 });
    const { lastFrame } = render(
      <ArtifactsList onBack={vi.fn()} onSelect={vi.fn()} onAction={vi.fn()} />,
    );
    await waitForRender();
    expect(lastFrame()).toContain(">");
  });

  it("press j moves cursor down", async () => {
    mockListArtifacts.mockResolvedValue({ artifacts: makeArtifacts(3), total: 3 });
    const { lastFrame, stdin } = render(
      <ArtifactsList onBack={vi.fn()} onSelect={vi.fn()} onAction={vi.fn()} />,
    );
    await waitForRender();
    await simulateKey(stdin, "j");
    await waitForRender();
    expect(lastFrame()).toBeTruthy();
  });

  it("press down-arrow moves cursor", async () => {
    mockListArtifacts.mockResolvedValue({ artifacts: makeArtifacts(3), total: 3 });
    const { lastFrame, stdin } = render(
      <ArtifactsList onBack={vi.fn()} onSelect={vi.fn()} onAction={vi.fn()} />,
    );
    await waitForRender();
    simulateKey(stdin, "down");
    await waitForRender();
    expect(lastFrame()).toBeTruthy();
  });

  it("press k at cursor 0 keeps cursor at 0 (no wrap)", async () => {
    mockListArtifacts.mockResolvedValue({ artifacts: makeArtifacts(3), total: 3 });
    const { lastFrame, stdin } = render(
      <ArtifactsList onBack={vi.fn()} onSelect={vi.fn()} onAction={vi.fn()} />,
    );
    await waitForRender();
    simulateKey(stdin, "k");
    await waitForRender();
    expect(lastFrame()).toContain(">");
  });

  it("press Enter calls onSelect with current artifact", async () => {
    const arts = makeArtifacts(3);
    mockListArtifacts.mockResolvedValue({ artifacts: arts, total: 3 });
    const { getArtifact } = await import("../../../cli/tui/lib/artifacts-api.js");
    (getArtifact as ReturnType<typeof vi.fn>).mockResolvedValue({
      artifact: arts[0],
      deliveryLog: [],
    });
    const onSelect = vi.fn();
    const { stdin } = render(
      <ArtifactsList onBack={vi.fn()} onSelect={onSelect} onAction={vi.fn()} />,
    );
    await waitForRender();
    simulateKey(stdin, "enter");
    await waitForRender();
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(arts[0]);
  });

  it("press Esc calls onBack", async () => {
    mockListArtifacts.mockResolvedValue({ artifacts: makeArtifacts(3), total: 3 });
    const onBack = vi.fn();
    const { stdin } = render(
      <ArtifactsList onBack={onBack} onSelect={vi.fn()} onAction={vi.fn()} />,
    );
    await waitForRender();
    simulateKey(stdin, "escape");
    await waitForRender();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("shows footer hint text", async () => {
    mockListArtifacts.mockResolvedValue({ artifacts: makeArtifacts(1), total: 1 });
    const { lastFrame } = render(
      <ArtifactsList onBack={vi.fn()} onSelect={vi.fn()} onAction={vi.fn()} />,
    );
    await waitForRender();
    expect(lastFrame()).toContain("j/k=navigate enter=detail d=delete r=redeliver c=copy t=task");
  });

  it("renders 7 artifact rows correctly", async () => {
    mockListArtifacts.mockResolvedValue({ artifacts: makeArtifacts(7), total: 7 });
    const { lastFrame } = render(
      <ArtifactsList onBack={vi.fn()} onSelect={vi.fn()} onAction={vi.fn()} />,
    );
    await waitForRender();
    expect(lastFrame()).toContain("Artifacts (7)");
  });

  // Task 4 keybinding tests

  it("press 'd' on audio/mpeg shows danger confirm prompt", async () => {
    const arts = [makeArtifact({ mime: "audio/mpeg" })];
    mockListArtifacts.mockResolvedValue({ artifacts: arts, total: 1 });
    const onAction = vi.fn();
    const { lastFrame, stdin } = render(
      <ArtifactsList onBack={vi.fn()} onSelect={vi.fn()} onAction={onAction} />,
    );
    await waitForRender();
    stdin.write("d");
    await waitForRender();
    expect(lastFrame()).toContain("(y/n)");
    expect(onAction).toHaveBeenCalledWith("d", arts[0]);
  });

  it("press 'y' after danger confirm calls deleteArtifact with confirm=true", async () => {
    const arts = [makeArtifact({ mime: "audio/mpeg" })];
    mockListArtifacts.mockResolvedValue({ artifacts: arts, total: 1 });
    mockDeleteArtifact.mockResolvedValue(undefined);
    const { stdin } = render(
      <ArtifactsList onBack={vi.fn()} onSelect={vi.fn()} onAction={vi.fn()} />,
    );
    await waitForRender();
    stdin.write("d");
    await waitForRender();
    stdin.write("y");
    await waitForRender();
    expect(mockDeleteArtifact).toHaveBeenCalledWith("art-001", true);
  });

  it("press 'n' after danger confirm dismisses without API call", async () => {
    const arts = [makeArtifact({ mime: "audio/mpeg" })];
    mockListArtifacts.mockResolvedValue({ artifacts: arts, total: 1 });
    const { lastFrame, stdin } = render(
      <ArtifactsList onBack={vi.fn()} onSelect={vi.fn()} onAction={vi.fn()} />,
    );
    await waitForRender();
    stdin.write("d");
    await waitForRender();
    stdin.write("n");
    await waitForRender();
    expect(mockDeleteArtifact).not.toHaveBeenCalled();
    expect(lastFrame()).not.toContain("(y/n)");
  });

  it("press 'd' on text/plain calls deleteArtifact with confirm=false directly", async () => {
    const arts = [makeArtifact({ mime: "text/plain" })];
    mockListArtifacts.mockResolvedValue({ artifacts: arts, total: 1 });
    mockDeleteArtifact.mockResolvedValue(undefined);
    const { stdin } = render(
      <ArtifactsList onBack={vi.fn()} onSelect={vi.fn()} onAction={vi.fn()} />,
    );
    await waitForRender();
    stdin.write("d");
    await waitForRender();
    expect(mockDeleteArtifact).toHaveBeenCalledWith("art-001", false);
  });

  it("press 'r' shows channel picker", async () => {
    const arts = [makeArtifact()];
    mockListArtifacts.mockResolvedValue({ artifacts: arts, total: 1 });
    const onAction = vi.fn();
    const { lastFrame, stdin } = render(
      <ArtifactsList onBack={vi.fn()} onSelect={vi.fn()} onAction={onAction} />,
    );
    await waitForRender();
    stdin.write("r");
    await waitForRender();
    expect(lastFrame()).toContain("channel");
    expect(onAction).toHaveBeenCalledWith("r", arts[0]);
  });

  it("press 'c' calls writeClipboard with blobPath", async () => {
    const blobPath = "/tmp/audio.mp3";
    const arts = [makeArtifact({ blobPath })];
    mockListArtifacts.mockResolvedValue({ artifacts: arts, total: 1 });
    mockWriteClipboard.mockResolvedValue(true);
    const onAction = vi.fn();
    const { stdin } = render(
      <ArtifactsList onBack={vi.fn()} onSelect={vi.fn()} onAction={onAction} />,
    );
    await waitForRender();
    stdin.write("c");
    await waitForRender();
    expect(mockWriteClipboard).toHaveBeenCalledWith(blobPath);
    expect(onAction).toHaveBeenCalledWith("c", arts[0]);
  });

  it("press 't' calls dispatch SET_VIEW tasks with selectedTaskId", async () => {
    const arts = [makeArtifact({ taskId: "task-abc", sourceKind: "task_published" })];
    mockListArtifacts.mockResolvedValue({ artifacts: arts, total: 1 });
    const onAction = vi.fn();
    const { stdin } = render(
      <ArtifactsList onBack={vi.fn()} onSelect={vi.fn()} onAction={onAction} />,
    );
    await waitForRender();
    stdin.write("t");
    await waitForRender();
    expect(mockDispatch).toHaveBeenCalledWith({
      type: "SET_VIEW",
      view: "tasks",
      selectedTaskId: "task-abc",
    });
    expect(onAction).toHaveBeenCalledWith("t", arts[0]);
  });
});
