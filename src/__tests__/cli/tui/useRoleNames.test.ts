// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// Must hoist factory before vi.mock to avoid TDZ with module-level mockRequest
const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }));
vi.mock("../../../cli/client.js", () => ({
  request: mockRequest,
}));

import { useRoleNames } from "../../../cli/tui/hooks/useRoleNames.js";

describe("useRoleNames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches /roles on mount and provides getName", async () => {
    mockRequest.mockResolvedValueOnce({
      roles: [
        { id: "r1", name: "审慎者" },
        { id: "r2", name: "敏捷者" },
      ],
    });
    const { result } = renderHook(() => useRoleNames());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.getName("r1")).toBe("审慎者");
    expect(result.current.getName("r2")).toBe("敏捷者");
  });

  it("returns '?' for unknown roleId", async () => {
    mockRequest.mockResolvedValueOnce({ roles: [] });
    const { result } = renderHook(() => useRoleNames());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.getName("unknown")).toBe("?");
    expect(result.current.getName(undefined)).toBe("?");
    expect(result.current.getName(null)).toBe("?");
  });

  it("returns '?' on /roles fetch error", async () => {
    mockRequest.mockRejectedValueOnce(new Error("network"));
    const { result } = renderHook(() => useRoleNames());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.getName("r1")).toBe("?");
  });
});
