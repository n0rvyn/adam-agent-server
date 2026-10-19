// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { waitForRender, simulateKey } from "../../helpers/tui.js";
import { ArtifactDetail } from "../../../cli/tui/components/ArtifactDetail.js";
import type { Artifact } from "../../../cli/tui/lib/artifacts-api.js";

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "art-detail-001",
    sourceKind: "template_step",
    sizeBytes: 2048,
    createdAt: new Date("2026-05-18T10:00:00Z").getTime(),
    kind: "file",
    mime: "audio/mpeg",
    blobPath: "/tmp/podcast.mp3",
    producedByRole: "podcast-role",
    executionId: "exec-123",
    key: "podcast.mp3",
    originalFilename: "episode-42.mp3",
    ...overrides,
  };
}

describe("ArtifactDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders artifact metadata fields", async () => {
    const art = makeArtifact();
    const { lastFrame } = render(
      <ArtifactDetail artifact={art} deliveryLog={[]} onBack={vi.fn()} />,
    );
    await waitForRender();
    const frame = lastFrame()!;

    expect(frame).toContain("art-detail-001");
    expect(frame).toContain("template_step");
    expect(frame).toContain("podcast-role");
    expect(frame).toContain("audio/mpeg");
    expect(frame).toContain("/tmp/podcast.mp3");
    expect(frame).toContain("exec-123");
    expect(frame).toContain("podcast.mp3");
    expect(frame).toContain("episode-42.mp3");
  });

  it("renders delivery log entries", async () => {
    const art = makeArtifact();
    const log = [
      { status: "delivered", target: { channelId: "ch-wechat" }, createdAt: Date.now() },
      { status: "failed", target: { channelId: "ch-telegram" }, createdAt: Date.now() - 5000 },
    ];
    const { lastFrame } = render(
      <ArtifactDetail artifact={art} deliveryLog={log} onBack={vi.fn()} />,
    );
    await waitForRender();
    const frame = lastFrame()!;

    expect(frame).toContain("Delivery Log (2)");
    expect(frame).toContain("delivered");
    expect(frame).toContain("ch-wechat");
    expect(frame).toContain("failed");
    expect(frame).toContain("ch-telegram");
  });

  it("shows 'No delivery log entries' when log is empty", async () => {
    const art = makeArtifact();
    const { lastFrame } = render(
      <ArtifactDetail artifact={art} deliveryLog={[]} onBack={vi.fn()} />,
    );
    await waitForRender();
    expect(lastFrame()).toContain("No delivery log entries");
  });

  it("Esc calls onBack", async () => {
    const art = makeArtifact();
    const onBack = vi.fn();
    const { stdin } = render(
      <ArtifactDetail artifact={art} deliveryLog={[]} onBack={onBack} />,
    );
    await waitForRender();
    simulateKey(stdin, "escape");
    await waitForRender();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("shows task_id when sourceKind is task_published", async () => {
    const art = makeArtifact({
      sourceKind: "task_published",
      taskId: "task-abc",
      executionId: undefined,
    });
    const { lastFrame } = render(
      <ArtifactDetail artifact={art} deliveryLog={[]} onBack={vi.fn()} />,
    );
    await waitForRender();
    expect(lastFrame()).toContain("task-abc");
  });

  it("shows header with Esc hint", async () => {
    const art = makeArtifact();
    const { lastFrame } = render(
      <ArtifactDetail artifact={art} deliveryLog={[]} onBack={vi.fn()} />,
    );
    await waitForRender();
    expect(lastFrame()).toContain("Esc to go back");
  });
});
