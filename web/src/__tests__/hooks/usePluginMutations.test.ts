import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePluginMutations } from "@/hooks/usePluginMutations";
import { api } from "@/lib/api";
import { toast } from "sonner";

vi.mock("@/lib/api", () => ({
  api: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("usePluginMutations", () => {
  const apiMock = vi.mocked(api);
  const toastSuccess = vi.mocked(toast.success);
  const toastError = vi.mocked(toast.error);

  beforeEach(() => {
    apiMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it("installs a plugin for a role and refreshes", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    apiMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => usePluginMutations(refresh));

    await act(async () => {
      await result.current.installToRole("dev-workflow@indie", "/work/engineer");
    });

    expect(apiMock).toHaveBeenCalledWith(
      "/plugins/install/dev-workflow%40indie",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ scope: "project", cwd: "/work/engineer" }),
      }),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Installed dev-workflow");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("surfaces install failure and still refreshes", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    apiMock.mockRejectedValueOnce(new Error("Install denied"));

    const { result } = renderHook(() => usePluginMutations(refresh));

    await act(async () => {
      await result.current.installToRole("dev-workflow@indie", "/work/engineer");
    });

    expect(toastError).toHaveBeenCalledWith("Install denied");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("uninstalls a role plugin", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    apiMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => usePluginMutations(refresh));

    await act(async () => {
      await result.current.uninstallFromRole("dev-workflow@indie", "/work/engineer");
    });

    expect(apiMock).toHaveBeenCalledWith(
      "/plugins/uninstall/dev-workflow%40indie",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ scope: "project", cwd: "/work/engineer" }),
      }),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Uninstalled from Role");
  });

  it("surfaces uninstall failure", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    apiMock.mockRejectedValueOnce(new Error("Uninstall failed"));

    const { result } = renderHook(() => usePluginMutations(refresh));

    await act(async () => {
      await result.current.uninstallFromRole("dev-workflow@indie", "/work/engineer");
    });

    expect(toastError).toHaveBeenCalledWith("Uninstall failed");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("updates a role plugin to the latest version", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    apiMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => usePluginMutations(refresh));

    await act(async () => {
      await result.current.updateRoleVersion("dev-workflow@indie", "/work/engineer");
    });

    expect(apiMock).toHaveBeenNthCalledWith(
      1,
      "/plugins/uninstall/dev-workflow%40indie",
      expect.objectContaining({
        body: JSON.stringify({ scope: "project", cwd: "/work/engineer" }),
      }),
    );
    expect(apiMock).toHaveBeenNthCalledWith(
      2,
      "/plugins/install/dev-workflow%40indie",
      expect.objectContaining({
        body: JSON.stringify({ scope: "project", cwd: "/work/engineer" }),
      }),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Role updated to latest");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reports partial update failure after uninstall", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    apiMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Install failed"));

    const { result } = renderHook(() => usePluginMutations(refresh));

    await act(async () => {
      await result.current.updateRoleVersion("dev-workflow@indie", "/work/engineer");
    });

    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("reverted to user-scope"),
      expect.objectContaining({ duration: 8000 }),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reports update failure before uninstall completes", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    apiMock.mockRejectedValueOnce(new Error("Cannot uninstall"));

    const { result } = renderHook(() => usePluginMutations(refresh));

    await act(async () => {
      await result.current.updateRoleVersion("dev-workflow@indie", "/work/engineer");
    });

    expect(toastError).toHaveBeenCalledWith("Update failed: Cannot uninstall");
    expect(toastError.mock.calls[0][0]).not.toContain("reverted to user-scope");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
