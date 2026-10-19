// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { waitForRender } from "../../helpers/tui.js";

vi.mock("../../../cli/client.js", () => ({
  request: vi.fn(),
}));

vi.mock("../../../cli/tui/hooks/useTuiState.js", () => ({
  useTuiState: () => ({
    state: { configVersion: 0 },
    dispatch: vi.fn(),
  }),
}));

import { request } from "../../../cli/client.js";
import { SettingsView } from "../../../cli/tui/components/SettingsView.js";

const mockRequest = request as ReturnType<typeof vi.fn>;

const mockConfigResponse = {
  config: {
    "defaults.model": { value: "", mutable: true },
    "defaults.effort": { value: "high", mutable: true },
    "defaults.maxTurns": { value: 100, mutable: true },
    "defaults.maxBudgetUsd": { value: 5.0, mutable: true },
    "defaults.timeout": { value: 600, mutable: true },
    "server.port": { value: 7100, mutable: false },
    "server.host": { value: "0.0.0.0", mutable: false },
    "server.apiKey": { value: null, mutable: false },
    "logging.level": { value: "info", mutable: true },
    "roles.evolution.triggerEvery": { value: 5, mutable: true },
    "roles.evolution.reflectionThreshold": { value: 150, mutable: true },
  },
  mutable: [
    "defaults.model", "defaults.effort", "defaults.maxTurns",
    "defaults.maxBudgetUsd", "defaults.timeout", "logging.level",
    "roles.evolution.triggerEvery", "roles.evolution.reflectionThreshold",
  ],
  restartRequired: ["server.port", "server.host", "server.apiKey"],
};

describe("SettingsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock /config GET and /config/env-diff GET
    mockRequest.mockImplementation((url: string) => {
      if (url === "/config") {
        return Promise.resolve(mockConfigResponse);
      }
      if (url === "/config/env-diff") {
        return Promise.resolve({ diffs: [], envFileExists: false });
      }
      if (url === "/config/env") {
        return Promise.resolve({ env: {} });
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
  });

  it("renders settings grouped by category", async () => {
    mockRequest.mockResolvedValue(mockConfigResponse);
    const { lastFrame } = render(<SettingsView onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;
    expect(frame).toContain("Settings");
    expect(frame).toContain("Defaults");
    expect(frame).toContain("Logging");
    expect(frame).toContain("Evolution");
  });

  it("shows mutable config values", async () => {
    mockRequest.mockResolvedValue(mockConfigResponse);
    const { lastFrame } = render(<SettingsView onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;
    // Model field shows empty (env-driven)
    expect(frame).toContain("high");
    expect(frame).toContain("info");
  });

  it("marks restart-required fields with lock icon", async () => {
    mockRequest.mockResolvedValue(mockConfigResponse);
    const { lastFrame } = render(<SettingsView onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;
    expect(frame).toContain("restart required");
    expect(frame).toContain("\u{1F512}");
  });

  it("shows keyboard hints", async () => {
    mockRequest.mockResolvedValue(mockConfigResponse);
    const { lastFrame } = render(<SettingsView onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;
    expect(frame).toContain("Enter/e:edit");
    expect(frame).toContain("r:refresh");
  });

  it("shows error when request fails", async () => {
    mockRequest.mockRejectedValue(new Error("Connection refused"));
    const { lastFrame } = render(<SettingsView onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("Failed to load config");
    expect(lastFrame()).toContain("Connection refused");
  });

  it("shows selection indicator on current field", async () => {
    mockRequest.mockResolvedValue(mockConfigResponse);
    const { lastFrame } = render(<SettingsView onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("> ");
  });
});
