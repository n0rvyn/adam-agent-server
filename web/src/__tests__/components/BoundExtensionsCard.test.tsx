import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "../utils/test-utils";
import * as apiModule from "@/lib/api";
import { BoundExtensionsCard } from "@/pages/RoleDetail";
import type { RoleExtensionBinding, Extension } from "@/lib/api";

const ROLE_ID = "role-bb94548e";

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
    user_config: {
      transport: { type: "string", default: "localhost", description: "Transport type" },
    },
  }),
  installSource: "upload",
  packageHash: "abc123",
  defaultConfigJson: JSON.stringify({ transport: "localhost" }),
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const mockBinding: RoleExtensionBinding = {
  id: "binding-001",
  extensionId: "ext-001",
  extensionName: "browser-control-mcpb",
  version: "0.1.0",
  toolsCount: 3,
  enabled: true,
  configOverride: null,
  effectiveConfig: { transport: "localhost" },
  generatedServerName: "browser-control-mcpb",
};

function renderCard() {
  return render(<BoundExtensionsCard roleId={ROLE_ID} />);
}

describe("BoundExtensionsCard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders empty state when no bindings", async () => {
    vi.spyOn(apiModule, "listRoleExtensions").mockResolvedValue([]);
    vi.spyOn(apiModule, "listExtensions").mockResolvedValue([]);

    renderCard();
    await waitFor(() => {
      expect(screen.getByText("还没绑任何 extension")).toBeInTheDocument();
    });
    expect(screen.getByText("Role Extensions")).toBeInTheDocument();
  });

  it("renders bindings list with extension name, version, and tools count", async () => {
    vi.spyOn(apiModule, "listRoleExtensions").mockResolvedValue([mockBinding]);
    vi.spyOn(apiModule, "listExtensions").mockResolvedValue([]);

    renderCard();
    await waitFor(() => {
      expect(screen.getByText("browser-control-mcpb")).toBeInTheDocument();
    });
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
    expect(screen.getByText("3 tools")).toBeInTheDocument();
  });

  it("renders HealthBadge ✅ for binding whose extension has last success", async () => {
    const bindingWithHealth: RoleExtensionBinding = {
      ...mockBinding,
      health: { extensionId: "ext-001", lastRunAt: Date.now(), lastStatus: "success", lastError: null, lastRoleId: ROLE_ID, lastTaskId: "task-x" },
    };
    vi.spyOn(apiModule, "listRoleExtensions").mockResolvedValue([bindingWithHealth]);
    vi.spyOn(apiModule, "listExtensions").mockResolvedValue([]);
    renderCard();
    await waitFor(() => expect(screen.getByText("✅")).toBeInTheDocument());
  });

  it("renders HealthBadge ⏳ for binding whose extension has never run", async () => {
    vi.spyOn(apiModule, "listRoleExtensions").mockResolvedValue([mockBinding]);
    vi.spyOn(apiModule, "listExtensions").mockResolvedValue([]);
    renderCard();
    await waitFor(() => expect(screen.getByText("⏳")).toBeInTheDocument());
  });

  it("opens Add panel when Plus button clicked; lists unbound extensions; clicking Bind calls bindRoleExtension", async () => {
    vi.spyOn(apiModule, "listRoleExtensions").mockResolvedValue([]);
    vi.spyOn(apiModule, "listExtensions").mockResolvedValue([mockExtension]);
    const bindSpy = vi
      .spyOn(apiModule, "bindRoleExtension")
      .mockResolvedValue({ ...mockBinding });

    renderCard();
    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByText("还没绑任何 extension")).toBeInTheDocument();
    });

    // Click Plus button
    const plusBtn = screen.getByLabelText("Add extension to role");
    fireEvent.click(plusBtn);

    // Unbound extension should appear in the panel
    await waitFor(() => {
      expect(screen.getByText(/browser-control-mcpb/)).toBeInTheDocument();
    });

    // Click Bind button
    const bindBtn = screen.getByRole("button", { name: "Bind" });
    fireEvent.click(bindBtn);

    await waitFor(() => {
      expect(bindSpy).toHaveBeenCalledWith(ROLE_ID, "browser-control-mcpb");
    });
  });

  it("opens override modal when 覆盖 config clicked; saving with changed field calls patchRoleExtension with sparse override", async () => {
    vi.spyOn(apiModule, "listRoleExtensions").mockResolvedValue([mockBinding]);
    // listExtensions is called in load() and in handleOpenOverride()
    vi.spyOn(apiModule, "listExtensions").mockResolvedValue([mockExtension]);
    const patchSpy = vi
      .spyOn(apiModule, "patchRoleExtension")
      .mockResolvedValue({ ...mockBinding, configOverride: { transport: "native_messaging" } });

    renderCard();
    await waitFor(() => {
      expect(screen.getByText("browser-control-mcpb")).toBeInTheDocument();
    });

    // Click 覆盖 config button
    const overrideBtn = screen.getByRole("button", { name: "覆盖 config" });
    fireEvent.click(overrideBtn);

    // Modal should appear
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Override Config/ })).toBeInTheDocument();
    });

    // The transport input — change it from default "localhost" to "native_messaging"
    const input = screen.getByDisplayValue("localhost");
    fireEvent.change(input, { target: { value: "native_messaging" } });

    // Click save
    const saveBtn = screen.getByRole("button", { name: "保存" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith(
        ROLE_ID,
        "binding-001",
        expect.objectContaining({ configOverride: { transport: "native_messaging" } }),
      );
    });
  });

  it("解绑 button shows confirm; confirming calls unbindRoleExtension", async () => {
    vi.spyOn(apiModule, "listRoleExtensions").mockResolvedValue([mockBinding]);
    vi.spyOn(apiModule, "listExtensions").mockResolvedValue([]);
    const unbindSpy = vi.spyOn(apiModule, "unbindRoleExtension").mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderCard();
    await waitFor(() => {
      expect(screen.getByText("browser-control-mcpb")).toBeInTheDocument();
    });

    const unbindBtn = screen.getByRole("button", { name: "解绑" });
    fireEvent.click(unbindBtn);

    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
      expect(unbindSpy).toHaveBeenCalledWith(ROLE_ID, "binding-001");
    });
  });
});
