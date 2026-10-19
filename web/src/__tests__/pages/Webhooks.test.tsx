import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "../utils/test-utils";
import { Webhooks } from "@/pages/Webhooks";

vi.mock("@/lib/api", () => ({
  api: vi.fn(),
}));

import { api } from "@/lib/api";
const mockApi = api as ReturnType<typeof vi.fn>;

const mockWebhookResponse = {
  webhooks: [
    { name: "deploy-prod", displayName: "Deploy Production", description: "Trigger production deployment", tags: ["deploy"], trigger: "webhook" },
    { name: "daily-report", displayName: "Daily Report", description: "Generate daily standup", tags: ["report", "cron"], trigger: "webhook" },
  ],
  auth: "api-key",
};

describe("Webhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.mockResolvedValue(mockWebhookResponse);
  });

  it("renders page title", async () => {
    render(<Webhooks />);
    await waitFor(() => {
      expect(screen.getByText("Webhooks")).toBeInTheDocument();
    });
  });

  it("renders webhook list", async () => {
    render(<Webhooks />);
    await waitFor(() => {
      expect(screen.getByText("Deploy Production")).toBeInTheDocument();
      expect(screen.getByText("Daily Report")).toBeInTheDocument();
    });
  });

  it("shows webhook descriptions", async () => {
    render(<Webhooks />);
    await waitFor(() => {
      expect(screen.getByText("Trigger production deployment")).toBeInTheDocument();
    });
  });

  it("shows auth info", async () => {
    render(<Webhooks />);
    await waitFor(() => {
      expect(screen.getByText("api-key")).toBeInTheDocument();
    });
  });

  it("shows empty state when no webhooks", async () => {
    mockApi.mockResolvedValue({ webhooks: [], auth: "none" });
    render(<Webhooks />);
    await waitFor(() => {
      expect(screen.getByText("No webhooks")).toBeInTheDocument();
    });
  });

  it("shows tags for webhooks", async () => {
    render(<Webhooks />);
    await waitFor(() => {
      expect(screen.getByText("deploy")).toBeInTheDocument();
    });
  });
});
