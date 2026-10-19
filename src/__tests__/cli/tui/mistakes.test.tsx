// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { waitForRender, waitForInputReady } from "../../helpers/tui.js";

vi.mock("../../../cli/client.js", () => ({
  request: vi.fn(),
}));

import { request } from "../../../cli/client.js";
import { Mistakes } from "../../../cli/tui/components/Mistakes.js";

const mockRequest = request as ReturnType<typeof vi.fn>;

describe("Mistakes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state on mount", () => {
    mockRequest.mockImplementation(() => new Promise(() => {}));
    const { lastFrame } = render(<Mistakes onBack={vi.fn()} />);
    expect(lastFrame()).toContain("Loading...");
  });

  it("renders N rows after fetch resolves", async () => {
    const patterns = [
      {
        id: "mp-1",
        dimensionType: "event_type",
        dimensionValue: "sandbox_violation /etc/passwd",
        count: 3,
        roleIds: ["role-1", "role-2"],
        sampleEvidenceIds: [],
        status: "new",
        firstSeen: Date.now() - 86400000,
        lastSeen: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "mp-2",
        dimensionType: "score_degradation",
        dimensionValue: "low_ema",
        count: 5,
        roleIds: ["role-1"],
        sampleEvidenceIds: [],
        status: "acknowledged",
        firstSeen: Date.now() - 172800000,
        lastSeen: Date.now() - 3600000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
    mockRequest.mockResolvedValue({ mistakePatterns: patterns });
    const { lastFrame } = render(<Mistakes onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;
    expect(frame).toContain("Mistake Patterns");
    expect(frame).toContain("event_type");
    expect(frame).toContain("score_degradation");
    expect(frame).toContain("2");
  });

  it("pressing r triggers re-fetch", async () => {
    mockRequest.mockResolvedValue({ mistakePatterns: [] });
    const { stdin } = render(<Mistakes onBack={vi.fn()} />);
    await waitForRender();
    vi.clearAllMocks();
    mockRequest.mockResolvedValue({ mistakePatterns: [] });
    await waitForInputReady();
    stdin.write("r");
    await waitForRender();
    expect(mockRequest).toHaveBeenCalled();
  });

  it("pressing a invokes PATCH with status=acknowledged", async () => {
    const patterns = [
      {
        id: "mp-1",
        dimensionType: "event_type",
        dimensionValue: "test pattern",
        count: 1,
        roleIds: ["role-1"],
        sampleEvidenceIds: [],
        status: "new",
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
    // Initial list fetch returns patterns
    mockRequest.mockResolvedValue({ mistakePatterns: patterns });
    const { stdin } = render(<Mistakes onBack={vi.fn()} />);
    await waitForRender();
    // PATCH succeeds → re-fetch returns empty
    mockRequest.mockResolvedValueOnce({ mistakePatterns: patterns });  // list
    mockRequest.mockResolvedValueOnce({ ok: true, id: "mp-1", status: "acknowledged" });  // PATCH
    mockRequest.mockResolvedValue({ mistakePatterns: [] });  // re-fetch
    await waitForInputReady();
    stdin.write("a");
    await waitForRender();
    expect(mockRequest.mock.calls.some(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("/mistake-patterns/mp-1") &&
        (call[1] as { method?: string })?.method === "PATCH",
    )).toBe(true);
  });

  it("pressing 1 filters to status=new", async () => {
    mockRequest.mockResolvedValue({ mistakePatterns: [] });
    const { stdin } = render(<Mistakes onBack={vi.fn()} />);
    await waitForRender();
    vi.clearAllMocks();
    mockRequest.mockResolvedValue({ mistakePatterns: [] });
    await waitForInputReady();
    stdin.write("1");
    await waitForRender();
    expect(mockRequest.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes("status=new"),
    )).toBe(true);
  });
});
