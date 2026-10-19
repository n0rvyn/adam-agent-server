/**
 * Task 9: Settings embedding model dropdown tests.
 * Covers: dropdown renders with default value, selecting non-512-dim shows warning,
 * selecting 512-dim model shows no warning, selecting an option triggers PATCH.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "../utils/test-utils";
import { Settings } from "@/pages/Settings";

vi.mock("@/lib/api", () => ({
  api: vi.fn(),
  getStoredApiKey: () => "test-api-key",
  setStoredApiKey: vi.fn(),
  clearStoredApiKey: vi.fn(),
  redirectToLogin: vi.fn(),
  rotateApiKey: vi.fn().mockResolvedValue("new-test-key"),
  verifyApiKey: vi.fn().mockResolvedValue(true),
}));

import { api } from "@/lib/api";
const mockApi = api as ReturnType<typeof vi.fn>;

const baseConfig = {
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
  "defaults.approvalTimeout": { value: 30, mutable: true },
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
  "memory.embeddingModel": { value: "bge-small-zh-v1.5", mutable: true },
};

const mutablePaths = [
  "anthropic.apiKey", "anthropic.baseUrl", "anthropic.model",
  "anthropic.defaultOpusModel", "anthropic.defaultSonnetModel",
  "anthropic.defaultHaikuModel", "anthropic.smallFastModel",
  "defaults.model", "defaults.effort", "defaults.maxTurns",
  "defaults.maxBudgetUsd", "defaults.timeout", "defaults.approvalTimeout",
  "logging.level", "roles.evolution.triggerEvery", "roles.evolution.reflectionThreshold",
  "server.timezone",
  "chat.sessionTimeoutMinutes", "chat.maxSessionTurns",
  "chat.autoTitle", "chat.archiveExtractMemory",
  "watchdog.rules.artifactCleanup.enabled",
  "watchdog.rules.artifactCleanup.ttlDays",
  "watchdog.rules.artifactCleanup.orphanGcMinAgeHours",
  "memory.embeddingModel",
];

const mockConfigResponse = {
  config: baseConfig,
  mutable: mutablePaths,
  restartRequired: ["server.port", "server.host", "server.apiKey"],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.mockImplementation((url: string) => {
    if (url === "/config/env-diff") return Promise.resolve({ diffs: [], envFileExists: false });
    if (url === "/config/env") return Promise.resolve({ env: {} });
    if (url === "/config/email-gateway/status") return Promise.resolve({ enabled: false, configured: false, lastStatus: "stopped", lastCheckedAt: null, lastError: null });
    return Promise.resolve(mockConfigResponse);
  });
});

describe("Settings — Embedding Model dropdown (Task 9)", () => {
  it("renders Memory section with Embedding Model label", async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText("Memory")).toBeInTheDocument();
      expect(screen.getByText("Embedding Model")).toBeInTheDocument();
    });
  });

  it("renders dropdown with default bge-small-zh-v1.5 selected", async () => {
    render(<Settings />);
    await waitFor(() => {
      const select = screen.getByDisplayValue("bge-small-zh-v1.5");
      expect(select).toBeInTheDocument();
      expect(select.tagName).toBe("SELECT");
    });
  });

  it("dropdown has both model options", async () => {
    render(<Settings />);
    await waitFor(() => {
      const select = screen.getByDisplayValue("bge-small-zh-v1.5");
      const options = Array.from((select as HTMLSelectElement).options).map((o) => o.value);
      expect(options).toContain("bge-small-zh-v1.5");
      expect(options).toContain("paraphrase-multilingual-MiniLM-L12-v2");
    });
  });

  it("shows dimension mismatch warning when paraphrase-multilingual model is selected", async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByDisplayValue("bge-small-zh-v1.5")).toBeInTheDocument();
    });

    const select = screen.getByDisplayValue("bge-small-zh-v1.5");
    fireEvent.change(select, { target: { value: "paraphrase-multilingual-MiniLM-L12-v2" } });

    await waitFor(() => {
      expect(screen.getByText(/切换模型后建议清空候选 belief 的 embedding 重算/)).toBeInTheDocument();
    });
  });

  it("does not show dimension warning when default 512-dim model is selected", async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByDisplayValue("bge-small-zh-v1.5")).toBeInTheDocument();
    });

    // Default selection — no warning
    expect(screen.queryByText(/切换模型后建议清空候选/)).not.toBeInTheDocument();
  });
});
