// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { waitForRender, waitForInputReady } from "../../helpers/tui.js";

vi.mock("../../../cli/client.js", () => ({
  request: vi.fn(),
}));

import { request } from "../../../cli/client.js";
import { PluginList } from "../../../cli/tui/components/PluginList.js";

const mockRequest = request as ReturnType<typeof vi.fn>;

describe("PluginList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state", () => {
    mockRequest.mockImplementation(() => new Promise(() => {}));
    const { lastFrame } = render(<PluginList onBack={vi.fn()} />);
    expect(lastFrame()).toContain("Loading plugins...");
  });

  it("shows empty state when no plugins", async () => {
    mockRequest.mockResolvedValue({ plugins: [] });
    const { lastFrame } = render(<PluginList onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("No plugins installed.");
  });

  it("displays plugin list with id-based name, scope, and globalEnabled", async () => {
    const plugins = [
      { id: "test-plugin@mkt", version: "1.0.0", scope: "user", installPath: "/test/p", enabled: true, installedAt: "", lastUpdated: "", globalEnabled: true },
    ];
    mockRequest.mockResolvedValue({ plugins });
    const { lastFrame } = render(<PluginList onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;
    // Component displays p.id.split("@")[0] as name
    expect(frame).toContain("test-plugin");
    expect(frame).toContain("user");
    expect(frame).toContain("on");
  });

  it("shows 'off' for globalEnabled=false plugins", async () => {
    const plugins = [
      { id: "test-plugin@mkt", version: "1.0.0", scope: "user", installPath: "/test/p", enabled: true, installedAt: "", lastUpdated: "", globalEnabled: false },
    ];
    mockRequest.mockResolvedValue({ plugins });

    const { lastFrame } = render(<PluginList onBack={vi.fn()} />);
    await waitForRender();

    expect(lastFrame()).toContain("off");
  });

  it("calls onBack on Escape", async () => {
    mockRequest.mockResolvedValue({ plugins: [] });
    const onBack = vi.fn();
    const { stdin } = render(<PluginList onBack={onBack} />);
    await waitForInputReady();
    stdin.write("\x1B");
    expect(onBack).toHaveBeenCalled();
  });
});
