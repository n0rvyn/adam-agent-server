// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { simulateKey, waitForInputReady, waitForRender } from "../../helpers/tui.js";

vi.mock("../../../cli/client.js", () => ({
  request: vi.fn(),
}));

import { request } from "../../../cli/client.js";
import { ApprovalSelect } from "../../../cli/tui/components/ApprovalSelect.js";

const mockRequest = request as ReturnType<typeof vi.fn>;

describe("ApprovalSelect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders prompt id and content", () => {
    const { lastFrame } = render(
      <ApprovalSelect promptId="A2K7" content="Approve git push?" shape="yes_no" />,
    );
    expect(lastFrame()).toContain("A2K7");
    expect(lastFrame()).toContain("Approve git push?");
  });

  it("renders 批准 / 拒绝 items for yes_no shape", () => {
    const { lastFrame } = render(
      <ApprovalSelect promptId="A2K7" content="?" shape="yes_no" />,
    );
    expect(lastFrame()).toContain("批准");
    expect(lastFrame()).toContain("拒绝");
  });

  it("renders provided choices for choose_one shape", () => {
    const { lastFrame } = render(
      <ApprovalSelect promptId="B3M4" content="?" shape="choose_one" choices={["选项A", "选项B", "选项C"]} />,
    );
    expect(lastFrame()).toContain("选项A");
    expect(lastFrame()).toContain("选项B");
    expect(lastFrame()).toContain("选项C");
  });

  it("renders free-input fallback hint for free_input shape", () => {
    const { lastFrame } = render(
      <ApprovalSelect promptId="C5N6" content="?" shape="free_input" />,
    );
    expect(lastFrame()).toContain("Free-input");
    expect(lastFrame()).toContain("C5N6");
  });

  it("posts to /chat/messages with buttonPayload on selection (Enter)", async () => {
    mockRequest.mockResolvedValue({});
    const onSubmitted = vi.fn();
    const { stdin } = render(
      <ApprovalSelect promptId="A2K7" content="?" shape="yes_no" onSubmitted={onSubmitted} />,
    );
    await waitForInputReady();
    simulateKey(stdin, "return"); // select first item (批准)
    await waitForRender();
    expect(mockRequest).toHaveBeenCalledWith(
      "/chat/messages",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          content: "批准",
          source: { type: "tui" },
          buttonPayload: { promptId: "A2K7", value: "批准" },
        }),
      }),
    );
    expect(onSubmitted).toHaveBeenCalledWith("批准");
  });

  it("calls onSubmitFailure callback when POST throws", async () => {
    mockRequest.mockRejectedValueOnce(new Error("network"));
    const onFail = vi.fn();
    const { stdin } = render(
      <ApprovalSelect promptId="A2K7" content="?" shape="yes_no" onSubmitFailure={onFail} />,
    );
    await waitForInputReady();
    simulateKey(stdin, "return");
    await waitForRender();
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it("shows recovery hint with token format on POST failure", async () => {
    mockRequest.mockRejectedValueOnce(new Error("network"));
    const { stdin, lastFrame } = render(
      <ApprovalSelect promptId="A2K7" content="?" shape="yes_no" />,
    );
    await waitForInputReady();
    simulateKey(stdin, "return");
    await waitForRender();
    const frame = lastFrame()!;
    expect(frame).toContain("#A2K7");
    expect(frame).toContain("批准");
  });
});
