import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import * as apiModule from "@/lib/api";
import { ExtensionDetail } from "@/pages/ExtensionDetail";
import type { Extension } from "@/lib/api";

const mockExtension: Extension = {
  id: "ext-001",
  name: "minimax-search",
  version: "1.0.0",
  manifestJson: JSON.stringify({
    manifest_version: "0.3",
    name: "minimax-search",
    version: "1.0.0",
    description: "MiniMax search integration",
    author: { name: "Test Author" },
    server: { type: "node", mcp_config: { command: "node" } },
    tools: [
      { name: "search", description: "Search the web" },
    ],
    user_config: {
      api_key: {
        type: "string",
        title: "API Key",
        description: "Your MiniMax API key",
        sensitive: true,
      },
      region: {
        type: "string",
        title: "Region",
        description: "Server region",
        sensitive: false,
        default: "us-east",
      },
    },
  }),
  installSource: "upload",
  packageHash: "def456",
  defaultConfigJson: JSON.stringify({ region: "eu-west" }),
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function renderExtensionDetail(name = "minimax-search") {
  return render(
    <MemoryRouter initialEntries={[`/extensions/${name}`]}>
      <Routes>
        <Route path="/extensions/:name" element={<ExtensionDetail />} />
        <Route path="/extensions" element={<div>Extensions list</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ExtensionDetail page", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders manifest fields", async () => {
    vi.spyOn(apiModule, "getExtension").mockResolvedValue(mockExtension);

    renderExtensionDetail();
    await waitFor(() => {
      expect(screen.getByText("MiniMax search integration")).toBeInTheDocument();
    });
    expect(screen.getByText("search")).toBeInTheDocument();
  });

  it("renders password input for sensitive user_config fields", async () => {
    vi.spyOn(apiModule, "getExtension").mockResolvedValue(mockExtension);

    renderExtensionDetail();
    await waitFor(() => {
      expect(screen.getByText("API Key")).toBeInTheDocument();
    });

    const passwordInputs = document.querySelectorAll('input[type="password"]');
    expect(passwordInputs.length).toBeGreaterThanOrEqual(1);
  });

  it("renders uninstall button", async () => {
    vi.spyOn(apiModule, "getExtension").mockResolvedValue(mockExtension);

    renderExtensionDetail();
    await waitFor(() => {
      expect(screen.getByText("卸载")).toBeInTheDocument();
    });
  });

  it("navigates back to extensions list after successful uninstall", async () => {
    vi.spyOn(apiModule, "getExtension").mockResolvedValue(mockExtension);
    vi.spyOn(apiModule, "deleteExtension").mockResolvedValue(undefined);

    renderExtensionDetail();
    await waitFor(() => {
      expect(screen.getByText("卸载")).toBeInTheDocument();
    });

    // Click uninstall → confirm dialog appears (fireEvent wraps in act)
    fireEvent.click(screen.getByText("卸载").closest("button")!);
    await waitFor(() => {
      expect(screen.getByText("Uninstall extension?")).toBeInTheDocument();
    });

    // Confirm
    const confirmBtn = screen.getAllByText("Uninstall").find((el) => el.tagName === "BUTTON");
    if (confirmBtn) fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByText("Extensions list")).toBeInTheDocument();
    });
  });
});
