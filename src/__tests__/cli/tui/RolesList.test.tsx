// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { waitForRender } from "../../helpers/tui.js";

vi.mock("../../../cli/client.js", () => ({
  request: vi.fn(),
}));

import { request } from "../../../cli/client.js";
import { RolesList } from "../../../cli/tui/components/RolesList.js";

const mockRequest = request as ReturnType<typeof vi.fn>;

describe("RolesList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state initially", () => {
    mockRequest.mockImplementation(() => new Promise(() => {}));
    const { lastFrame } = render(<RolesList onBack={vi.fn()} />);
    expect(lastFrame()).toContain("Loading roles");
  });

  it("shows empty state when no roles", async () => {
    mockRequest.mockResolvedValue({ roles: [] });
    const { lastFrame } = render(<RolesList onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("No roles found");
  });

  it("renders role rows with contract compliance indicator", async () => {
    const roles = [
      {
        id: "role-001",
        name: "Engineer",
        status: "active",
        performanceScore: 0.92,
        createdAt: Date.now() - 86_400_000,
        presetId: "engineer-v1",
        contractComplianceEma: 0.873,
      },
      {
        id: "role-002",
        name: "Reviewer",
        status: "active",
        performanceScore: 0.75,
        createdAt: Date.now() - 172_800_000,
        presetId: undefined,
        contractComplianceEma: null,
      },
      {
        id: "role-003",
        name: "Analyst",
        status: "probation",
        createdAt: Date.now() - 259_200_000,
        presetId: undefined,
        contractComplianceEma: undefined,
      },
    ];
    mockRequest.mockResolvedValue({ roles });
    const { lastFrame } = render(<RolesList onBack={vi.fn()} />);
    await waitForRender();
    const frame = lastFrame()!;

    // Engineer: shows contract compliance EMA
    expect(frame).toContain("Engineer");
    expect(frame).toContain("[契约 0.87]");

    // Reviewer: shows em-dash when null
    expect(frame).toContain("Reviewer");
    expect(frame).toContain("[契约 —]");

    // Analyst: shows em-dash when undefined (no data)
    expect(frame).toContain("Analyst");
    expect(frame).toContain("[契约 —]");

    // Status displayed
    expect(frame).toContain("active");
    expect(frame).toContain("probation");
  });

  it("renders em-dash when contractComplianceEma is null", async () => {
    const roles = [
      {
        id: "role-new",
        name: "NewRole",
        status: "active",
        createdAt: Date.now(),
        contractComplianceEma: null,
      },
    ];
    mockRequest.mockResolvedValue({ roles });
    const { lastFrame } = render(<RolesList onBack={vi.fn()} />);
    await waitForRender();
    expect(lastFrame()).toContain("[契约 —]");
  });
});
