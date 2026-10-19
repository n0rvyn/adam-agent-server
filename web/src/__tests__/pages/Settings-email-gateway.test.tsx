import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "../utils/test-utils";
import { Settings } from "@/pages/Settings";

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

interface EmailGatewayTestResult {
  ok: boolean;
  stage: "imap" | "smtp" | "roundtrip";
  code?: string;
  message: string;
}

const emailEntries = {
  "emailGateway.enabled": { value: false, mutable: true },
  "emailGateway.address": { value: "adam@example.com", mutable: true },
  "emailGateway.displayName": { value: "Adam", mutable: true },
  "emailGateway.imap.host": { value: "imap.example.com", mutable: true },
  "emailGateway.imap.port": { value: 993, mutable: true },
  "emailGateway.imap.secure": { value: true, mutable: true },
  "emailGateway.imap.auth.user": { value: "adam@example.com", mutable: true },
  "emailGateway.imap.auth.pass": { value: "imap-****", mutable: true },
  "emailGateway.imap.mailbox": { value: "INBOX", mutable: true },
  "emailGateway.smtp.host": { value: "smtp.example.com", mutable: true },
  "emailGateway.smtp.port": { value: 465, mutable: true },
  "emailGateway.smtp.secure": { value: true, mutable: true },
  "emailGateway.smtp.auth.user": { value: "adam@example.com", mutable: true },
  "emailGateway.smtp.auth.pass": { value: "smtp-****", mutable: true },
  "emailGateway.smtp.from": { value: "adam@example.com", mutable: true },
  "emailGateway.subjectPrefix": { value: "Adam", mutable: true },
};

const mockConfigResponse = {
  config: {
    ...emailEntries,
    "anthropic.apiKey": { value: "", mutable: true },
    "anthropic.baseUrl": { value: "", mutable: true },
    "anthropic.model": { value: "", mutable: true },
    "anthropic.defaultOpusModel": { value: "", mutable: true },
    "anthropic.defaultSonnetModel": { value: "", mutable: true },
    "anthropic.defaultHaikuModel": { value: "", mutable: true },
    "anthropic.smallFastModel": { value: "", mutable: true },
    "defaults.model": { value: "", mutable: true },
    "defaults.effort": { value: "high", mutable: true },
    "defaults.maxTurns": { value: 100, mutable: true },
    "defaults.maxBudgetUsd": { value: 5, mutable: true },
    "defaults.timeout": { value: 600, mutable: true },
    "defaults.approvalTimeout": { value: 600, mutable: true },
    "server.port": { value: 7100, mutable: false },
    "server.host": { value: "0.0.0.0", mutable: false },
    "server.timezone": { value: "system", mutable: true },
    "logging.level": { value: "info", mutable: true },
    "roles.evolution.triggerEvery": { value: 5, mutable: true },
    "roles.evolution.reflectionThreshold": { value: 150, mutable: true },
    "chat.sessionTimeoutMinutes": { value: 30, mutable: true },
    "chat.maxSessionTurns": { value: 20, mutable: true },
    "chat.autoTitle": { value: true, mutable: true },
    "chat.archiveExtractMemory": { value: true, mutable: true },
    "watchdog.rules.artifactCleanup.enabled": { value: true, mutable: true },
    "watchdog.rules.artifactCleanup.ttlDays": { value: 7, mutable: true },
    "watchdog.rules.artifactCleanup.orphanGcMinAgeHours": { value: 1, mutable: true },
  },
  mutable: [
    ...Object.keys(emailEntries),
    "anthropic.apiKey", "anthropic.baseUrl", "anthropic.model",
    "anthropic.defaultOpusModel", "anthropic.defaultSonnetModel",
    "anthropic.defaultHaikuModel", "anthropic.smallFastModel",
    "defaults.model", "defaults.effort", "defaults.maxTurns",
    "defaults.maxBudgetUsd", "defaults.timeout", "defaults.approvalTimeout",
    "server.timezone", "logging.level",
    "roles.evolution.triggerEvery", "roles.evolution.reflectionThreshold",
    "chat.sessionTimeoutMinutes", "chat.maxSessionTurns", "chat.autoTitle", "chat.archiveExtractMemory",
    "watchdog.rules.artifactCleanup.enabled", "watchdog.rules.artifactCleanup.ttlDays",
    "watchdog.rules.artifactCleanup.orphanGcMinAgeHours",
  ],
  restartRequired: ["server.port", "server.host"],
};

