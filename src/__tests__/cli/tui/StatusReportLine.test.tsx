// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { StatusReportLine } from "../../../cli/tui/components/StatusReportLine.js";

describe("StatusReportLine", () => {
  it("renders ✓ for completed phase", () => {
    const { lastFrame } = render(<StatusReportLine content="step done" phase="completed" />);
    expect(lastFrame()).toContain("✓");
    expect(lastFrame()).toContain("step done");
  });

  it("renders ✗ for failed phase", () => {
    const { lastFrame } = render(<StatusReportLine content="step failed" phase="failed" />);
    expect(lastFrame()).toContain("✗");
  });

  it("renders ↻ for retrying phase", () => {
    const { lastFrame } = render(<StatusReportLine content="retrying" phase="retrying" />);
    expect(lastFrame()).toContain("↻");
  });

  it("renders ⏸ for blocked phase", () => {
    const { lastFrame } = render(<StatusReportLine content="blocked on auth" phase="blocked" />);
    expect(lastFrame()).toContain("⏸");
  });

  it("renders task short id when provided", () => {
    const { lastFrame } = render(
      <StatusReportLine content="step done" phase="completed" taskShortId="T-2841" />,
    );
    expect(lastFrame()).toContain("[T-2841]");
  });

  it("renders running phase (spinner present, no static glyph)", () => {
    const { lastFrame } = render(<StatusReportLine content="working" phase="running" />);
    // ink-spinner renders rotating chars; just assert content + no static ✓/✗
    expect(lastFrame()).toContain("working");
    expect(lastFrame()).not.toContain("✓");
    expect(lastFrame()).not.toContain("✗");
  });
});
