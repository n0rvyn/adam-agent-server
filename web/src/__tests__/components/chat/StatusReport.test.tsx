import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StatusReportLine, StatusReportGroup } from "@/components/chat/StatusReport.tsx";
import type { ChatMessageInfo } from "@/store/useChatStore.ts";

const makeMsg = (id: string, content: string, createdAt = Date.now()): ChatMessageInfo => ({
  id,
  sessionId: "sess-1",
  role: "assistant",
  content,
  source: { type: "web" },
  createdAt,
  kind: "status_report",
});

describe("StatusReportLine", () => {
  it("renders content and applies dedicated class", () => {
    render(<StatusReportLine message={makeMsg("m1", "Task started")} />);
    expect(screen.getByTestId("status-report-line")).toBeInTheDocument();
    expect(screen.getByText("Task started")).toBeInTheDocument();
    expect(screen.getByTestId("status-report-line")).toHaveClass("chat-status-report");
  });
});

describe("StatusReportGroup", () => {
  it("renders collapsed button with count", () => {
    const msgs = [
      makeMsg("m1", "step 1"),
      makeMsg("m2", "step 2"),
      makeMsg("m3", "step 3"),
      makeMsg("m4", "step 4"),
      makeMsg("m5", "step 5"),
    ];
    render(<StatusReportGroup messages={msgs} />);
    expect(screen.getByTestId("status-report-group")).toBeInTheDocument();
    expect(screen.getByText("5 步进展")).toBeInTheDocument();
    // Lines should not be visible yet
    expect(screen.queryByText("step 1")).not.toBeInTheDocument();
  });

  it("expands on button click and shows all lines", () => {
    const msgs = [
      makeMsg("m1", "step 1"),
      makeMsg("m2", "step 2"),
      makeMsg("m3", "step 3"),
      makeMsg("m4", "step 4"),
      makeMsg("m5", "step 5"),
    ];
    render(<StatusReportGroup messages={msgs} />);
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    expect(screen.getByText("step 1")).toBeInTheDocument();
    expect(screen.getByText("step 5")).toBeInTheDocument();
    expect(screen.getAllByTestId("status-report-line")).toHaveLength(5);
  });

  it("collapses again on second click", () => {
    const msgs = [makeMsg("m1", "step 1"), makeMsg("m2", "step 2"), makeMsg("m3", "step 3")];
    render(<StatusReportGroup messages={msgs} />);
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    expect(screen.getByText("step 1")).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByText("step 1")).not.toBeInTheDocument();
  });

  it("aria-expanded toggles correctly", () => {
    const msgs = [makeMsg("m1", "step 1"), makeMsg("m2", "step 2"), makeMsg("m3", "step 3")];
    render(<StatusReportGroup messages={msgs} />);
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });
});
