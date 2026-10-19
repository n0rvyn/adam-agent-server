import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "../utils/test-utils";
import { Settings } from "@/pages/Settings";

// Mock the api module
vi.mock("@/lib/api", () => ({
  api: vi.fn(),
  getStoredApiKey: () => "test-api-key-for-tests",
  setStoredApiKey: vi.fn(),
  clearStoredApiKey: vi.fn(),
  redirectToLogin: vi.fn(),
  rotateApiKey: vi.fn().mockResolvedValue("new-test-key"),
  verifyApiKey: vi.fn().mockResolvedValue(true),
}));

import { api } from "@/lib/api";
const mockApi = api as ReturnType<typeof vi.fn>;

const mockConfigResponse = {
  config: {
    "anthropic.apiKey": { value: "sk-an****", mutable: true },
    "anthropic.baseUrl": { value: "", mutable: true },
    "anthropic.model": { value: "", mutable: true },
    "anthropic.defaultOpusModel": { value: "", mutable: true },
    "anthropic.defaultSonnetModel": { value: "", mutable: true },
    "anthropic.defaultHaikuModel": { value: "", mutable: true },
    "anthropic.smallFastModel": { value: "", mutable: true },
    "defaults.model": { value: "claude-sonnet-4-6", mutable: true },
    "defaults.effort": { value: "high", mutable: true },
    "defaults.maxTurns": { value: 100, mutable: true },
    "defaults.maxBudgetUsd": { value: 5.0, mutable: true },
    "defaults.timeout": { value: 600, mutable: true },
    "server.port": { value: 7100, mutable: false },
    "server.host": { value: "0.0.0.0", mutable: false },
    "server.apiKey": { value: null, mutable: false },
    "server.timezone": { value: "system", mutable: true },
    "logging.level": { value: "info", mutable: true },
    "roles.evolution.triggerEvery": { value: 5, mutable: true },
    "roles.evolution.reflectionThreshold": { value: 150, mutable: true },
    "chat.sessionTimeoutMinutes": { value: 30, mutable: true },
    "chat.maxSessionTurns": { value: 20, mutable: true },
    "chat.autoTitle": { value: "true", mutable: true },
    "chat.archiveExtractMemory": { value: "true", mutable: true },
    "watchdog.rules.artifactCleanup.enabled": { value: true, mutable: true },
    "watchdog.rules.artifactCleanup.ttlDays": { value: 7, mutable: true },
    "watchdog.rules.artifactCleanup.orphanGcMinAgeHours": { value: 1, mutable: true },
  },
  mutable: [
    "anthropic.apiKey", "anthropic.baseUrl", "anthropic.model",
    "anthropic.defaultOpusModel", "anthropic.defaultSonnetModel",
    "anthropic.defaultHaikuModel", "anthropic.smallFastModel",
    "defaults.model", "defaults.effort", "defaults.maxTurns",
    "defaults.maxBudgetUsd", "defaults.timeout", "logging.level",
    "roles.evolution.triggerEvery", "roles.evolution.reflectionThreshold",
    "server.timezone",
    "chat.sessionTimeoutMinutes", "chat.maxSessionTurns",
    "chat.autoTitle", "chat.archiveExtractMemory",
    "watchdog.rules.artifactCleanup.enabled",
    "watchdog.rules.artifactCleanup.ttlDays",
    "watchdog.rules.artifactCleanup.orphanGcMinAgeHours",
  ],
  restartRequired: ["server.port", "server.host", "server.apiKey"],
};

const mockEnvDiffResponse = {
  diffs: [],
  envFileExists: false,
};

const mockEnvResponse = {
  env: {},
};

