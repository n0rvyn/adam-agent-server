// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { SystemNoteLine } from "../../../cli/tui/components/SystemNoteLine.js";

describe("SystemNoteLine", () => {
  it("renders content with bullet prefix", () => {
    const { lastFrame } = render(<SystemNoteLine content="该决策已在 Web 端批准" />);
    expect(lastFrame()).toContain("·");
    expect(lastFrame()).toContain("该决策已在 Web 端批准");
  });
});
