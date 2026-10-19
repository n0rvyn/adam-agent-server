import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as apiModule from "@/lib/api";
import { Extensions } from "@/pages/Extensions";
import type { Extension, LegacySnapshot } from "@/lib/api";

const mockExtension: Extension = {
  id: "ext-001",
  name: "browser-control-mcpb",
  version: "0.1.0",
  manifestJson: JSON.stringify({
    manifest_version: "0.3",
    name: "browser-control-mcpb",
    version: "0.1.0",
    description: "Controls Chrome browser",
    author: { name: "Test Author" },
    server: { type: "node", mcp_config: { command: "node" } },
  }),
  installSource: "upload",
  packageHash: "abc123",
  defaultConfigJson: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const emptyLegacy: LegacySnapshot = { count: 0, rows: [] };
const legacyWithData: LegacySnapshot = {
  count: 1,
  rows: [{ roleId: "role-1", roleName: "RoleA", mcpServers: { foo: {} } }],
};

function renderExtensions() {
  return render(
    <MemoryRouter>
      <Extensions />
    </MemoryRouter>,
  );
}

describe("Extensions page", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders empty state when no extensions", async () => {
    vi.spyOn(apiModule, "listExtensions").mockResolvedValue([]);
    vi.spyOn(apiModule, "listLegacyMcpServers").mockResolvedValue(emptyLegacy);

    renderExtensions();
    await waitFor(() => {
      expect(screen.getByText("还没装任何 extension")).toBeInTheDocument();
    });
  });

  it("renders extension cards when extensions exist", async () => {
    vi.spyOn(apiModule, "listExtensions").mockResolvedValue([mockExtension]);
    vi.spyOn(apiModule, "listLegacyMcpServers").mockResolvedValue(emptyLegacy);

    renderExtensions();
    await waitFor(() => {
      expect(screen.getByText("browser-control-mcpb")).toBeInTheDocument();
    });
  });

  it("opens upload modal when Import button is clicked", async () => {
    vi.spyOn(apiModule, "listExtensions").mockResolvedValue([]);
    vi.spyOn(apiModule, "listLegacyMcpServers").mockResolvedValue(emptyLegacy);

    renderExtensions();

    // Wait for Import button to appear (header has it; EmptyState action has another)
    const importButtons = await screen.findAllByRole("button", { name: /Import/i });
    expect(importButtons.length).toBeGreaterThanOrEqual(1);

    fireEvent.click(importButtons[0]);

    // Modal renders with "Import Extension" heading (h2 inside <div className="fixed inset-0...">)
    expect(await screen.findByRole("heading", { name: "Import Extension" })).toBeInTheDocument();
  });

  it("renders HealthBadge ✅ for extension with last success", async () => {
    const extWithHealth: Extension = {
      ...mockExtension,
      health: { extensionId: "ext-001", lastRunAt: Date.now(), lastStatus: "success", lastError: null, lastRoleId: "role-1", lastTaskId: "task-1" },
    };
    vi.spyOn(apiModule, "listExtensions").mockResolvedValue([extWithHealth]);
    vi.spyOn(apiModule, "listLegacyMcpServers").mockResolvedValue(emptyLegacy);
    renderExtensions();
    await waitFor(() => expect(screen.getByText("✅")).toBeInTheDocument());
  });

  it("renders HealthBadge ⏳ for extension with no health row (never run)", async () => {
    vi.spyOn(apiModule, "listExtensions").mockResolvedValue([mockExtension]);
    vi.spyOn(apiModule, "listLegacyMcpServers").mockResolvedValue(emptyLegacy);
    renderExtensions();
    await waitFor(() => expect(screen.getByText("⏳")).toBeInTheDocument());
  });

  it("renders legacy banner when legacy count > 0", async () => {
    vi.spyOn(apiModule, "listExtensions").mockResolvedValue([]);
    vi.spyOn(apiModule, "listLegacyMcpServers").mockResolvedValue(legacyWithData);

    renderExtensions();
    await waitFor(() => {
      expect(screen.getByText(/legacy/)).toBeInTheDocument();
    });
  });
});