describe("Settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.mockImplementation((url: string) => {
      if (url === "/config/env-diff") return Promise.resolve(mockEnvDiffResponse);
      if (url === "/config/env") return Promise.resolve(mockEnvResponse);
      return Promise.resolve(mockConfigResponse);
    });
  });

  it("renders page title", async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
  });

  it("renders config categories", async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText("Defaults")).toBeInTheDocument();
      expect(screen.getByText("Logging")).toBeInTheDocument();
      expect(screen.getByText("Evolution")).toBeInTheDocument();
      expect(screen.getByText("Execution Artifacts")).toBeInTheDocument();
    });
  });

  it("renders mutable config values", async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByDisplayValue("claude-sonnet-4-6")).toBeInTheDocument();
      expect(screen.getByDisplayValue("100")).toBeInTheDocument();
    });
  });

  it("marks restart-required fields", async () => {
    render(<Settings />);
    await waitFor(() => {
      const restartTexts = screen.getAllByText("restart required");
      expect(restartTexts.length).toBeGreaterThan(0);
    });
  });

  it("disables restart-required fields", async () => {
    render(<Settings />);
    await waitFor(() => {
      const portInput = screen.getByDisplayValue("7100");
      expect(portInput).toBeDisabled();
    });
  });

  it("shows refresh button", async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
    // Refresh button exists (SVG icon)
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("renders Anthropic category", async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText("Anthropic")).toBeInTheDocument();
      expect(screen.getByText("API Key")).toBeInTheDocument();
      expect(screen.getByText("Base URL")).toBeInTheDocument();
    });
  });

  it("renders API Key as password input", async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText("API Key")).toBeInTheDocument();
    });
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    expect(passwordInputs.length).toBeGreaterThanOrEqual(1);
  });

  it("shows save button with count when field is modified", async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByDisplayValue("100")).toBeInTheDocument();
    });

    // Change a mutable field
    const maxTurnsInput = screen.getByDisplayValue("100");
    fireEvent.change(maxTurnsInput, { target: { value: "200" } });

    // Save button should appear with count
    await waitFor(() => {
      expect(screen.getByText("Save (1)")).toBeInTheDocument();
    });
  });

  it("shows modified indicator on dirty fields", async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByDisplayValue("100")).toBeInTheDocument();
    });

    const maxTurnsInput = screen.getByDisplayValue("100");
    fireEvent.change(maxTurnsInput, { target: { value: "200" } });

    await waitFor(() => {
      expect(screen.getByText("modified")).toBeInTheDocument();
    });
  });

  // Plan Task 10 DP-002: artifact cleanup config must be editable via PATCH /config.
  it("PATCHes /config with artifactCleanup.ttlDays when Execution Artifacts field is updated", async () => {
    mockApi.mockImplementation((url: string, options?: { method?: string }) => {
      if (url === "/config/env-diff") return Promise.resolve(mockEnvDiffResponse);
      if (url === "/config/env") return Promise.resolve(mockEnvResponse);
      if (url === "/config" && options?.method === "PATCH") {
        return Promise.resolve({
          success: true,
          updated: ["watchdog.rules.artifactCleanup.ttlDays"],
          errors: [],
          message: "ok",
        });
      }
      return Promise.resolve(mockConfigResponse);
    });

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByDisplayValue("7")).toBeInTheDocument();
    });

    const ttlInput = screen.getByDisplayValue("7");
    fireEvent.change(ttlInput, { target: { value: "14" } });

    const saveBtn = await screen.findByText(/Save \(\d+\)/);
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const patchCall = mockApi.mock.calls.find(
        ([url, opts]) => url === "/config" && (opts as { method?: string } | undefined)?.method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body["watchdog.rules.artifactCleanup.ttlDays"]).toBe(14);
    });
  });

  it("PATCHes /config with artifactCleanup.enabled=false when disabled via Execution Artifacts field", async () => {
    mockApi.mockImplementation((url: string, options?: { method?: string }) => {
      if (url === "/config/env-diff") return Promise.resolve(mockEnvDiffResponse);
      if (url === "/config/env") return Promise.resolve(mockEnvResponse);
      if (url === "/config" && options?.method === "PATCH") {
        return Promise.resolve({
          success: true,
          updated: ["watchdog.rules.artifactCleanup.enabled"],
          errors: [],
          message: "ok",
        });
      }
      return Promise.resolve(mockConfigResponse);
    });

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText("Template Execution Artifact Cleanup Enabled")).toBeInTheDocument();
    });

    // Scope the lookup to the Template Execution Artifact Cleanup Enabled row
    const label = screen.getByText("Template Execution Artifact Cleanup Enabled");
    const row = label.closest("div.rounded-lg") as HTMLElement;
    expect(row).not.toBeNull();
    const enabledInput = row.querySelector("input") as HTMLInputElement;
    expect(enabledInput).not.toBeNull();
    expect(enabledInput.value).toBe("true");
    fireEvent.change(enabledInput, { target: { value: "false" } });

    const saveBtn = await screen.findByText(/Save \(\d+\)/);
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const patchCall = mockApi.mock.calls.find(
        ([url, opts]) => url === "/config" && (opts as { method?: string } | undefined)?.method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body["watchdog.rules.artifactCleanup.enabled"]).toBe("false");
    });
  });
});
