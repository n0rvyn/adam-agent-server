// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { waitForRender, waitForInputReady } from "../../helpers/tui.js";

vi.mock("../../../cli/client.js", () => ({
  request: vi.fn().mockImplementation((url: string) => {
    if (url.includes("/goals")) return Promise.resolve({ goals: [] });
    if (url.includes("/task-templates")) return Promise.resolve({ templates: [] });
    return Promise.resolve({ tasks: [], total: 0 });
  }),
}));

vi.mock("ink-text-input", () => ({
  default: () => React.createElement("span", null, "[TextInput]"),
}));

import { WorkView } from "../../../cli/tui/components/WorkView.js";

describe("WorkView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders tab bar with all three tabs", async () => {
    const { lastFrame } = render(<WorkView onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;
    expect(frame).toContain("Work Surface");
    expect(frame).toContain("1. Tasks");
    expect(frame).toContain("2. Automations");
    expect(frame).toContain("3. Goals");
  });

  it("defaults to Tasks tab", async () => {
    const { lastFrame } = render(<WorkView onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("● 1. Tasks");
  });

  it("switches to Automations tab on key 2", async () => {
    const { lastFrame, stdin } = render(<WorkView onBack={vi.fn()} />);
    await waitForInputReady();

    stdin.write("2");
    await waitForRender();

    // Automations tab content renders (TemplateList)
    const frame = lastFrame()!;
    expect(frame).toContain("Automations");
  });

  it("switches to Goals tab on key 3", async () => {
    const { lastFrame, stdin } = render(<WorkView onBack={vi.fn()} />);
    await waitForInputReady();

    stdin.write("3");
    await waitForRender();

    const frame = lastFrame()!;
    expect(frame).toContain("● 3. Goals");
  });

  it("calls onBack on Escape", async () => {
    const onBack = vi.fn();
    const { stdin } = render(<WorkView onBack={onBack} />);
    await waitForInputReady();
    stdin.write("\x1B");
    expect(onBack).toHaveBeenCalled();
  });
});
