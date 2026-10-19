// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { waitForInputReady, waitForRender, createMockApproval } from "../../helpers/tui.js";

vi.mock("../../../cli/client.js", () => ({
  request: vi.fn(),
}));

import { request } from "../../../cli/client.js";
import { ApprovalBanner } from "../../../cli/tui/components/ApprovalBanner.js";

const mockRequest = request as ReturnType<typeof vi.fn>;

describe("ApprovalBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders approval details", () => {
    const approval = createMockApproval({ toolName: "Bash", toolInput: { command: "rm -rf" } });
    const { lastFrame } = render(<ApprovalBanner approval={approval} onResolved={vi.fn()} />);
    const frame = lastFrame()!;
    expect(frame).toContain("APPROVAL REQUIRED");
    expect(frame).toContain("Bash");
    expect(frame).toContain("rm -rf");
    expect(frame).toContain("[a] Approve");
    expect(frame).toContain("[r] Reject");
  });

  it("shows matched pattern", () => {
    const approval = createMockApproval({ matchedPattern: "rm .*" });
    const { lastFrame } = render(<ApprovalBanner approval={approval} onResolved={vi.fn()} />);
    expect(lastFrame()).toContain("rm .*");
  });

  it("calls approve endpoint and onResolved when 'a' pressed", async () => {
    mockRequest.mockResolvedValue({});
    const onResolved = vi.fn();
    const approval = createMockApproval();
    const { stdin } = render(<ApprovalBanner approval={approval} onResolved={onResolved} />);
    await waitForInputReady();
    stdin.write("a");
    await waitForRender();
    expect(mockRequest).toHaveBeenCalledWith(
      `/tasks/${approval.taskId}/approve`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(onResolved).toHaveBeenCalled();
  });

  it("calls reject endpoint and onResolved when 'r' pressed", async () => {
    mockRequest.mockResolvedValue({});
    const onResolved = vi.fn();
    const approval = createMockApproval();
    const { stdin } = render(<ApprovalBanner approval={approval} onResolved={onResolved} />);
    await waitForInputReady();
    stdin.write("r");
    await waitForRender();
    expect(mockRequest).toHaveBeenCalledWith(
      `/tasks/${approval.taskId}/reject`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(onResolved).toHaveBeenCalled();
  });

  it("calls onResolved even when approve request fails", async () => {
    mockRequest.mockRejectedValue(new Error("fail"));
    const onResolved = vi.fn();
    const approval = createMockApproval();
    const { stdin } = render(<ApprovalBanner approval={approval} onResolved={onResolved} />);
    await waitForInputReady();
    stdin.write("a");
    await waitForRender();
    expect(onResolved).toHaveBeenCalled();
  });

  it("calls onResolved even when reject request fails", async () => {
    mockRequest.mockRejectedValue(new Error("fail"));
    const onResolved = vi.fn();
    const approval = createMockApproval();
    const { stdin } = render(<ApprovalBanner approval={approval} onResolved={onResolved} />);
    await waitForInputReady();
    stdin.write("r");
    await waitForRender();
    expect(onResolved).toHaveBeenCalled();
  });
});
