// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ResultDeliveryBox } from "../../../cli/tui/components/ResultDeliveryBox.js";

describe("ResultDeliveryBox", () => {
  it("renders header with role name and task short id", () => {
    const { lastFrame } = render(
      <ResultDeliveryBox content="result body" roleName="审慎者" taskShortIdLabel="T-2841" />,
    );
    expect(lastFrame()).toContain("审慎者");
    expect(lastFrame()).toContain("T-2841");
    expect(lastFrame()).toContain("result body");
  });

  it("renders attachments with filename, purpose, size, locator", () => {
    const { lastFrame } = render(
      <ResultDeliveryBox
        content="done"
        attachments={[
          { artifactId: "a1", locator: "local:///tmp/r.md", filename: "r.md", mimeType: "text/markdown", size: 2048, purpose: "report" },
        ]}
      />,
    );
    expect(lastFrame()).toContain("[file] r.md");
    expect(lastFrame()).toContain("purpose=report");
    expect(lastFrame()).toContain("2.0 KB");
    expect(lastFrame()).toContain("local:///tmp/r.md");
  });

  it("renders mirror suffix '(also delivered to: ... @ HH:MM)'", () => {
    const ts = new Date("2026-05-07T10:42:00").getTime();
    const { lastFrame } = render(
      <ResultDeliveryBox
        content="done"
        mirroredToTargets={[{ type: "channel", channelId: "wechat" }]}
        createdAt={ts}
      />,
    );
    expect(lastFrame()).toMatch(/also delivered to: wechat @ \d\d:\d\d/);
  });

  it("formats sub-1KB sizes in bytes", () => {
    const { lastFrame } = render(
      <ResultDeliveryBox
        content="done"
        attachments={[
          { artifactId: "a1", locator: "local:///x", filename: "x.txt", mimeType: "text/plain", size: 512 },
        ]}
      />,
    );
    expect(lastFrame()).toContain("512 B");
  });

  it("does not render attachment block when attachments empty", () => {
    const { lastFrame } = render(<ResultDeliveryBox content="done" />);
    expect(lastFrame()).not.toContain("[file]");
  });
});
