// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { waitForRender } from "../../helpers/tui.js";

vi.mock("../../../cli/client.js", () => ({
  request: vi.fn(),
}));

import { request } from "../../../cli/client.js";
import { TemplateList } from "../../../cli/tui/components/TemplateList.js";

const mockRequest = request as ReturnType<typeof vi.fn>;

describe("TemplateList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state initially", () => {
    mockRequest.mockImplementation(() => new Promise(() => {}));
    const { lastFrame } = render(<TemplateList onBack={vi.fn()} />);
    expect(lastFrame()).toContain("Loading templates");
  });

  it("shows empty state when no templates", async () => {
    mockRequest.mockResolvedValue({ templates: [] });
    const { lastFrame } = render(<TemplateList onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("No templates found");
  });

  it("displays multi-step template with new step fields read-only", async () => {
    const templates = [
      {
        id: "tmpl-001",
        name: "Podcast Pipeline",
        trigger: { type: "cron", cron: "0 8 * * *" },
        enabled: true,
        steps: [
          {
            id: "step-1",
            prompt: "Collect podcast material",
            dependsOn: [],
            consumesFrom: ["step-0"],
            persona: { speakAs: "Alice", voiceConstraints: "conversational" },
            outputContract: {
              contractRules: [
                { kind: "lengthTarget", min: 1000, max: 1500, unit: "characters" },
                { kind: "format", value: "markdown" },
              ],
              mustReferenceArtifacts: true,
            },
          },
          {
            id: "step-2",
            prompt: "Write podcast script",
            dependsOn: ["step-1"],
            consumesFromOptional: ["step-1"],
          },
          {
            id: "step-3",
            prompt: "Render audio",
            dependsOn: ["step-2"],
          },
        ],
      },
    ];
    mockRequest.mockResolvedValue({ templates });
    const { lastFrame } = render(<TemplateList onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;

    // TUI renders with line wrapping; check for substrings that won't be split
    expect(frame).toContain("consumes:");
    expect(frame).toContain("step-0");
    expect(frame).toContain("speak as:");
    expect(frame).toContain("Alice");
    expect(frame).toContain("conversational");
    // Display now summarizes the contract by joining rule kinds (display-only, derived from contractRules).
    expect(frame).toContain("lengthTarget");
    expect(frame).toContain("format");
    expect(frame).toContain("ref-artifacts");
    expect(frame).toContain("consumes?:");
    expect(frame).toContain("step-1");
  });

  it("does not render new field chips when fields are absent", async () => {
    const templates = [
      {
        id: "tmpl-002",
        name: "Simple Template",
        trigger: { type: "manual" },
        enabled: true,
        steps: [
          { id: "step-1", prompt: "Do the thing" },
        ],
      },
    ];
    mockRequest.mockResolvedValue({ templates });
    const { lastFrame } = render(<TemplateList onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;

    // No new-field read-only chips should appear
    expect(frame).not.toContain("consumes:");
    expect(frame).not.toContain("speak as:");
    expect(frame).not.toContain("characters");
  });

  it("renders delivery line with primary-artifact config when template has delivery", async () => {
    const templates = [
      {
        id: "tmpl-delivery",
        name: "Podcast Template",
        trigger: { type: "cron", cron: "0 8 * * *" },
        enabled: true,
        steps: [
          { id: "step-1", prompt: "Draft" },
          { id: "快刀润色", prompt: "Polish" },
        ],
        config: {
          delivery: {
            mode: "primary-artifact",
            primaryArtifact: { stepId: "快刀润色", key: "podcast-script-final" },
          },
        },
      },
    ];
    mockRequest.mockResolvedValue({ templates });
    const { lastFrame } = render(<TemplateList onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;

    // Delivery line must appear with mode + stepId + key
    expect(frame).toContain("Delivery: primary-artifact");
    expect(frame).toContain("快刀润色/podcast-script-final");
  });

  it("renders no delivery line when template has no delivery config", async () => {
    const templates = [
      {
        id: "tmpl-no-delivery",
        name: "Plain Cron",
        trigger: { type: "cron", cron: "0 9 * * *" },
        enabled: true,
        steps: [{ id: "step-1", prompt: "Run report" }],
        // No config.delivery
      },
    ];
    mockRequest.mockResolvedValue({ templates });
    const { lastFrame } = render(<TemplateList onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;

    // Delivery label must NOT appear (default mode is implicit)
    expect(frame).not.toContain("Delivery:");
    expect(frame).not.toContain("concat-step-results");
  });
});