describe("Settings Email Gateway", () => {
  let statusCalls = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    statusCalls = 0;
    mockApi.mockImplementation((url: string, options?: { method?: string }) => {
      if (url === "/config/env-diff") return Promise.resolve({ diffs: [], envFileExists: false });
      if (url === "/config/env") return Promise.resolve({ env: {} });
      if (url === "/config/email-gateway/status") {
        statusCalls += 1;
        return Promise.resolve({
          enabled: statusCalls > 1,
          configured: true,
          lastStatus: statusCalls > 1 ? "degraded" : "stopped",
          lastCheckedAt: statusCalls > 1 ? 1_777_500_000_000 : null,
          lastError: statusCalls > 1 ? "Mailbox unavailable" : null,
        });
      }
      if (url === "/config" && options?.method === "PATCH") {
        return Promise.resolve({ success: true, updated: ["emailGateway.address"], errors: [], message: "ok" });
      }
      if (url === "/config/email-gateway/test-imap") {
        return Promise.resolve({ ok: true, stage: "imap", code: "ok", message: "IMAP connection succeeded" });
      }
      if (url === "/config/email-gateway/test-smtp") {
        return Promise.resolve({ ok: true, stage: "smtp", code: "ok", message: "SMTP connection succeeded" });
      }
      if (url === "/config/email-gateway/test-roundtrip") {
        return Promise.resolve({
          ok: true,
          stage: "roundtrip",
          code: "ok",
          message: "Roundtrip probe succeeded",
          details: { smtpPassword: "smtp-secret", imapPassword: "imap-secret" },
        });
      }
      return Promise.resolve(mockConfigResponse);
    });
  });

  it("renders Email Gateway fields and test actions", async () => {
    render(<Settings />);

    await waitFor(() => {
      expect(screen.getByText("Email Gateway")).toBeInTheDocument();
      expect(screen.getByText("Central Email Address")).toBeInTheDocument();
      expect(screen.getByLabelText("Central Email Address")).toHaveValue("adam@example.com");
      expect(screen.getByText("Test IMAP")).toBeInTheDocument();
      expect(screen.getByText("Test SMTP")).toBeInTheDocument();
      expect(screen.getByText("Send test email")).toBeInTheDocument();
      expect(screen.getByText("Runtime status")).toBeInTheDocument();
      expect(screen.getByText("disabled")).toBeInTheDocument();
      expect(screen.getByText("Last test")).toBeInTheDocument();
      expect(screen.getByText("Not checked")).toBeInTheDocument();
      expect(screen.getByText("Last checked")).toBeInTheDocument();
      expect(screen.getByText("Never")).toBeInTheDocument();
      expect(screen.getByText("Last error")).toBeInTheDocument();
      expect(screen.getByText("None")).toBeInTheDocument();
    });

    expect(document.body.textContent).not.toContain("imap-secret");
    expect(document.body.textContent).not.toContain("smtp-secret");
  });

  it("saves Email Gateway config through generic Settings save", async () => {
    render(<Settings />);
    await screen.findByLabelText("Central Email Address");

    fireEvent.change(screen.getByLabelText("Central Email Address"), { target: { value: "ops@example.com" } });
    fireEvent.click(await screen.findByText(/Save \(\d+\)/));

    await waitFor(() => {
      const patchCall = mockApi.mock.calls.find(
        ([url, opts]) => url === "/config" && (opts as { method?: string } | undefined)?.method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      expect(JSON.parse((patchCall![1] as { body: string }).body)["emailGateway.address"]).toBe("ops@example.com");
      expect(statusCalls).toBeGreaterThanOrEqual(2);
      expect(screen.getByText("degraded")).toBeInTheDocument();
      expect(screen.getByText("Mailbox unavailable")).toBeInTheDocument();
    });
  });

  it("runs IMAP, SMTP, and roundtrip tests", async () => {
    render(<Settings />);
    await screen.findByText("Test IMAP");

    fireEvent.click(screen.getByText("Test IMAP"));
    await screen.findByText(/IMAP connection succeeded/);

    fireEvent.click(screen.getByText("Test SMTP"));
    await screen.findByText(/SMTP connection succeeded/);

    fireEvent.click(screen.getByText("Send test email"));
    await screen.findByText(/Roundtrip probe succeeded/);
    expect(screen.getByText(/roundtrip ok:/)).toBeInTheDocument();
    expect(screen.getByText("Last error").parentElement?.textContent).toContain("None");
    expect(document.body.textContent).not.toContain("imap-secret");
    expect(document.body.textContent).not.toContain("smtp-secret");
  });

  it("shows loading labels while Email Gateway tests are running", async () => {
    let resolveRoundtrip: (value: EmailGatewayTestResult) => void = () => {};
    mockApi.mockImplementation((url: string) => {
      if (url === "/config/env-diff") return Promise.resolve({ diffs: [], envFileExists: false });
      if (url === "/config/env") return Promise.resolve({ env: {} });
      if (url === "/config/email-gateway/status") {
        return Promise.resolve({ enabled: true, configured: true, lastStatus: "connected", lastCheckedAt: null, lastError: null });
      }
      if (url === "/config/email-gateway/test-roundtrip") {
        return new Promise((resolve) => {
          resolveRoundtrip = resolve as (value: EmailGatewayTestResult) => void;
        });
      }
      return Promise.resolve(mockConfigResponse);
    });

    render(<Settings />);
    await screen.findByText("Send test email");

    fireEvent.click(screen.getByText("Send test email"));
    expect(await screen.findByText("Sending probe...")).toBeInTheDocument();
    resolveRoundtrip({ ok: true, stage: "roundtrip", code: "ok", message: "Roundtrip probe succeeded" });
    await screen.findByText(/Roundtrip probe succeeded/);
  });
});
