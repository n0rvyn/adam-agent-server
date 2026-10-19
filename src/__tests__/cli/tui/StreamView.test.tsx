// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import type { StreamEvent } from "../../../cli/tui/components/StreamView.js";
import { StreamView } from "../../../cli/tui/components/StreamView.js";

vi.mock("../../../cli/tui/theme.js", () => ({
  colors: { statusUp: "●", statusDown: "○" },
}));

describe("StreamView", () => {
  it("returns null when no events and not streaming", () => {
    const { lastFrame } = render(<StreamView events={[]} isStreaming={false} />);
    expect(lastFrame()).toBe("");
  });

  it("shows waiting message when streaming with no events", () => {
    const { lastFrame } = render(<StreamView events={[]} isStreaming={true} />);
    expect(lastFrame()).toContain("Waiting for response...");
  });

  it("renders reasoning event", () => {
    const events: StreamEvent[] = [
      { type: "reasoning", content: "Thinking about the problem..." },
    ];
    const { lastFrame } = render(<StreamView events={events} isStreaming={true} />);
    expect(lastFrame()).toContain("Thinking about the problem...");
  });

  it("renders tool_call event with toolName metadata", () => {
    const events: StreamEvent[] = [
      { type: "tool_call", content: "running command", metadata: { toolName: "Bash" } },
    ];
    const { lastFrame } = render(<StreamView events={events} isStreaming={true} />);
    expect(lastFrame()).toContain("[tool] Bash");
  });

  it("renders tool_call event without toolName falls back to content", () => {
    const events: StreamEvent[] = [
      { type: "tool_call", content: "running grep" },
    ];
    const { lastFrame } = render(<StreamView events={events} isStreaming={true} />);
    expect(lastFrame()).toContain("[tool] running grep");
  });

  it("renders tool_result with short content", () => {
    const events: StreamEvent[] = [
      { type: "tool_result", content: "line1\nline2\nline3" },
    ];
    const { lastFrame } = render(<StreamView events={events} isStreaming={true} />);
    expect(lastFrame()).toContain("[result]");
    expect(lastFrame()).toContain("line1");
  });

  it("renders tool_result with long content (foldable)", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const events: StreamEvent[] = [
      { type: "tool_result", content: lines },
    ];
    const { lastFrame } = render(<StreamView events={events} isStreaming={false} />);
    expect(lastFrame()).toContain("(10 lines)");
    expect(lastFrame()).toContain("[Ctrl+O] expand");
  });

  it("renders error event", () => {
    const events: StreamEvent[] = [
      { type: "error", content: "Something went wrong" },
    ];
    const { lastFrame } = render(<StreamView events={events} isStreaming={false} />);
    expect(lastFrame()).toContain("[error] Something went wrong");
  });

  it("renders complete event with content and metadata", () => {
    const events: StreamEvent[] = [
      {
        type: "complete", content: "Task finished",
        metadata: { cost: 0.0123, turns: 5, duration: 12000 },
      },
    ];
    const { lastFrame } = render(<StreamView events={events} isStreaming={false} />);
    const frame = lastFrame()!;
    expect(frame).toContain("Task finished");
    expect(frame).toContain("Task complete");
    expect(frame).toContain("Cost: $0.0123");
    expect(frame).toContain("Turns: 5");
    expect(frame).toContain("Duration: 12.0s");
  });

  it("renders complete event without content", () => {
    const events: StreamEvent[] = [
      { type: "complete", content: "" },
    ];
    const { lastFrame } = render(<StreamView events={events} isStreaming={false} />);
    expect(lastFrame()).toContain("Task complete");
  });

  it("renders complete event without metadata", () => {
    const events: StreamEvent[] = [
      { type: "complete", content: "Done" },
    ];
    const { lastFrame } = render(<StreamView events={events} isStreaming={false} />);
    expect(lastFrame()).not.toContain("Cost:");
    expect(lastFrame()).not.toContain("Turns:");
    expect(lastFrame()).not.toContain("Duration:");
  });

  it("renders multiple events in order", () => {
    const events: StreamEvent[] = [
      { type: "reasoning", content: "Step 1" },
      { type: "tool_call", content: "grep", metadata: { toolName: "Grep" } },
      { type: "tool_result", content: "found it" },
      { type: "complete", content: "All done" },
    ];
    const { lastFrame } = render(<StreamView events={events} isStreaming={false} />);
    const frame = lastFrame()!;
    expect(frame).toContain("Step 1");
    expect(frame).toContain("[tool] Grep");
    expect(frame).toContain("found it");
    expect(frame).toContain("All done");
  });
});
